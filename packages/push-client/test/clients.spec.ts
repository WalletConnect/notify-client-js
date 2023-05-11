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
  dappMetadata,
  gmDappMetadata,
  mockAccount,
  mockIdentityMethods,
  onSignMock,
} from "./helpers/mocks";
import { createPushSubscription, setupKnownPairing } from "./helpers/push";
import { waitForEvent } from "./helpers/async";

describe("Push", () => {
  let dapp: IDappClient;
  let wallet: IWalletClient;

  beforeEach(async () => {
    dapp = await DappClient.init({
      name: "testDappClient",
      logger: "error",
      relayUrl:
        process.env.TEST_RELAY_URL || "wss://staging.relay.walletconnect.com",
      castUrl:
        process.env.TEST_CAST_URL || "https://staging.cast.walletconnect.com",
      projectId: process.env.TEST_PROJECT_ID!,
      metadata: dappMetadata,
    });
    wallet = await WalletClient.init({
      name: "testWalletClient",
      logger: "error",
      relayUrl:
        process.env.TEST_RELAY_URL || "wss://staging.relay.walletconnect.com",
      projectId: process.env.TEST_PROJECT_ID!,
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
      expect(dapp.requests).toBeDefined();
      expect(dapp.subscriptions).toBeDefined();
      expect(dapp.core.expirer).toBeDefined();
      expect(dapp.core.history).toBeDefined();
      expect(dapp.core.pairing).toBeDefined();
    });

    describe("request", () => {
      it("can issue a `push_request` on a known pairing topic", async () => {
        // Set up known pairing.
        const pairingTopic = await setupKnownPairing(dapp, wallet);
        let gotPushRequest = false;
        let pushRequestEvent: any;

        wallet.once("push_request", (event) => {
          gotPushRequest = true;
          pushRequestEvent = event;
        });

        const { id } = await dapp.request({
          account: mockAccount,
          pairingTopic,
        });

        await waitForEvent(() => gotPushRequest);

        expect(pushRequestEvent.params.metadata).to.deep.equal(dappMetadata);
        expect(wallet.requests.get(id)).toBeDefined();
        expect(dapp.core.expirer.has(id)).toBe(true);
        expect(wallet.core.expirer.has(id)).toBe(true);
      });
    });

    describe("notify", () => {
      it("can send a `push_message` on an established push topic", async () => {
        let gotPushMessage = false;
        let pushMessageEvent: any;

        await createPushSubscription(dapp, wallet);
        const [subscription] = dapp.subscriptions.getAll();
        const { topic } = subscription;
        const message = {
          title: "Test Push",
          body: "This is a test push notification",
          icon: "xyz.png",
          url: "https://walletconnect.com",
        };

        wallet.once("push_message", (event) => {
          gotPushMessage = true;
          pushMessageEvent = event;
        });

        await dapp.notify({ topic, message });
        await waitForEvent(() => gotPushMessage);

        // Check that event is as expected.
        expect(pushMessageEvent.params.message).to.deep.equal(message);

        // Check that wallet is in expected state.
        expect(wallet.messages.values.length).toBe(1);
        expect(
          wallet.messages.values[0].messages[pushMessageEvent.id].message
        ).to.deep.equal(message);
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
      it("can approve a previously received `push_request` on a known pairing topic", async () => {
        const pairingTopic = await setupKnownPairing(wallet, dapp);
        let gotPushRequest = false;
        let pushRequestEvent: any;
        let gotResponse = false;
        let responseEvent: any;

        wallet.once("push_request", (event) => {
          gotPushRequest = true;
          pushRequestEvent = event;
        });

        const { id } = await dapp.request({
          account: mockAccount,
          pairingTopic,
        });

        await waitForEvent(() => gotPushRequest);

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
        expect(wallet.requests.length).toBe(0);
        // Check that dapp is in expected state.
        expect(dapp.subscriptions.length).toBe(1);
        expect(dapp.requests.length).toBe(0);
      });
    });

    describe("reject", () => {
      it("can reject a previously received `push_request` on a known pairing topic", async () => {
        const rejectionReason = "this is a rejection reason";
        const pairingTopic = await setupKnownPairing(wallet, dapp);
        let gotPushRequest = false;
        let pushRequestEvent: any;
        let gotResponse = false;
        let responseEvent: any;

        wallet.once("push_request", (event) => {
          gotPushRequest = true;
          pushRequestEvent = event;
        });

        const { id } = await dapp.request({
          account: mockAccount,
          pairingTopic,
        });

        await waitForEvent(() => gotPushRequest);

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
        expect(wallet.requests.length).toBe(0);
        // Check that dapp is in expected state.
        expect(dapp.subscriptions.length).toBe(0);
        expect(dapp.requests.length).toBe(0);
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

        const hasSent = await wallet.subscribe({
          metadata: gmDappMetadata,
          account: mockAccount,
          onSign: onSignMock,
        });

        expect(hasSent).toBe(true);

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

        const hasSent = await wallet.subscribe({
          metadata: gmDappMetadata,
          account: mockAccount,
          onSign: onSignMock,
        });

        expect(hasSent).toBe(true);

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
        const pairingTopic = await setupKnownPairing(wallet, dapp);
        let gotPushRequest = false;
        let pushRequestEvent: any;
        let gotResponse = false;
        let responseEvent: any;

        wallet.once("push_request", (event) => {
          gotPushRequest = true;
          pushRequestEvent = event;
        });

        const { id } = await dapp.request({
          account: mockAccount,
          pairingTopic,
        });

        await waitForEvent(() => gotPushRequest);

        dapp.once("push_response", (event) => {
          gotResponse = true;
          responseEvent = event;
        });

        await wallet.approve({ id, onSign: onSignMock });
        await waitForEvent(() => gotResponse);

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
        let receivedMessageCount = 0;

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

        wallet.on("push_message", () => {
          receivedMessageCount++;
        });

        await dapp.notify({ topic, message: message1 });
        await waitForEvent(() => receivedMessageCount === 1);
        await dapp.notify({ topic, message: message2 });
        await waitForEvent(() => receivedMessageCount === 2);

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

    describe("deletePushMessage", async () => {
      it("deletes the push message associated with the provided `id`", async () => {
        let receivedMessageCount = 0;
        let pushMessageEvent: any;

        await createPushSubscription(dapp, wallet);
        const [subscription] = dapp.subscriptions.getAll();
        const { topic } = subscription;
        const message = {
          title: "Test Push",
          body: "This is a test push notification",
          icon: "xyz.png",
          url: "https://walletconnect.com",
        };

        wallet.on("push_message", (event) => {
          receivedMessageCount++;
          pushMessageEvent = event;
        });

        await dapp.notify({ topic, message });
        await waitForEvent(() => receivedMessageCount === 1);

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

  describe("Common (BaseClient)", () => {
    describe("getActiveSubscriptions", () => {
      it("can query currently active push subscriptions", async () => {
        const pairingTopic = await setupKnownPairing(wallet, dapp);
        let gotPushRequest = false;
        let pushRequestEvent: any;
        let gotResponse = false;
        let responseEvent: any;

        wallet.once("push_request", (event) => {
          gotPushRequest = true;
          pushRequestEvent = event;
        });

        const { id } = await dapp.request({
          account: mockAccount,
          pairingTopic,
        });

        await waitForEvent(() => gotPushRequest);

        dapp.once("push_response", (event) => {
          gotResponse = true;
          responseEvent = event;
        });

        await wallet.approve({ id, onSign: onSignMock });
        await waitForEvent(() => gotResponse);

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
    });

    describe("deleteSubscription", () => {
      it("can delete a currently active push subscription", async () => {
        const pairingTopic = await setupKnownPairing(wallet, dapp);
        let gotPushRequest = false;
        let pushRequestEvent: any;
        let gotResponse = false;
        let responseEvent: any;
        let gotPushDelete = false;
        let pushDeleteEvent: any;

        wallet.once("push_request", (event) => {
          gotPushRequest = true;
          pushRequestEvent = event;
        });

        const { id } = await dapp.request({
          account: mockAccount,
          pairingTopic,
        });

        await waitForEvent(() => gotPushRequest);

        dapp.once("push_response", (event) => {
          gotResponse = true;
          responseEvent = event;
        });

        await wallet.approve({ id, onSign: onSignMock });
        await waitForEvent(() => gotResponse);

        expect(responseEvent.params.subscription.topic).toBeDefined();

        expect(Object.keys(wallet.getActiveSubscriptions()).length).toBe(1);
        expect(Object.keys(dapp.getActiveSubscriptions()).length).toBe(1);

        const walletSubscriptionTopic = Object.keys(
          wallet.getActiveSubscriptions()
        )[0];

        dapp.once("push_delete", (event) => {
          gotPushDelete = true;
          pushDeleteEvent = event;
        });

        await wallet.deleteSubscription({ topic: walletSubscriptionTopic });
        await waitForEvent(() => gotPushDelete);

        // Check that wallet is in expected state.
        expect(Object.keys(wallet.getActiveSubscriptions()).length).toBe(0);
        expect(wallet.messages.keys.length).toBe(0);
        // Check that dapp is in expected state.
        expect(Object.keys(dapp.getActiveSubscriptions()).length).toBe(0);
      });
    });
  });
});
