import { formatJsonRpcRequest } from "@walletconnect/jsonrpc-utils";
import { generateRandomBytes32 } from "@walletconnect/utils";
import { expect, describe, it, beforeEach, afterEach } from "vitest";
import { SDK_ERRORS } from "../src/constants";
import { DappClient } from "../src/dappClient";
import { IDappClient, IWalletClient } from "../src/types";
import { WalletClient } from "../src/walletClient";
import { disconnectSocket } from "./helpers/ws";

const dappMetadata = {
  name: "dapp (requester)",
  description: "Test DappClient as Requester",
  url: "www.walletconnect.com",
  icons: [],
};

const walletMetadata = {
  name: "wallet (responder)",
  description: "Test WalletClient as Responder",
  url: "www.walletconnect.com",
  icons: [],
};

const setupKnownPairing = async (
  clientA: IWalletClient | IDappClient,
  clientB: IWalletClient | IDappClient
) => {
  const symKey = generateRandomBytes32();
  const pairingTopic = await clientA.core.crypto.setSymKey(symKey);
  await clientA.core.relayer.subscribe(pairingTopic);
  const peerPairingTopic = await clientB.core.crypto.setSymKey(symKey);
  await clientB.core.relayer.subscribe(peerPairingTopic);

  // `pairingTopic` and `peerPairingTopic` should be identical -> just return one of them.
  return pairingTopic;
};

const createPushSubscription = async (
  dapp: IDappClient,
  wallet: IWalletClient
) => {
  const pairingTopic = await setupKnownPairing(wallet, dapp);
  let gotPushRequest = false;
  let pushRequestEvent: any;
  let gotResponse = false;
  let responseEvent: any;

  wallet.once("push_request", (event) => {
    gotPushRequest = true;
    pushRequestEvent = event;
  });
  dapp.once("push_response", (event) => {
    gotResponse = true;
    responseEvent = event;
  });

  const { id } = await dapp.request({
    account: "0xB68328542D0C08c47882D1276c7cC4D6fB9eAe71",
    pairingTopic,
  });

  await waitForEvent(() => gotPushRequest);

  await wallet.approve({ id });
  await waitForEvent(() => gotResponse);
};

// Polls boolean value every interval to check for an event callback having been triggered.
const waitForEvent = async (checkForEvent: (...args: any[]) => boolean) => {
  await new Promise((resolve) => {
    const intervalId = setInterval(() => {
      if (checkForEvent()) {
        clearInterval(intervalId);
        resolve({});
      }
    }, 100);
  });
};

describe("DappClient", () => {
  let dapp: IDappClient;
  let wallet: IWalletClient;

  beforeEach(async () => {
    dapp = await DappClient.init({
      name: "testDappClient",
      logger: "error",
      relayUrl:
        process.env.TEST_RELAY_URL || "wss://staging.relay.walletconnect.com",
      projectId: process.env.TEST_PROJECT_ID!,
      metadata: dappMetadata,
    });
    wallet = await WalletClient.init({
      name: "testWalletClientAsPeer",
      logger: "error",
      relayUrl:
        process.env.TEST_RELAY_URL || "wss://staging.relay.walletconnect.com",
      projectId: process.env.TEST_PROJECT_ID!,
      metadata: walletMetadata,
    });
  });
  afterEach(async () => {
    await disconnectSocket(dapp.core);
    await disconnectSocket(wallet.core);
  });

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
        account: "0xB68328542D0C08c47882D1276c7cC4D6fB9eAe71",
        pairingTopic,
      });

      await waitForEvent(() => gotPushRequest);

      expect(pushRequestEvent.params.metadata).to.deep.equal(dappMetadata);
      expect(wallet.requests.get(id)).toBeDefined();
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

      expect(pushMessageEvent.params.message).to.deep.equal(message);
    });
  });
});

describe("WalletClient", () => {
  let wallet: IWalletClient;
  let dapp: IDappClient;

  beforeEach(async () => {
    wallet = await WalletClient.init({
      name: "testWalletClient",
      logger: "error",
      relayUrl:
        process.env.TEST_RELAY_URL || "wss://staging.relay.walletconnect.com",
      projectId: process.env.TEST_PROJECT_ID!,
      metadata: dappMetadata,
    });
    dapp = await DappClient.init({
      name: "testDappClientAsPeer",
      logger: "error",
      relayUrl:
        process.env.TEST_RELAY_URL || "wss://staging.relay.walletconnect.com",
      projectId: process.env.TEST_PROJECT_ID!,
      metadata: walletMetadata,
    });
  });
  afterEach(async () => {
    await disconnectSocket(wallet.core);
    await disconnectSocket(dapp.core);
  });

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
        account: "0xB68328542D0C08c47882D1276c7cC4D6fB9eAe71",
        pairingTopic,
      });

      await waitForEvent(() => gotPushRequest);

      dapp.once("push_response", (event) => {
        gotResponse = true;
        responseEvent = event;
      });

      await wallet.approve({ id });
      await waitForEvent(() => gotResponse);

      expect(responseEvent.params.subscription.topic).toBeDefined();

      // Check that wallet is in expected state.
      expect(wallet.subscriptions.length).toBe(1);
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
        account: "0xB68328542D0C08c47882D1276c7cC4D6fB9eAe71",
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
        account: "0xB68328542D0C08c47882D1276c7cC4D6fB9eAe71",
        pairingTopic,
      });

      await waitForEvent(() => gotPushRequest);

      dapp.once("push_response", (event) => {
        gotResponse = true;
        responseEvent = event;
      });

      await wallet.approve({ id });
      await waitForEvent(() => gotResponse);

      const plaintextMessage = "this is a test for decryptMessage";
      const topic = wallet.subscriptions.keys[0];
      const payload = formatJsonRpcRequest("wc_pushMessage", plaintextMessage);
      const encryptedMessage = await wallet.core.crypto.encode(topic, payload);

      const decryptedMessage = await wallet.decryptMessage({
        topic,
        encryptedMessage,
      });

      expect(decryptedMessage).toBe(plaintextMessage);
    });
  });
});

describe("Common (BaseClient)", () => {
  let wallet: IWalletClient;
  let dapp: IDappClient;

  beforeEach(async () => {
    wallet = await WalletClient.init({
      name: "testWalletClient",
      logger: "error",
      relayUrl:
        process.env.TEST_RELAY_URL || "wss://staging.relay.walletconnect.com",
      projectId: process.env.TEST_PROJECT_ID!,
      metadata: dappMetadata,
    });
    dapp = await DappClient.init({
      name: "testDappClientAsPeer",
      logger: "error",
      relayUrl:
        process.env.TEST_RELAY_URL || "wss://staging.relay.walletconnect.com",
      projectId: process.env.TEST_PROJECT_ID!,
      metadata: walletMetadata,
    });
  });
  afterEach(async () => {
    await disconnectSocket(wallet.core);
    await disconnectSocket(dapp.core);
  });

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
        account: "0xB68328542D0C08c47882D1276c7cC4D6fB9eAe71",
        pairingTopic,
      });

      await waitForEvent(() => gotPushRequest);

      dapp.once("push_response", (event) => {
        gotResponse = true;
        responseEvent = event;
      });

      await wallet.approve({ id });
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

  describe("delete", () => {
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
        account: "0xB68328542D0C08c47882D1276c7cC4D6fB9eAe71",
        pairingTopic,
      });

      await waitForEvent(() => gotPushRequest);

      dapp.once("push_response", (event) => {
        gotResponse = true;
        responseEvent = event;
      });

      await wallet.approve({ id });
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

      await wallet.delete({ topic: walletSubscriptionTopic });
      await waitForEvent(() => gotPushDelete);

      // Check that wallet is in expected state.
      expect(Object.keys(wallet.getActiveSubscriptions()).length).toBe(0);
      // Check that dapp is in expected state.
      expect(Object.keys(dapp.getActiveSubscriptions()).length).toBe(0);
    });
  });
});
