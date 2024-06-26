import { Wallet as EthersWallet } from "@ethersproject/wallet";
import {
  Core,
  RELAYER_DEFAULT_PROTOCOL,
  RELAYER_EVENTS,
} from "@walletconnect/core";
import { formatJsonRpcRequest } from "@walletconnect/jsonrpc-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_KEYSERVER_URL,
  INotifyClient,
  NotifyClient,
  NotifyClientTypes,
} from "../src/";
import { waitForEvent } from "./helpers/async";
import { testDappMetadata } from "./helpers/mocks";
import { createNotifySubscription, sendNotifyMessage } from "./helpers/notify";
import { disconnectSocket } from "./helpers/ws";
import axios from "axios";
import { ICore } from "@walletconnect/types";
import { generateClientDbName } from "./helpers/storage";
import { encodeEd25519Key } from "@walletconnect/did-jwt";

const DEFAULT_RELAY_URL = "wss://relay.walletconnect.com";

// Comes from notify config from explorer
// https://explorer-api.walletconnect.com/w3i/v1/notify-config?projectId=228af4798d38a06cb431b473254c9720&appDomain="wc-notify-swift-integration-tests-prod.pages.dev
const testScopeId = "f173f231-a45c-4dc0-aa5d-956eb04f7360";

if (!process.env.TEST_PROJECT_ID) {
  throw new ReferenceError("TEST_PROJECT_ID env variable not set");
}

const hasTestProjectSecret =
  typeof process.env.TEST_PROJECT_SECRET !== "undefined";

const projectId = process.env.TEST_PROJECT_ID;

describe("Notify", () => {
  let core: ICore;
  let wallet: INotifyClient;
  let ethersWallet: EthersWallet;
  let account: string;
  let onSign: (message: string) => Promise<string>;

  beforeEach(async () => {
    core = new Core({
      projectId,
      relayUrl: DEFAULT_RELAY_URL,
    });

    wallet = await NotifyClient.init({
      name: "testNotifyClient",
      logger: "error",
      keyserverUrl: DEFAULT_KEYSERVER_URL,
      relayUrl: DEFAULT_RELAY_URL,
      core,
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

  describe("NotifyClient", () => {
    it("can be instantiated", () => {
      expect(wallet instanceof NotifyClient).toBe(true);
      expect(wallet.core).toBeDefined();
      expect(wallet.events).toBeDefined();
      expect(wallet.logger).toBeDefined();
      expect(wallet.subscriptions).toBeDefined();
      expect(wallet.core.expirer).toBeDefined();
      expect(wallet.core.history).toBeDefined();
      expect(wallet.core.pairing).toBeDefined();
    });

    describe("register", () => {
      it("can handle stale statements", async () => {
        const preparedRegistration1 = await wallet.prepareRegistration({
          account,
          domain: testDappMetadata.appDomain,
          allApps: false,
        });

        const identityKey1 = await wallet.register({
          registerParams: preparedRegistration1.registerParams,
          signature: await onSign(preparedRegistration1.message),
        });

        await wallet.registrationData.set(account, {
          statement: "false statement",
          account,
          domain: testDappMetadata.appDomain,
        });

        expect(
          wallet.isRegistered({
            account,
            allApps: true,
            domain: testDappMetadata.appDomain,
          })
        ).toEqual(false);

        const preparedRegistration2 = await wallet.prepareRegistration({
          account,
          domain: testDappMetadata.appDomain,
          allApps: false,
        });

        await expect(
          wallet.register({
            registerParams: preparedRegistration2.registerParams,
            signature: await onSign(preparedRegistration2.message),
          })
        ).rejects.toEqual(
          new Error(
            "Failed to register, user has an existing stale identity. Unregister using the unregister method."
          )
        );

        await wallet.unregister({ account });

        const preparedRegistration3 = await wallet.prepareRegistration({
          account,
          domain: testDappMetadata.appDomain,
          allApps: false,
        });

        const identityKey3 = await wallet.register({
          registerParams: preparedRegistration3.registerParams,
          signature: await onSign(preparedRegistration3.message),
        });

        expect(identityKey3).to.not.eq(identityKey1);
      });
    });

    describe("unregister", () => {
      it("can unregister", async () => {
        // using newly generated account to ensure clean slate for tests
        // as this test interacts with keys server
        const newWallet = EthersWallet.createRandom();
        const newAccount = `eip155:1:${newWallet.address}`;

        const storageLoc = generateClientDbName("notifyTestUnregister");
        const newClient = await NotifyClient.init({
          name: "testNotifyClientForUnregister",
          logger: "error",
          keyserverUrl: DEFAULT_KEYSERVER_URL,
          relayUrl: DEFAULT_RELAY_URL,
          core: new Core({
            projectId,
            storageOptions: { database: storageLoc },
          }),
          projectId,
        });

        const preparedRegistration1 = await newClient.prepareRegistration({
          account: newAccount,
          domain: testDappMetadata.appDomain,
          allApps: true,
        });

        const identityKey1 = await newClient.register({
          registerParams: preparedRegistration1.registerParams,
          signature: await newWallet.signMessage(preparedRegistration1.message),
        });

        const encodedIdentity = encodeEd25519Key(identityKey1);

        // key server expects identity key in this format.
        const identityKeyFetchFormat = encodedIdentity.split(":").pop();

        const fetchUrl = `${DEFAULT_KEYSERVER_URL}/identity?publicKey=${identityKeyFetchFormat}`;

        const responsePreUnregister = await axios(fetchUrl);

        expect(responsePreUnregister.status).toEqual(200);

        await newClient.subscribe({
          account: newAccount,
          appDomain: testDappMetadata.appDomain,
        });

        expect(newClient.subscriptions.getAll().length).toEqual(1);

        const subTopic = newClient.subscriptions.getAll()[0].topic;

        expect(
          await newClient.core.relayer.subscriber.isSubscribed(subTopic)
        ).toEqual(true);

        await newClient.unregister({ account: newAccount });

        // Notify_Subscription should stay but should not be subscribed to the relay topic
        expect(newClient.subscriptions.getAll().length).toEqual(1);

        expect(
          await newClient.core.relayer.subscriber.isSubscribed(subTopic)
        ).toEqual(false);

        const responsePostUnregister = await axios(fetchUrl, {
          validateStatus: () => true,
        });

        expect(responsePostUnregister.status).toEqual(404);
      });
    });

    describe("subscribe", () => {
      it("can issue a `notify_subscription` request and handle the response", async () => {
        const preparedRegistration = await wallet.prepareRegistration({
          account,
          domain: testDappMetadata.appDomain,
          allApps: true,
        });

        await wallet.register({
          registerParams: preparedRegistration.registerParams,
          signature: await onSign(preparedRegistration.message),
        });

        expect(wallet.subscriptions.keys.length).toBe(0);

        // subscribers jwt update should account for the update
        const subscriptionSucceeded = await wallet.subscribe({
          account,
          appDomain: testDappMetadata.appDomain,
        });

        expect(subscriptionSucceeded).toEqual(true);

        // Check that wallet is in expected state.
        expect(wallet.subscriptions.keys.length).toBe(1);
        expect(wallet.messages.keys.length).toBe(1);
      });
    });

    describe.skipIf(!hasTestProjectSecret)(
      "handling incoming notifyMessage",
      () => {
        it("emits a `notify_message` event when a notifyMessage is received", async () => {
          await createNotifySubscription(wallet, account, onSign);

          let gotNotifyMessageResponse = false;
          let notifyMessageEvent: any;

          let gotNotifyNotificationResponse = false;
          let notifyNotificationEvent: any;

          wallet.once("notify_message", (event) => {
            console.log("notify_message", event);
            gotNotifyMessageResponse = true;
            notifyMessageEvent = event;
          });

          wallet.once("notify_notification", (event) => {
            gotNotifyNotificationResponse = true;
            notifyNotificationEvent = event;
          });

          const sendResponse = await sendNotifyMessage(account, "Test");

          expect(sendResponse.status).toBe(200);

          await waitForEvent(() => gotNotifyMessageResponse);
          await waitForEvent(() => gotNotifyNotificationResponse);

          expect(notifyMessageEvent.params.message.body).toBe("Test");
          expect(notifyNotificationEvent.params.notification.body).toBe("Test");
        });

        it("reads the dapp's did.json from memory after the initial fetch", async () => {
          let incomingMessageCount = 0;
          // These are calls that occur due to registering.
          // 1 - NOTIFY_SERVER_URL/.well-known/did.json
          // 2 - TEST_PROJECT_URL/.well-known/did.json
          // 3 - TEST_PROJECT_URL/.well-known/wc-notify-config.json
          const INITIAL_CALLS_FETCH_ACCOUNT = 3;
          const axiosSpy = vi.spyOn(axios, "get");

          const ethersWallet2 = EthersWallet.createRandom();
          const account2 = `eip155:1:${ethersWallet2.address}`;
          const storageLoc = generateClientDbName("notifyTestDidJson");

          const wallet1 = await NotifyClient.init({
            name: "testNotifyClient2",
            logger: "error",
            keyserverUrl: DEFAULT_KEYSERVER_URL,
            relayUrl: DEFAULT_RELAY_URL,
            core: new Core({
              projectId,
              storageOptions: { database: storageLoc },
            }),
            projectId,
          });

          await createNotifySubscription(wallet1, account2, (m) =>
            ethersWallet2.signMessage(m)
          );

          wallet1.on("notify_message", () => {
            incomingMessageCount += 1;
          });

          await sendNotifyMessage(account2, "Test");
          await sendNotifyMessage(account2, "Test");

          await waitForEvent(() => {
            return incomingMessageCount === 2;
          });

          // Ensure `axios.get` was only called once to resolve the dapp's did.json
          // We have to account for the initial calls that happened during watchSubscriptions on init
          // Also have to account for the jwt update that happens when creating a subscription
          expect(axiosSpy).toHaveBeenCalledTimes(
            INITIAL_CALLS_FETCH_ACCOUNT + 1
          );
        });
      }
    );

    describe("update", () => {
      it("can update an existing notify subscription with a new scope", async () => {
        await createNotifySubscription(wallet, account, onSign);

        let gotNotifyUpdateResponse = false;

        wallet.once("notify_update", () => {
          gotNotifyUpdateResponse = true;
        });

        const subscriptions = wallet.subscriptions.getAll();

        // Ensure all scopes are enabled in the initial subscription.
        expect(
          Object.values(subscriptions[0].scope)
            .map((scp) => scp.enabled)
            .every((enabled) => enabled === true)
        ).toBe(true);

        await wallet.update({
          topic: subscriptions[0].topic,
          scope: [testScopeId],
        });

        await waitForEvent(() => gotNotifyUpdateResponse);

        expect(gotNotifyUpdateResponse).toBe(true);

        // Ensure all scopes have been disabled in the updated subscription.
        expect(
          Object.values(
            Object.values(wallet.getActiveSubscriptions())[0].scope
          ).find((scp) => scp.id === testScopeId)?.enabled
        ).toBe(true);
      });
    });

    describe("decryptMessage", () => {
      it("can decrypt an encrypted message for a known notify topic", async () => {
        await createNotifySubscription(wallet, account, onSign);

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

    describe("getActiveSubscriptions", () => {
      it("can query currently active notify subscriptions", async () => {
        await createNotifySubscription(wallet, account, onSign);

        const walletSubscriptions = wallet.getActiveSubscriptions();

        // Check that wallet is in expected state.
        expect(Object.keys(walletSubscriptions).length).toBe(1);
      });
      it("can filter currently active notify subscriptions", async () => {
        [1, 2].forEach((num) => {
          wallet.subscriptions.set(`topic${num}`, {
            unreadNotificationCount: 0,
            account: `account${num}`,
            expiry: Date.now(),
            appAuthenticationKey: "",
            relay: {
              protocol: RELAYER_DEFAULT_PROTOCOL,
            },
            scope: {},
            metadata: testDappMetadata,
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

    describe.skipIf(!hasTestProjectSecret)("Message retrieval", () => {
      it("getNotificationHistory", async () => {
        let totalMessages = 0;
        await createNotifySubscription(wallet, account, onSign);

        expect(wallet.subscriptions.getAll().length).toEqual(1);

        const testSub = wallet.subscriptions.getAll()[0];

        expect(
          Object.keys(wallet.messages.get(testSub.topic).messages).length
        ).toEqual(0);

        const now = Date.now();

        await waitForEvent(() => Date.now() - now > 1_000);

        wallet.on("notify_message", () => {
          totalMessages++;
        });

        const notifications = [0, 1].map((num) => `${num}Test`);
        for (const notification of notifications) {
          await sendNotifyMessage(account, notification);
        }

        await waitForEvent(() => totalMessages === 2);

        await wallet.messages.delete(testSub.topic, {
          code: -1,
          message: "Delete for testing",
        });

        const history = await wallet.getNotificationHistory({
          topic: testSub.topic,
          limit: 2,
        });

        // notifications come in reverse order (latest to oldest)
        expect(history.notifications.map((n) => n.body)).toEqual(
          notifications.reverse()
        );

        expect(history.notifications[0].sentAt).toBeTypeOf("number");

        expect(history.hasMore).toEqual(false);
      });

      it("It fetches unread count in subscriptions", async () => {
        let totalMessages = 0;
        await createNotifySubscription(wallet, account, onSign);

        expect(wallet.subscriptions.getAll().length).toEqual(1);

        const testSub = wallet.subscriptions.getAll()[0];

        expect(
          Object.keys(wallet.messages.get(testSub.topic).messages).length
        ).toEqual(0);

        const now = Date.now();

        await waitForEvent(() => Date.now() - now > 1_000);

        wallet.on("notify_message", () => {
          totalMessages++;
        });

        const notifications = [0, 1].map((num) => `${num}Test`);
        for (const notification of notifications) {
          await sendNotifyMessage(account, notification);
        }

        await waitForEvent(() => totalMessages === 2);

        const history = await wallet.getNotificationHistory({
          topic: testSub.topic,
          limit: 1,
        });

        expect(history.notifications.length).toEqual(1);
        expect(history.hasMoreUnread).toEqual(true);
        expect(history.notifications[0].isRead).toEqual(false);

        await wallet.markNotificationsAsRead({
          topic: testSub.topic,
          notificationIds: [history.notifications[0].id],
        });

        const historyAfterReadingFirstNotif =
          await wallet.getNotificationHistory({
            topic: testSub.topic,
            limit: 2,
            unreadFirst: true,
          });

        expect(historyAfterReadingFirstNotif.notifications.length).toEqual(2);

        expect(historyAfterReadingFirstNotif.notifications[0].isRead).toEqual(
          false
        );

        const storageLoc2 = generateClientDbName("notifyTestAutomatic");

        const wallet2 = await NotifyClient.init({
          name: "testNotifyClient2",
          logger: "error",
          keyserverUrl: DEFAULT_KEYSERVER_URL,
          relayUrl: DEFAULT_RELAY_URL,
          core: new Core({
            projectId,
            storageOptions: { database: storageLoc2 },
          }),
          projectId,
        });

        let subsChangedWallet2: NotifyClientTypes.NotifySubscription[] = [];
        wallet2.on("notify_subscriptions_changed", (args) => {
          subsChangedWallet2 = args.params.subscriptions;
        });

        const preparedRegistration = await wallet2.prepareRegistration({
          account,
          domain: testDappMetadata.appDomain,
          allApps: true,
        });

        await wallet2.register({
          registerParams: preparedRegistration.registerParams,
          signature: await onSign(preparedRegistration.message),
        });

        await waitForEvent(() => Boolean(subsChangedWallet2.length));

        expect(subsChangedWallet2.length).toEqual(1);

        expect(subsChangedWallet2[0].unreadNotificationCount).toEqual(1);
      });

      it("fetches unread first", async () => {
        let totalMessages = 0;
        await createNotifySubscription(wallet, account, onSign);

        expect(wallet.subscriptions.getAll().length).toEqual(1);

        const testSub = wallet.subscriptions.getAll()[0];

        expect(
          Object.keys(wallet.messages.get(testSub.topic).messages).length
        ).toEqual(0);

        const now = Date.now();

        await waitForEvent(() => Date.now() - now > 1_000);

        wallet.on("notify_message", () => {
          totalMessages++;
        });

        const notifications = [0, 1].map((num) => `${num}Test`);
        for (const notification of notifications) {
          await sendNotifyMessage(account, notification);
        }

        await waitForEvent(() => totalMessages === 2);

        const history = await wallet.getNotificationHistory({
          topic: testSub.topic,
          limit: 1,
        });

        expect(history.notifications.length).toEqual(1);
        expect(history.hasMoreUnread).toEqual(true);
        expect(history.notifications[0].isRead).toEqual(false);

        await wallet.markNotificationsAsRead({
          topic: testSub.topic,
          notificationIds: [history.notifications[0].id],
        });

        const historyAfterReadingFirstNotif =
          await wallet.getNotificationHistory({
            topic: testSub.topic,
            limit: 2,
            unreadFirst: true,
          });

        expect(historyAfterReadingFirstNotif.notifications.length).toEqual(2);

        expect(historyAfterReadingFirstNotif.notifications[0].isRead).toEqual(
          false
        );
      });
    });

    describe("deleteSubscription", () => {
      it("can delete a currently active notify subscription", async () => {
        let gotNotifyDeleteResponse = false;

        await createNotifySubscription(wallet, account, onSign);

        expect(Object.keys(wallet.getActiveSubscriptions()).length).toBe(1);

        const walletSubscriptionTopic = Object.keys(
          wallet.getActiveSubscriptions()
        )[0];

        wallet.once("notify_delete", () => {
          gotNotifyDeleteResponse = true;
        });

        await wallet.deleteSubscription({ topic: walletSubscriptionTopic });

        await waitForEvent(() => gotNotifyDeleteResponse);

        // Check that wallet is in expected state.
        expect(Object.keys(wallet.getActiveSubscriptions()).length).toBe(0);
        expect(wallet.messages.keys.length).toBe(0);
      });
    });

    describe("Notification type images", () => {
      it("fetches notification type images", async () => {
        await createNotifySubscription(wallet, account, onSign);

        expect(wallet.subscriptions.keys.length).toBe(1);

        const subscription = wallet.subscriptions.getAll()[0];

        const scope = Object.entries(subscription.scope)[0][1];

        const expectedImageSmUrlRegex = /.*\/w3i\/v1\/logo\/sm\/.*/g;
        const expectedImageMdUrlRegex = /.*\/w3i\/v1\/logo\/md\/.*/g;
        const expectedImageLgUrlRegex = /.*\/w3i\/v1\/logo\/lg\/.*/g;

        expect(scope.imageUrls.sm).toMatch(expectedImageSmUrlRegex);
        expect(scope.imageUrls.md).toMatch(expectedImageMdUrlRegex);
        expect(scope.imageUrls.lg).toMatch(expectedImageLgUrlRegex);
      });
    });

    describe("watchSubscriptions", () => {
      // TODO: Refactor this test to be 2 wallets instead of 1
      it("fires correct event update", async () => {
        let updateEvent: any = {};

        await createNotifySubscription(wallet, account, onSign);

        expect(wallet.subscriptions.keys.length).toBe(1);

        const subscriptions = wallet.subscriptions.getAll();

        wallet.on("notify_update", (ev) => {
          updateEvent = ev;
        });

        await wallet.update({
          topic: subscriptions[0].topic,
          scope: [testScopeId],
        });

        expect(wallet.hasFinishedInitialLoad()).toEqual(true);

        expect(updateEvent.topic).toBe(subscriptions[0].topic);
      });

      // TODO: This test needs a refactor involving mocking event emitter
      it("automatically fires watchSubscriptions on init", async () => {
        const storageLoc = generateClientDbName("notifyTestAutomatic");
        const wallet1 = await NotifyClient.init({
          name: "testNotifyClient1",
          logger: "error",
          keyserverUrl: DEFAULT_KEYSERVER_URL,
          relayUrl: DEFAULT_RELAY_URL,
          core: new Core({
            projectId,
            storageOptions: { database: storageLoc },
          }),
          projectId,
        });

        let wallet1ReceivedChangedEvent = false;
        wallet1.on("notify_subscriptions_changed", () => {
          console.log("LISTENER????");
          wallet1ReceivedChangedEvent = true;
        });

        const preparedRegistration = await wallet.prepareRegistration({
          account,
          domain: testDappMetadata.appDomain,
          allApps: false,
        });

        await wallet1.register({
          registerParams: preparedRegistration.registerParams,
          signature: await onSign(preparedRegistration.message),
        });

        console.log("Registered...");

        await waitForEvent(() => wallet1ReceivedChangedEvent);

        console.log("Initting w2...");

        const wallet2 = await NotifyClient.init({
          name: "testNotifyClient2",
          logger: "error",
          keyserverUrl: DEFAULT_KEYSERVER_URL,
          relayUrl: DEFAULT_RELAY_URL,
          core: new Core({
            projectId,
            storageOptions: { database: storageLoc },
          }),
          projectId,
        });

        await waitForEvent(wallet2.hasFinishedInitialLoad);
      });

      it("handles multiple subscriptions", async () => {
        const wallet1 = await NotifyClient.init({
          name: "testNotifyClient1",
          logger: "error",
          keyserverUrl: DEFAULT_KEYSERVER_URL,
          relayUrl: DEFAULT_RELAY_URL,
          core,
          projectId,
        });

        await createNotifySubscription(wallet, account, onSign);

        await createNotifySubscription(wallet, account, onSign, true);

        const wallet2 = await NotifyClient.init({
          name: "debug_me",
          logger: "info",
          keyserverUrl: DEFAULT_KEYSERVER_URL,
          relayUrl: DEFAULT_RELAY_URL,
          core: new Core({ projectId, relayUrl: DEFAULT_RELAY_URL }),
          projectId,
        });

        let wallet2GotUpdate = false;
        wallet2.on("notify_subscriptions_changed", () => {
          wallet2GotUpdate = true;
        });

        const preparedRegistration = await wallet2.prepareRegistration({
          account,
          domain: "hackers.gm.walletconnect.com",
          allApps: true,
        });

        await wallet2.register({
          registerParams: preparedRegistration.registerParams,
          signature: await onSign(preparedRegistration.message),
        });

        await waitForEvent(() => {
          return wallet2GotUpdate;
        });

        expect(wallet1.subscriptions.getAll().length).toEqual(
          wallet2.subscriptions.getAll().length
        );
      });

      // consistent between relay and notify subscriptions
      it("maintains a consistent subscription state across stores", async () => {
        const walletAccount1 = EthersWallet.createRandom();
        const storageLoc1 = generateClientDbName("notifyTestConsistency");
        const wallet1 = await NotifyClient.init({
          name: "testNotifyClient1",
          logger: "error",
          keyserverUrl: DEFAULT_KEYSERVER_URL,
          relayUrl: DEFAULT_RELAY_URL,
          core: new Core({
            projectId,
            storageOptions: { database: storageLoc1 },
          }),
          projectId,
        });

        await createNotifySubscription(
          wallet1,
          `eip155:1:${walletAccount1.address}`,
          (message) => walletAccount1.signMessage(message)
        );

        const subs = Object.values(wallet1.getActiveSubscriptions());

        expect(subs.length).toEqual(1);

        const subTopic = subs[0].topic;

        expect(wallet1.core.relayer.subscriber.isSubscribed(subTopic));

        expect(wallet1.messages.get(subTopic).messages).toEqual({});

        // Create inconsistent state
        await wallet1.core.relayer.subscriber.unsubscribe(subTopic);

        // Subscribe to a different dapp to trigger subscriptions changed
        await createNotifySubscription(
          wallet1,
          `eip155:1:${walletAccount1.address}`,
          (message) => walletAccount1.signMessage(message),
          true
        );

        const subsAfterNewSub = Object.values(wallet1.getActiveSubscriptions());

        expect(subsAfterNewSub.length).toEqual(2);

        // const subTopicForInitialSub = subsAfterNewSub.find(s => s.metadata.appDomain === testDappMetadata.appDomain)?.topic;

        expect(wallet1.core.relayer.subscriber.isSubscribed(subTopic));

        expect(wallet1.messages.get(subTopic).messages).toEqual({});
      });

      it("correctly handles limited access via `allApps`", async () => {
        const storageLoc1 = generateClientDbName("notifyTestLimit1");
        const wallet1 = await NotifyClient.init({
          name: "testNotifyClient1",
          logger: "error",
          keyserverUrl: DEFAULT_KEYSERVER_URL,
          relayUrl: DEFAULT_RELAY_URL,
          core: new Core({
            projectId,
            storageOptions: { database: storageLoc1 },
          }),
          projectId,
        });

        let wallet1ReceivedChangedEvent = false;
        wallet1.on("notify_subscriptions_changed", () => {
          wallet1ReceivedChangedEvent = true;
        });

        const preparedRegistration = await wallet1.prepareRegistration({
          account,
          domain: testDappMetadata.appDomain,
          allApps: false,
        });

        await wallet1.register({
          registerParams: preparedRegistration.registerParams,
          signature: await onSign(preparedRegistration.message),
        });

        await waitForEvent(() => wallet1ReceivedChangedEvent);

        const storageLoc2 = generateClientDbName("notifyTestLimit2");
        const wallet2 = await NotifyClient.init({
          name: "testNotifyClient2",
          logger: "error",
          keyserverUrl: DEFAULT_KEYSERVER_URL,
          relayUrl: DEFAULT_RELAY_URL,
          core: new Core({
            projectId,
            storageOptions: { database: storageLoc2 },
          }),
          projectId,
        });

        let wallet2ReceivedChangedEvent = false;
        wallet2.on("notify_subscriptions_changed", () => {
          wallet2ReceivedChangedEvent = true;
        });

        const preparedRegistration2 = await wallet2.prepareRegistration({
          account,
          domain: testDappMetadata.appDomain,
          allApps: false,
        });

        await wallet2.register({
          registerParams: preparedRegistration2.registerParams,
          signature: await onSign(preparedRegistration2.message),
        });

        await waitForEvent(() => wallet2ReceivedChangedEvent);

        expect(wallet2ReceivedChangedEvent).toEqual(true);

        expect(Object.keys(wallet2.getActiveSubscriptions()).sort()).toEqual(
          Object.keys(wallet1.getActiveSubscriptions()).sort()
        );

        const storageLoc3 = generateClientDbName("notifyTestLimit3");
        const wallet3 = await NotifyClient.init({
          name: "testNotifyClient3",
          logger: "error",
          keyserverUrl: DEFAULT_KEYSERVER_URL,
          relayUrl: DEFAULT_RELAY_URL,
          core: new Core({
            projectId,
            storageOptions: { database: storageLoc3 },
          }),
          projectId,
        });

        let wallet3ReceivedChangedEvent = false;
        wallet3.on("notify_subscriptions_changed", () => {
          wallet3ReceivedChangedEvent = true;
        });

        const preparedRegistration3 = await wallet3.prepareRegistration({
          account,
          domain: "hackers.gm.walletconnect.com",
          allApps: false,
        });

        await wallet3.register({
          registerParams: preparedRegistration3.registerParams,
          signature: await onSign(preparedRegistration3.message),
        });

        await waitForEvent(() => wallet3ReceivedChangedEvent);

        expect(wallet3ReceivedChangedEvent).toEqual(true);

        expect(Object.keys(wallet3.getActiveSubscriptions()).length).toEqual(0);
      });
    });

    describe("getNotifiationTypes", () => {
      it("Correctly fetches a dapp's scopes", async () => {
        await createNotifySubscription(wallet, account, onSign);

        expect(wallet.subscriptions.length).toEqual(1);

        const sub = wallet.subscriptions.values[0];

        expect(sub.scope).toEqual(testDappMetadata.scope);
      });
    });

    describe("Blocking functions", () => {
      it("Subscribe only resolves once a subscription succeeded and is stored", async () => {
        const preparedRegistration = await wallet.prepareRegistration({
          account,
          domain: testDappMetadata.appDomain,
          allApps: true,
        });

        await wallet.register({
          registerParams: preparedRegistration.registerParams,
          signature: await onSign(preparedRegistration.message),
        });

        await wallet.subscribe({
          appDomain: testDappMetadata.appDomain,
          account,
        });

        expect(wallet.subscriptions.length).toEqual(1);
        expect(wallet.subscriptions.getAll()[0].metadata.appDomain).toEqual(
          testDappMetadata.appDomain
        );
      });

      it.skipIf(!hasTestProjectSecret)(
        "Only resolves when topic accurate response is issued",
        async () => {
          const preparedRegistration = await wallet.prepareRegistration({
            account,
            domain: testDappMetadata.appDomain,
            allApps: true,
          });

          await wallet.register({
            registerParams: preparedRegistration.registerParams,
            signature: await onSign(preparedRegistration.message),
          });

          await wallet.subscribe({
            appDomain: testDappMetadata.appDomain,
            account,
          });

          expect(wallet.subscriptions.length).toEqual(1);
          expect(wallet.subscriptions.getAll()[0].metadata.appDomain).toEqual(
            testDappMetadata.appDomain
          );

          const app1Topic = wallet.subscriptions.getAll()[0].topic;

          let gotMessage = false;

          // send messages to app1
          await sendNotifyMessage(account, "Test1");

          wallet.on("notify_message", () => {
            gotMessage = true;
          });

          await waitForEvent(() => gotMessage);

          const notifs1 = wallet.getNotificationHistory({
            topic: app1Topic,
            limit: 5,
          });

          // close transport to prevent getting a real response from the relay
          await wallet.core.relayer.transportClose();

          const emptyNotif = {
            body: "",
            id: "",
            sentAt: Date.now(),
            title: "",
            type: "",
            url: "",
            isRead: false,
          };

          wallet.engine["emit"]("notify_get_notifications_response", {
            topic: "wrong_topic",
            error: null,
            hasMore: false,
            hasMoreUnread: false,
            notifications: [],
          });

          wallet.engine["emit"]("notify_get_notifications_response", {
            topic: app1Topic,
            error: null,
            hasMore: false,
            hasMoreUnread: false,
            notifications: [emptyNotif, emptyNotif],
          });

          expect(notifs1).resolves.toSatisfy((resolved: any) => {
            return resolved.notifications.length === 2;
          });
        }
      );
    });

    describe.skipIf(!hasTestProjectSecret)("Read Unread", () => {
      it("Marks all messages as read", async () => {
        await createNotifySubscription(wallet, account, onSign);

        expect(wallet.subscriptions.getAll().length).toEqual(1);

        const testSub = wallet.subscriptions.getAll()[0];

        expect(
          Object.keys(wallet.messages.get(testSub.topic).messages).length
        ).toEqual(0);

        let messagesReceived = 0;

        wallet.on("notify_message", () => {
          messagesReceived++;
        });

        await sendNotifyMessage(account, "Test");
        await sendNotifyMessage(account, "Test2");

        await waitForEvent(() => Boolean(messagesReceived));

        const messagesFetchPre = await wallet.getNotificationHistory({
          topic: testSub.topic,
          limit: 10,
        });
        expect(messagesFetchPre.notifications.length).toEqual(2);

        const messagePre1 = messagesFetchPre.notifications[0];
        const messagePre2 = messagesFetchPre.notifications[1];

        expect(messagePre1.isRead).toEqual(false);
        expect(messagePre2.isRead).toEqual(false);

        await wallet.markAllNotificationsAsRead({
          topic: testSub.topic,
        });

        const messagesFetchPost = await wallet.getNotificationHistory({
          topic: testSub.topic,
          limit: 10,
        });

        expect(messagesFetchPost.notifications.length).toEqual(2);

        const messagePost1 = messagesFetchPost.notifications[0];
        const messagePost2 = messagesFetchPost.notifications[1];

        expect(messagePost1.isRead).toEqual(true);
        expect(messagePost2.isRead).toEqual(true);
      });

      it("Correctly marks messages as read", async () => {
        await createNotifySubscription(wallet, account, onSign);

        expect(wallet.subscriptions.getAll().length).toEqual(1);

        const testSub = wallet.subscriptions.getAll()[0];

        expect(
          Object.keys(wallet.messages.get(testSub.topic).messages).length
        ).toEqual(0);

        let messagesReceived = 0;

        wallet.on("notify_message", () => {
          messagesReceived++;
        });

        await sendNotifyMessage(account, "Test");

        await waitForEvent(() => Boolean(messagesReceived));

        const messagesFetchPre = await wallet.getNotificationHistory({
          topic: testSub.topic,
          limit: 10,
        });
        expect(messagesFetchPre.notifications.length).toEqual(1);
        const messagePre = messagesFetchPre.notifications[0];
        expect(messagePre.isRead).toEqual(false);

        await wallet.markNotificationsAsRead({
          topic: testSub.topic,
          notificationIds: [messagePre.id],
        });

        const messagesFetchPost = await wallet.getNotificationHistory({
          topic: testSub.topic,
          limit: 10,
        });
        expect(messagesFetchPost.notifications.length).toEqual(1);
        const messagePost = messagesFetchPost.notifications[0];
        expect(messagePost.isRead).toEqual(true);
      });
    });

    describe.skipIf(!hasTestProjectSecret)("Message Deduping", () => {
      it("dedups messages based on notify message id", async () => {
        await createNotifySubscription(wallet, account, onSign);

        expect(wallet.subscriptions.getAll().length).toEqual(1);

        const testSub = wallet.subscriptions.getAll()[0];

        expect(
          Object.keys(wallet.messages.get(testSub.topic).messages).length
        ).toEqual(0);

        let messagesReceived = 0;

        wallet.on("notify_message", () => {
          messagesReceived++;
        });

        const now = Date.now();

        await waitForEvent(() => Date.now() - now > 1_000);

        let receivedRealMessage = false;
        let message: any = {};
        wallet.on("notify_message", (m) => {
          receivedRealMessage = true;
          message = m;
        });

        await sendNotifyMessage(account, "Test");

        await waitForEvent(() => receivedRealMessage);

        const encoded = await wallet.core.crypto.encode(testSub.topic, {
          ...message,
          // Set different JSONRPC ID to avoid the relayer deduping the message based on JSON-RPC ID
          // Deduping should be done based on notify message ID, not
          // JSONRPC payload id
          id: Date.now(),
        });

        wallet.core.relayer.events.emit(RELAYER_EVENTS.message, {
          topic: testSub.topic,
          message: encoded,
          publishedAt: Date.now(),
        });

        // Arbitrarily wait for message to come through from event.
        const date = Date.now();
        await waitForEvent(() => Date.now() - date > 2_000);

        expect(messagesReceived).toEqual(1);
        expect(
          Object.keys(wallet.messages.get(testSub.topic).messages).length
        ).toEqual(1);
      });
    });
  });
});
