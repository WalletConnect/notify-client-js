import { formatJsonRpcRequest } from "@walletconnect/jsonrpc-utils";
import { expect, describe, it, beforeEach, afterEach } from "vitest";
import cloneDeep from "lodash.clonedeep";
import {
  DappClient,
  WalletClient,
  IDappClient,
  IWalletClient,
  SDK_ERRORS,
  PushClientTypes,
} from "../src/";
import { disconnectSocket } from "./helpers/ws";
import {
  gmDappMetadata,
  mockAccount,
  mockIdentityMethods,
  onSignMock,
} from "./helpers/mocks";
import {
  createPushSubscription,
  sendPushMessage,
  setupKnownPairing,
} from "./helpers/push";
import { waitForEvent } from "./helpers/async";
import { Core, RELAYER_DEFAULT_PROTOCOL } from "@walletconnect/core";
import { ISyncClient, SyncClient, SyncStore } from "@walletconnect/sync-client";
import { Wallet } from "@ethersproject/wallet";

const DEFAULT_RELAY_URL = "wss://relay.walletconnect.com";
const DEFAULT_CAST_URL = "https://cast.walletconnect.com";

if (!process.env.TEST_PROJECT_ID) {
  throw new ReferenceError("TEST_PROJECT_ID env variable not set");
}

const projectId = process.env.TEST_PROJECT_ID;

describe("Push", () => {
  let dapp: IDappClient;
  let wallet: IWalletClient;
  let syncClient: ISyncClient;

  beforeEach(async () => {
    const core = new Core({
      projectId,
    });

    syncClient = await SyncClient.init({
      core,
      projectId,
    });

    dapp = await DappClient.init({
      name: "testDappClient",
      logger: "error",
      relayUrl: process.env.TEST_RELAY_URL || DEFAULT_RELAY_URL,
      castUrl: process.env.TEST_CAST_URL || DEFAULT_CAST_URL,
      projectId,
      metadata: gmDappMetadata,
    });
    wallet = await WalletClient.init({
      name: "testWalletClient",
      logger: "error",
      relayUrl: process.env.TEST_RELAY_URL || DEFAULT_RELAY_URL,
      core,
      syncClient,
      SyncStoreController: SyncStore,
      projectId,
    });

    // Mocking identity key methods.
    mockIdentityMethods(wallet);
  });
  afterEach(async () => {
    await disconnectSocket(dapp.core);
    await disconnectSocket(wallet.core);
  });

  describe("DappClient", () => {
    it("can be instantiated", () => {
      expect(dapp instanceof DappClient).toBe(true);
      expect(dapp.core).toBeDefined();
      expect(dapp.events).toBeDefined();
      expect(dapp.logger).toBeDefined();
      expect(dapp.subscriptions).toBeDefined();
      expect(dapp.core.expirer).toBeDefined();
      expect(dapp.core.history).toBeDefined();
      expect(dapp.core.pairing).toBeDefined();
    });

    describe("propose", () => {
      it("can propose a push subscription on a known pairing topic", async () => {
        // Set up known pairing.
        const pairingTopic = await setupKnownPairing(dapp, wallet);
        let gotPushPropose = false;
        let pushProposeEvent: any;

        wallet.once("push_proposal", (event) => {
          gotPushPropose = true;
          pushProposeEvent = event;
        });

        const { id } = await dapp.propose({
          account: mockAccount,
          pairingTopic,
        });

        await waitForEvent(() => gotPushPropose);

        expect(pushProposeEvent.params.metadata).to.deep.equal(gmDappMetadata);

        // Check that wallet is in expected state.
        expect(wallet.proposals.get(id)).toBeDefined();
        expect(wallet.core.expirer.has(id)).toBe(true);
        // Check that dapp is in expected state.
        expect(dapp.proposals.get(id)).toBeDefined();
        expect(dapp.core.expirer.has(id)).toBe(true);
      });
    });

    describe("deleteSubscription", () => {
      it("can delete a currently active push subscription", async () => {
        const { responseEvent } = await createPushSubscription(dapp, wallet);
        let gotPushDeleteEvent = false;
        let pushDeleteEvent: any;

        expect(responseEvent.params.subscription.topic).toBeDefined();

        expect(Object.keys(wallet.getActiveSubscriptions()).length).toBe(1);

        const walletSubscriptionTopic = Object.keys(
          wallet.getActiveSubscriptions()
        )[0];

        wallet.once("push_delete", (event) => {
          gotPushDeleteEvent = true;
          pushDeleteEvent = event;
        });

        await dapp.deleteSubscription({ topic: walletSubscriptionTopic });
        await waitForEvent(() => gotPushDeleteEvent);

        expect(pushDeleteEvent.topic).toBe(walletSubscriptionTopic);
        // Check that wallet is in expected state.
        expect(Object.keys(wallet.getActiveSubscriptions()).length).toBe(0);
        expect(wallet.messages.keys.length).toBe(0);
        // Check that dapp is in expected state.
        expect(Object.keys(dapp.getActiveSubscriptions()).length).toBe(0);
      });
    });
  });

  describe("WalletClient", () => {
    it("can be instantiated", () => {
      expect(wallet instanceof WalletClient).toBe(true);
      expect(wallet.core).toBeDefined();
      expect(wallet.events).toBeDefined();
      expect(wallet.logger).toBeDefined();
      expect(wallet.requests).toBeDefined();
      expect(wallet.subscriptions).toBeDefined();
      expect(wallet.core.expirer).toBeDefined();
      expect(wallet.core.history).toBeDefined();
      expect(wallet.core.pairing).toBeDefined();
    });

    describe("approve", () => {
      it("can approve a previously received proposal on a known pairing topic", async () => {
        const pairingTopic = await setupKnownPairing(wallet, dapp);
        let gotPushPropose = false;
        let pushProposeEvent: any;

        let gotResponse = false;
        let responseEvent: any;

        wallet.once("push_proposal", (event) => {
          gotPushPropose = true;
          pushProposeEvent = event;
        });

        const { id } = await dapp.propose({
          account: mockAccount,
          pairingTopic,
        });

        await waitForEvent(() => gotPushPropose);

        dapp.once("push_response", (event) => {
          gotResponse = true;
          responseEvent = event;
        });

        await wallet.approve({ id, onSign: onSignMock });
        await waitForEvent(() => gotResponse);

        expect(responseEvent.params.subscription.topic).toBeDefined();

        // Check that wallet is in expected state.
        expect(wallet.subscriptions.length).toBe(1);
        expect(wallet.messages.length).toBe(1);
        expect(wallet.proposals.length).toBe(0);

        // Check that dapp is in expected state.
        expect(dapp.subscriptions.length).toBe(1);
        expect(dapp.proposals.length).toBe(0);
      });
    });

    describe("reject", () => {
      it("can reject a previously received `push_request` on a known pairing topic", async () => {
        const rejectionReason = "this is a rejection reason";
        const pairingTopic = await setupKnownPairing(wallet, dapp);
        let gotPushProposal = false;
        let pushProposeEvent: any;
        let gotResponse = false;
        let responseEvent: any;

        wallet.once("push_proposal", (event) => {
          gotPushProposal = true;
          pushProposeEvent = event;
        });

        const { id } = await dapp.propose({
          account: mockAccount,
          pairingTopic,
        });

        await waitForEvent(() => gotPushProposal);

        dapp.once("push_response", (event) => {
          gotResponse = true;
          responseEvent = event;
        });

        await wallet.reject({ id, reason: rejectionReason });
        await waitForEvent(() => gotResponse);

        expect(responseEvent.params.error).toBeDefined();
        expect(responseEvent.params.error.message).toBe(
          `${SDK_ERRORS.USER_REJECTED.message} Reason: ${rejectionReason}.`
        );

        // Check that wallet is in expected state.
        expect(wallet.subscriptions.length).toBe(0);
        expect(wallet.proposals.length).toBe(0);
        // Check that dapp is in expected state.
        expect(dapp.subscriptions.length).toBe(0);
        expect(dapp.proposals.length).toBe(0);
      });

      it("automatically rejects proposal when subscription exists", async () => {
        const { responseEvent, pairingTopic } = await createPushSubscription(
          dapp,
          wallet
        );

        let hasError = false;
        let gotNewResponse = false;
        expect(responseEvent.params.subscription.topic).toBeDefined();

        // Check that wallet is in expected state.
        expect(wallet.subscriptions.length).toBe(1);
        expect(wallet.messages.length).toBe(1);
        expect(wallet.proposals.length).toBe(0);

        // Check that dapp is in expected state.
        expect(dapp.subscriptions.length).toBe(1);
        expect(dapp.proposals.length).toBe(0);

        dapp.on("push_response", (ev) => {
          gotNewResponse = true;
          hasError = Boolean(ev.params.error);
        });

        await dapp.propose({
          account: mockAccount,
          pairingTopic,
        });

        await waitForEvent(() => gotNewResponse);

        expect(hasError).toEqual(true);

        // Check that wallet is in expected state.
        expect(wallet.subscriptions.length).toBe(1);
      });
    });

    describe("subscribe", () => {
      it("can issue a `push_subscription` request and handle the response", async () => {
        let gotPushSubscriptionResponse = false;
        let pushSubscriptionEvent: any;

        wallet.once("push_subscription", (event) => {
          gotPushSubscriptionResponse = true;
          pushSubscriptionEvent = event;
        });

        await wallet.subscribe({
          metadata: gmDappMetadata,
          account: mockAccount,
          onSign: onSignMock,
        });

        await waitForEvent(() => gotPushSubscriptionResponse);

        expect(
          pushSubscriptionEvent.params.subscription.metadata
        ).to.deep.equal(gmDappMetadata);
        expect(pushSubscriptionEvent.params.subscription.topic).toBeDefined();

        // Check that wallet is in expected state.
        expect(
          wallet.subscriptions.keys.includes(
            pushSubscriptionEvent.params.subscription.topic
          )
        ).toBe(true);
        expect(
          wallet.messages.keys.includes(
            pushSubscriptionEvent.params.subscription.topic
          )
        ).toBe(true);
        expect(wallet.requests.length).toBe(0);
      });
    });

    describe("update", () => {
      it("can update an existing push subscription with a new scope", async () => {
        let gotPushSubscriptionResponse = false;
        let initialPushSubscription = {} as PushClientTypes.PushSubscription;

        wallet.once("push_subscription", (event) => {
          gotPushSubscriptionResponse = true;
          initialPushSubscription = cloneDeep(event.params.subscription!);
        });

        await wallet.subscribe({
          metadata: gmDappMetadata,
          account: mockAccount,
          onSign: onSignMock,
        });

        await waitForEvent(() => gotPushSubscriptionResponse);

        expect(initialPushSubscription.metadata).to.deep.equal(gmDappMetadata);
        expect(initialPushSubscription.topic).toBeDefined();

        let gotPushUpdateResponse = false;
        let pushUpdateEvent: any;

        wallet.once("push_update", (event) => {
          gotPushUpdateResponse = true;
          pushUpdateEvent = { ...event };
        });

        await wallet.update({
          topic: initialPushSubscription.topic,
          scope: [""],
        });

        await waitForEvent(() => gotPushUpdateResponse);

        expect(pushUpdateEvent.params.subscription.topic).toBe(
          initialPushSubscription.topic
        );
        expect(pushUpdateEvent.params.subscription.metadata).to.deep.equal(
          initialPushSubscription.metadata
        );
        expect(pushUpdateEvent.params.subscription.scope).not.to.deep.equal(
          initialPushSubscription.scope
        );
      });
    });

    describe("decryptMessage", () => {
      it("can decrypt an encrypted message for a known push topic", async () => {
        await createPushSubscription(dapp, wallet);

        const plaintextMessage = "this is a test for decryptMessage";
        const topic = wallet.subscriptions.keys[0];
        const payload = formatJsonRpcRequest(
          "wc_pushMessage",
          plaintextMessage
        );
        const encryptedMessage = await wallet.core.crypto.encode(
          topic,
          payload
        );

        const decryptedMessage = await wallet.decryptMessage({
          topic,
          encryptedMessage,
        });

        expect(decryptedMessage).toBe(plaintextMessage);
      });
    });

    describe("getMessageHistory", async () => {
      it("can get message history for a known push topic", async () => {
        await createPushSubscription(dapp, wallet);
        const [subscription] = dapp.subscriptions.getAll();
        const { topic } = subscription;
        const message1 = {
          title: "Test Push 1",
          body: "This is a test push notification",
          icon: "xyz.png",
          url: "https://walletconnect.com",
        };
        const message2 = {
          title: "Test Push 2",
          body: "This is a test push notification",
          icon: "xyz.png",
          url: "https://walletconnect.com",
        };

        wallet.messages.set(topic, {
          topic,
          messages: {
            "1685014464223153": {
              id: 1685014464223153,
              topic:
                "a185fd51f0a9a4d1fb4fffb4129480a8779d6c8f549cbbac3a0cfefd8788cd5d",
              message: message1,
              publishedAt: 1685014464322,
            },
            "1685014464326223": {
              id: 1685014464326223,
              topic:
                "a185fd51f0a9a4d1fb4fffb4129480a8779d6c8f549cbbac3a0cfefd8788cd5d",
              message: message2,
              publishedAt: 1685014464426,
            },
          },
        });

        const messageHistory = wallet.getMessageHistory({ topic });
        const sortedHistory = Object.values(messageHistory).sort(
          (a, b) => a.publishedAt - b.publishedAt
        );

        expect(sortedHistory.length).toBe(2);
        expect(sortedHistory[0].id).toBeDefined();
        expect(sortedHistory[0].topic).toBeDefined();
        expect(sortedHistory[0].publishedAt).toBeDefined();
        expect(sortedHistory.map(({ message }) => message)).to.deep.equal([
          message1,
          message2,
        ]);
      });
    });

    // TODO: debug why this specifically flakes on CI but not locally.
    describe.skip("deleteSubscription", () => {
      it("can delete a currently active push subscription", async () => {
        const { responseEvent } = await createPushSubscription(dapp, wallet);
        let gotPushDeleteEvent = false;
        let pushDeleteEvent: any;

        expect(responseEvent.params.subscription.topic).toBeDefined();

        expect(Object.keys(wallet.getActiveSubscriptions()).length).toBe(1);

        const walletSubscriptionTopic = Object.keys(
          wallet.getActiveSubscriptions()
        )[0];

        dapp.once("push_delete", (event) => {
          gotPushDeleteEvent = true;
          pushDeleteEvent = event;
        });

        await wallet.deleteSubscription({ topic: walletSubscriptionTopic });
        await waitForEvent(() => gotPushDeleteEvent);

        expect(pushDeleteEvent.topic).toBe(walletSubscriptionTopic);
        // Check that wallet is in expected state.
        expect(Object.keys(wallet.getActiveSubscriptions()).length).toBe(0);
        expect(wallet.messages.keys.length).toBe(0);
        // Check that dapp is in expected state.
        expect(Object.keys(dapp.getActiveSubscriptions()).length).toBe(0);
      });
    });

    describe("deletePushMessage", async () => {
      it("deletes the push message associated with the provided `id`", async () => {
        await createPushSubscription(dapp, wallet);
        const [subscription] = dapp.subscriptions.getAll();
        const { topic } = subscription;
        const message = {
          title: "Test Push",
          body: "This is a test push notification",
          icon: "xyz.png",
          url: "https://walletconnect.com",
        };

        wallet.messages.set(topic, {
          topic,
          messages: {
            "1685014464223153": {
              id: 1685014464223153,
              topic:
                "a185fd51f0a9a4d1fb4fffb4129480a8779d6c8f549cbbac3a0cfefd8788cd5d",
              message,
              publishedAt: 1685014464322,
            },
          },
        });

        const messages = Object.values(wallet.messages.get(topic).messages);

        expect(messages.length).toBe(1);

        const targetMessageId = messages[0].id;
        wallet.deletePushMessage({ id: targetMessageId });

        expect(Object.values(wallet.messages.get(topic).messages).length).toBe(
          0
        );
      });
    });
  });

  describe("Sync Functionality", () => {
    describe("Push Subscriptions", () => {
      it("Syncs push subscriptions", async () => {
        let gotSyncUpdate = false;
        const core1 = new Core({ projectId });
        const sync1 = await SyncClient.init({
          core: core1,
          projectId,
        });
        const core2 = new Core({ projectId });
        const sync2 = await SyncClient.init({
          core: core2,
          projectId,
        });

        // Can not use existing `wallet` as it has mocked identity keys
        const wallet1 = await WalletClient.init({
          SyncStoreController: SyncStore,
          syncClient: sync1,
          core: core1,
          projectId,
        });
        const wallet2 = await WalletClient.init({
          SyncStoreController: SyncStore,
          syncClient: sync2,
          core: core2,
          projectId,
        });

        const ethersWallet = Wallet.createRandom();
        await wallet1.enableSync({
          account: `eip155:1:${ethersWallet.address}`,
          onSign: (message) => {
            return ethersWallet.signMessage(message);
          },
        });
        await wallet2.enableSync({
          account: `eip155:1:${ethersWallet.address}`,
          onSign: (message) => {
            return ethersWallet.signMessage(message);
          },
        });

        wallet2.syncClient.on("sync_update", () => {
          gotSyncUpdate = true;
        });

        let gotPushSubscriptionResponse = false;
        wallet1.once("push_subscription", () => {
          gotPushSubscriptionResponse = true;
        });
        await wallet1.subscribe({
          account: `eip155:1:${ethersWallet.address}`,
          onSign: (m) => ethersWallet.signMessage(m),
          metadata: gmDappMetadata,
        });
        await waitForEvent(() => gotPushSubscriptionResponse);

        await waitForEvent(() => gotSyncUpdate);

        expect(wallet2.getActiveSubscriptions()).toEqual(
          wallet1.getActiveSubscriptions()
        );

        let walletMessage: string = "";
        let walletPeerMessage: string = "";
        wallet1.on("push_message", (m) => {
          walletMessage = m.params.message.body;
        });

        wallet2.on("push_message", (m) => {
          walletPeerMessage = m.params.message.body;
        });

        await sendPushMessage(
          projectId,
          `eip155:1:${ethersWallet.address}`,
          "Test"
        );

        await waitForEvent(() => Boolean(walletMessage));
        await waitForEvent(() => Boolean(walletPeerMessage));

        expect(walletMessage).toEqual("Test");
        expect(walletPeerMessage).toEqual(walletMessage);
      });
    });
  });

  describe("Common (BaseClient)", () => {
    describe("getActiveSubscriptions", () => {
      it("can query currently active push subscriptions", async () => {
        const { responseEvent } = await createPushSubscription(dapp, wallet);

        expect(responseEvent.params.subscription.topic).toBeDefined();

        const walletSubscriptions = wallet.getActiveSubscriptions();
        const dappSubscriptions = dapp.getActiveSubscriptions();

        // Check that wallet is in expected state.
        expect(Object.keys(walletSubscriptions).length).toBe(1);
        // Check that dapp is in expected state.
        expect(Object.keys(dappSubscriptions).length).toBe(1);
        // Check that topics of subscriptions match.
        expect(Object.keys(walletSubscriptions)).toEqual(
          Object.keys(dappSubscriptions)
        );
      });
      it("can filter currently active push subscriptions", async () => {
        [1, 2].forEach((num) => {
          wallet.subscriptions.set(`topic${num}`, {
            account: `account${num}`,
            expiry: Date.now(),
            relay: {
              protocol: RELAYER_DEFAULT_PROTOCOL,
            },
            scope: {},
            metadata: gmDappMetadata,
            topic: `topic${num}`,
            symKey: "",
          });
        });

        const walletSubscriptions = wallet.getActiveSubscriptions({
          account: "account2",
        });

        expect(Object.keys(walletSubscriptions).length).toBe(1);
        expect(
          Object.values(walletSubscriptions).map((sub) => sub.account)
        ).toEqual(["account2"]);
      });
    });
  });
});
