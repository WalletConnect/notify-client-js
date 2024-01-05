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

        let gotSub = false;
        newClient.on("notify_subscriptions_changed", (ev) => {
          gotSub = ev.params.subscriptions
            .map((sub) => sub.metadata.appDomain)
            .includes(testDappMetadata.appDomain);
        });

        await newClient.subscribe({
          account: newAccount,
          appDomain: testDappMetadata.appDomain,
        });

        await waitForEvent(() => gotSub);
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
        let gotNotifySubscriptionResponse = false;
        let gotNotifySubscriptionsChangedRequest = false;
        let changedSubscriptions: NotifyClientTypes.NotifySubscription[] = [];

        wallet.once("notify_subscription", () => {
          gotNotifySubscriptionResponse = true;
        });
        wallet.on("notify_subscriptions_changed", (event) => {
          if (event.params.subscriptions.length > 0) {
            gotNotifySubscriptionsChangedRequest = true;
            changedSubscriptions = event.params.subscriptions;
          }
        });

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
          account,
          appDomain: testDappMetadata.appDomain,
        });

        await waitForEvent(() => gotNotifySubscriptionResponse);

        await waitForEvent(() => gotNotifySubscriptionsChangedRequest);

        // Check that wallet is in expected state.
        expect(wallet.subscriptions.keys.length).toBe(1);
        expect(wallet.subscriptions.keys[0]).toBe(
          changedSubscriptions[0].topic
        );
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

          wallet.once("notify_message", (event) => {
            gotNotifyMessageResponse = true;
            notifyMessageEvent = event;
          });

          const sendResponse = await sendNotifyMessage(account, "Test");

          expect(sendResponse.status).toBe(200);

          await waitForEvent(() => gotNotifyMessageResponse);

          expect(notifyMessageEvent.params.message.body).toBe("Test");
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
          expect(axiosSpy).toHaveBeenCalledTimes(
            1 + INITIAL_CALLS_FETCH_ACCOUNT
          );
        });
      }
    );

    describe("update", () => {
      it("can update an existing notify subscription with a new scope", async () => {
        await createNotifySubscription(wallet, account, onSign);

        let gotNotifyUpdateResponse = false;
        let gotNotifySubscriptionsChangedRequest = false;
        let lastChangedSubscriptions: NotifyClientTypes.NotifySubscription[] =
          [];

        wallet.once("notify_update", () => {
          gotNotifyUpdateResponse = true;
        });
        wallet.on("notify_subscriptions_changed", (event) => {
          gotNotifySubscriptionsChangedRequest = true;
          lastChangedSubscriptions = event.params.subscriptions;
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

        await waitForEvent(() => gotNotifySubscriptionsChangedRequest);

        expect(gotNotifyUpdateResponse).toBe(true);
        expect(wallet.subscriptions.keys[0]).toBe(
          lastChangedSubscriptions[0].topic
        );

        // Ensure all scopes have been disabled in the updated subscription.
        expect(
          Object.values(lastChangedSubscriptions[0].scope).find(
            (scp) => scp.id === testScopeId
          )?.enabled
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

    describe("getMessageHistory", async () => {
      it("can get message history for a known notify topic", async () => {
        await createNotifySubscription(wallet, account, onSign);
        const [subscription] = wallet.subscriptions.getAll();
        const { topic } = subscription;
        const message1 = {
          id: "test_id_1",
          title: "Test Notify 1",
          body: "This is a test notify notification",
          icon: "xyz.png",
          url: "https://walletconnect.com",
        };
        const message2 = {
          id: "test_id_2",
          title: "Test Notify 2",
          body: "This is a test notify notification",
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

    describe("deleteSubscription", () => {
      it("can delete a currently active notify subscription", async () => {
        let gotNotifySubscriptionsChanged = false;
        let gotNotifySubscriptionsChangedEvent: any;

        await createNotifySubscription(wallet, account, onSign);

        expect(Object.keys(wallet.getActiveSubscriptions()).length).toBe(1);

        const walletSubscriptionTopic = Object.keys(
          wallet.getActiveSubscriptions()
        )[0];

        wallet.once("notify_subscriptions_changed", (event) => {
          gotNotifySubscriptionsChanged = true;
          gotNotifySubscriptionsChangedEvent = event;
        });

        await wallet.deleteSubscription({ topic: walletSubscriptionTopic });

        await waitForEvent(() => gotNotifySubscriptionsChanged);

        // Check that wallet is in expected state.
        expect(Object.keys(wallet.getActiveSubscriptions()).length).toBe(0);
        expect(wallet.messages.keys.length).toBe(0);
      });
    });

    describe("deleteNotifyMessage", async () => {
      it("deletes the notify message associated with the provided `id`", async () => {
        await createNotifySubscription(wallet, account, onSign);
        const [subscription] = wallet.subscriptions.getAll();
        const { topic } = subscription;
        const message = {
          id: "test_id",
          title: "Test Notify",
          body: "This is a test notify notification",
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

    describe("watchSubscriptions", () => {
      it("fires correct event update", async () => {
        let updateEvent: any = {};
        let gotNotifyUpdateResponse = false;
        let updatedCount = 0;

        wallet.on("notify_subscriptions_changed", () => {
          updatedCount += 1;
        });

        await createNotifySubscription(wallet, account, onSign);

        expect(wallet.subscriptions.keys.length).toBe(1);

        const subscriptions = wallet.subscriptions.getAll();

        wallet.once("notify_update", (event) => {
          gotNotifyUpdateResponse = true;
          updateEvent = event;
        });

        await wallet.update({
          topic: subscriptions[0].topic,
          scope: [testScopeId],
        });

        await waitForEvent(() => gotNotifyUpdateResponse);
        await waitForEvent(() => updatedCount === 3);

        expect(updateEvent.topic).toBe(subscriptions[0].topic);
      });

      // TODO: This test needs a refactor involving mocking event emitter
      it.skip("automatically fires watchSubscriptions on init", async () => {
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
          wallet1ReceivedChangedEvent = true;
        });

        const preparedRegistration = await wallet.prepareRegistration({
          account,
          domain: testDappMetadata.appDomain,
          allApps: false,
        });

        await wallet.register({
          registerParams: preparedRegistration.registerParams,
          signature: await onSign(preparedRegistration.message),
        });

        await waitForEvent(() => wallet1ReceivedChangedEvent);

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

        let wallet2ReceivedChangedEvent = false;
        wallet2.on("notify_subscriptions_changed", () => {
          wallet2ReceivedChangedEvent = true;
        });

        await waitForEvent(() => wallet2ReceivedChangedEvent);

        expect(wallet2ReceivedChangedEvent).toEqual(true);
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

        let wallet1UpdateCount = 0;

        wallet1.on("notify_subscriptions_changed", () => {
          wallet1UpdateCount++;
        });
        await createNotifySubscription(wallet, account, onSign);

        await createNotifySubscription(wallet, account, onSign, true);

        await waitForEvent(() => {
          return wallet1UpdateCount > 2;
        });

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
