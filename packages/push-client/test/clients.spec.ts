import { formatJsonRpcRequest } from "@walletconnect/jsonrpc-utils";
import { generateRandomBytes32 } from "@walletconnect/utils";
import { expect, describe, it, beforeEach, afterEach, vi } from "vitest";
import {
  DappClient,
  WalletClient,
  IDappClient,
  IWalletClient,
  SDK_ERRORS,
} from "../src/";
import { disconnectSocket } from "./helpers/ws";

// @ts-expect-error
global.fetch = vi.fn(async () => ({
  status: 201,
  statusText: "Created",
}));

const dappMetadata = {
  name: "dapp (requester)",
  description: "Test DappClient as Requester",
  url: "www.walletconnect.com",
  icons: [],
};

const onSignMock = () =>
  Promise.resolve(
    "0x5cf19252d326699e9078686035cf8cb020aadf15cb817bb56bcd5605dc0068c15ebdd3230de9b61ab7973d0346b5933f0b0206894b1f6e4af4e2eb8162c52c1d1c"
  );

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

  await wallet.approve({ id, onSign: onSignMock });
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
      castUrl:
        process.env.TEST_CAST_URL || "https://staging.cast.walletconnect.com",
      projectId: process.env.TEST_PROJECT_ID!,
      metadata: dappMetadata,
    });
    wallet = await WalletClient.init({
      name: "testWalletClientAsPeer",
      logger: "error",
      relayUrl:
        process.env.TEST_RELAY_URL || "wss://staging.relay.walletconnect.com",
      projectId: process.env.TEST_PROJECT_ID!,
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
  let wallet: IWalletClient;
  let dapp: IDappClient;

  beforeEach(async () => {
    wallet = await WalletClient.init({
      name: "testWalletClient",
      logger: "error",
      relayUrl:
        process.env.TEST_RELAY_URL || "wss://staging.relay.walletconnect.com",
      projectId: process.env.TEST_PROJECT_ID!,
    });
    dapp = await DappClient.init({
      name: "testDappClientAsPeer",
      logger: "error",
      relayUrl:
        process.env.TEST_RELAY_URL || "wss://staging.relay.walletconnect.com",
      castUrl:
        process.env.TEST_CAST_URL || "https://staging.cast.walletconnect.com",
      projectId: process.env.TEST_PROJECT_ID!,
      metadata: dappMetadata,
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

      await wallet.approve({ id, onSign: onSignMock });
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

      expect(Object.values(wallet.messages.get(topic).messages).length).toBe(0);
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
    });
    dapp = await DappClient.init({
      name: "testDappClientAsPeer",
      logger: "error",
      relayUrl:
        process.env.TEST_RELAY_URL || "wss://staging.relay.walletconnect.com",
      castUrl:
        process.env.TEST_CAST_URL || "https://staging.cast.walletconnect.com",
      projectId: process.env.TEST_PROJECT_ID!,
      metadata: dappMetadata,
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
        account: "0xB68328542D0C08c47882D1276c7cC4D6fB9eAe71",
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
