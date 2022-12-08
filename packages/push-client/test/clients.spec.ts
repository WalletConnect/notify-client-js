import { generateRandomBytes32 } from "@walletconnect/utils";
import { expect, describe, it, beforeEach, afterEach } from "vitest";
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

  it("can issue a `push_request` on a known pairing topic", async () => {
    // Set up known pairing.
    const pairingTopic = await setupKnownPairing(dapp, wallet);
    let gotPushRequest = false;
    let pushRequestEvent: any;

    wallet.on("push_request", (event) => {
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

      wallet.on("push_request", (event) => {
        gotPushRequest = true;
        pushRequestEvent = event;
      });

      const { id } = await dapp.request({
        account: "0xB68328542D0C08c47882D1276c7cC4D6fB9eAe71",
        pairingTopic,
      });

      await waitForEvent(() => gotPushRequest);

      dapp.on("push_response", (event) => {
        gotResponse = true;
        responseEvent = event;
      });

      await wallet.approve({ id });
      await waitForEvent(() => gotResponse);

      expect(responseEvent.params.result.publicKey).toBeDefined();

      // Check that wallet is in expected state.
      expect(wallet.subscriptions.length).toBe(1);
      expect(wallet.requests.length).toBe(0);
      // Check that dapp is in expected state.
      expect(dapp.subscriptions.length).toBe(1);
      expect(dapp.requests.length).toBe(0);
    });
  });
});
