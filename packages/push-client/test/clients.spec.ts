import { formatJsonRpcRequest } from "@walletconnect/jsonrpc-utils";
import { expect, describe, it, beforeEach, afterEach } from "vitest";
import cloneDeep from "lodash.clonedeep";
import { WalletClient, IWalletClient, NotifyClientTypes } from "../src/";
import { disconnectSocket } from "./helpers/ws";
import { gmDappMetadata } from "./helpers/mocks";
import { createPushSubscription, sendPushMessage } from "./helpers/push";
import { waitForEvent } from "./helpers/async";
import { Core, RELAYER_DEFAULT_PROTOCOL } from "@walletconnect/core";
import { ISyncClient, SyncClient, SyncStore } from "@walletconnect/sync-client";
import { Wallet as EthersWallet } from "@ethersproject/wallet";

const DEFAULT_RELAY_URL = "wss://relay.walletconnect.com";

if (!process.env.TEST_PROJECT_ID) {
  throw new ReferenceError("TEST_PROJECT_ID env variable not set");
}

const hasGmSecret = typeof process.env.NOTIFY_GM_PROJECT_SECRET !== "undefined";

const projectId = process.env.TEST_PROJECT_ID;

describe("Notify", () => {
  let wallet: IWalletClient;
  let syncClient: ISyncClient;
  let ethersWallet: EthersWallet;
  let account: string;
  let onSign: (message: string) => Promise<string>;

  beforeEach(async () => {
    const core = new Core({
      projectId,
    });

    syncClient = await SyncClient.init({
      core,
      projectId,
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

    // Set up the mock wallet account
    ethersWallet = EthersWallet.createRandom();
    account = `eip155:1:${ethersWallet.address}`;
    onSign = (message: string) => ethersWallet.signMessage(message);
  });
  afterEach(async () => {
    await disconnectSocket(wallet.core);
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

    describe("subscribe", () => {
      it("can issue a `notify_subscription` request and handle the response", async () => {
        let gotPushSubscriptionResponse = false;
        let pushSubscriptionEvent: any;

        wallet.once("notify_subscription", (event) => {
          gotPushSubscriptionResponse = true;
          pushSubscriptionEvent = event;
        });

        await wallet.subscribe({
          account,
          onSign,
          metadata: gmDappMetadata,
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

    describe.skipIf(!hasGmSecret)("handling incoming notifyMessage", () => {
      it("emits a `notify_message` event when a notifyMessage is received", async () => {
        await createPushSubscription(wallet, account, onSign);

        let gotPushMessageResponse = false;
        let pushMessageEvent: any;

        wallet.once("notify_message", (event) => {
          gotPushMessageResponse = true;
          pushMessageEvent = event;
        });

        await sendPushMessage(projectId, account, "Test");

        await waitForEvent(() => gotPushMessageResponse);

        expect(pushMessageEvent.params.message.body).toBe("Test");
      });
    });

    describe("update", () => {
      it("can update an existing push subscription with a new scope", async () => {
        let gotPushSubscriptionResponse = false;
        let initialPushSubscription =
          {} as NotifyClientTypes.NotifySubscription;

        wallet.once("notify_subscription", (event) => {
          gotPushSubscriptionResponse = true;
          initialPushSubscription = cloneDeep(event.params.subscription!);
        });

        await wallet.subscribe({
          metadata: gmDappMetadata,
          account,
          onSign,
        });

        await waitForEvent(() => gotPushSubscriptionResponse);

        expect(initialPushSubscription.metadata).to.deep.equal(gmDappMetadata);
        expect(initialPushSubscription.topic).toBeDefined();

        let gotPushUpdateResponse = false;
        let pushUpdateEvent: any;

        wallet.once("notify_update", (event) => {
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
        await createPushSubscription(wallet, account, onSign);

        const messageClaims = {
          iat: 1691064656,
          exp: 1693656656,
          iss: "did:key:z6MksfkEMFdEWmGiy9rnyrJSxovfKZVB3sAFjVSvKw78bAR1",
          ksu: "https://keys.walletconnect.com",
          aud: "did:pkh:eip155:1:0x9667790eFCa797fFfBaC94ecBd479A8C3c22565A",
          act: "notify_message",
          sub: "00f22c1de22f8128faa0424434a8caa984e91f41bbb82c1796b75d33e9dd9f98",
          app: "https://gm.walletconnect.com",
          msg: {
            title: "Test Message",
            body: "Test",
            icon: "",
            url: "https://test.coms",
            type: "gm_hourly",
          },
        };
        const messageAuth =
          "eyJ0eXAiOiJKV1QiLCJhbGciOiJFZERTQSJ9.eyJpYXQiOjE2OTEwNjQ2NTEsImV4cCI6MTY5MzY1NjY1MSwiaXNzIjoiZGlkOmtleTp6Nk1rc2ZrRU1GZEVXbUdpeTlybnlySlN4b3ZmS1pWQjNzQUZqVlN2S3c3OGJBUjEiLCJrc3UiOiJodHRwczovL2tleXMud2FsbGV0Y29ubmVjdC5jb20iLCJhdWQiOiJkaWQ6cGtoOmVpcDE1NToxOjB4NTY2MkI3YTMyMzQ1ZDg0MzM2OGM2MDgzMGYzRTJiMDE1MDIyQkNFMSIsImFjdCI6Im5vdGlmeV9tZXNzYWdlIiwic3ViIjoiMDAyODY4OGMzY2ZkODYwNGRlMDgyOTdjZDQ4ZTM3NjYyYzJhMmE4MDc4MzAyYmZkNDJlZDQ1ZDkwMTE0YTQxYyIsImFwcCI6Imh0dHBzOi8vZ20ud2FsbGV0Y29ubmVjdC5jb20iLCJtc2ciOnsidGl0bGUiOiJUZXN0IE1lc3NhZ2UiLCJib2R5IjoiVGVzdCIsImljb24iOiIiLCJ1cmwiOiJodHRwczovL3Rlc3QuY29tcyIsInR5cGUiOiJnbV9ob3VybHkifX0.B2U5d6IejtRqC9I_qWnx2-AASeneX2Vtl_st8tAuoFMmBuB8r39Nr0zoslbmnyLHxt2PmEHVfzMHksFVAtrfDg";
        const topic = wallet.subscriptions.keys[0];
        const payload = formatJsonRpcRequest("wc_notifyMessage", {
          messageAuth,
        });
        const encryptedMessage = await wallet.core.crypto.encode(
          topic,
          payload
        );

        const decryptedMessage = await wallet.decryptMessage({
          topic,
          encryptedMessage,
        });

        expect(decryptedMessage).toStrictEqual(messageClaims.msg);
      });
    });

    describe("getMessageHistory", async () => {
      it("can get message history for a known push topic", async () => {
        await createPushSubscription(wallet, account, onSign);
        const [subscription] = wallet.subscriptions.getAll();
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

    // describe.skip("deleteSubscription", () => {
    //   it("can delete a currently active push subscription", async () => {
    //     const { responseEvent } = await createPushSubscription(wallet);
    //     let gotPushDeleteEvent = false;
    //     let pushDeleteEvent: any;

    //     expect(responseEvent.params.subscription.topic).toBeDefined();

    //     expect(Object.keys(wallet.getActiveSubscriptions()).length).toBe(1);

    //     const walletSubscriptionTopic = Object.keys(
    //       wallet.getActiveSubscriptions()
    //     )[0];

    //     dapp.once("notify_delete", (event) => {
    //       gotPushDeleteEvent = true;
    //       pushDeleteEvent = event;
    //     });

    //     await wallet.deleteSubscription({ topic: walletSubscriptionTopic });
    //     await waitForEvent(() => gotPushDeleteEvent);

    //     expect(pushDeleteEvent.topic).toBe(walletSubscriptionTopic);
    //     // Check that wallet is in expected state.
    //     expect(Object.keys(wallet.getActiveSubscriptions()).length).toBe(0);
    //     expect(wallet.messages.keys.length).toBe(0);
    //     // Check that dapp is in expected state.
    //     expect(Object.keys(dapp.getActiveSubscriptions()).length).toBe(0);
    //   });
    // });

    describe("deleteNotifyMessage", async () => {
      it("deletes the push message associated with the provided `id`", async () => {
        await createPushSubscription(wallet, account, onSign);
        const [subscription] = wallet.subscriptions.getAll();
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
        wallet.deleteNotifyMessage({ id: targetMessageId });

        expect(Object.values(wallet.messages.get(topic).messages).length).toBe(
          0
        );
      });
    });
  });

  describe("Sync Functionality", () => {
    describe("Notify Subscriptions", () => {
      if (!hasGmSecret) {
        console.warn(
          "Skipping sync push subscription test. NOTIFY_GM_PROJECT_SECRET env variable not set."
        );
      }
      it.skipIf(!hasGmSecret)("Syncs push subscriptions", async () => {
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

        const ethersWallet = EthersWallet.createRandom();
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
        wallet1.once("notify_subscription", () => {
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
        wallet1.on("notify_message", (m) => {
          walletMessage = m.params.message.body;
        });

        wallet2.on("notify_message", (m) => {
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
        const { pushSubscriptionEvent } = await createPushSubscription(
          wallet,
          account,
          onSign
        );

        expect(pushSubscriptionEvent.params.subscription.topic).toBeDefined();

        const walletSubscriptions = wallet.getActiveSubscriptions();

        // Check that wallet is in expected state.
        expect(Object.keys(walletSubscriptions).length).toBe(1);
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
