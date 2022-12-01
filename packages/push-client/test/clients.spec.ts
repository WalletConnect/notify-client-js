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
  let client: IDappClient;
  let peer: IWalletClient;

  beforeEach(async () => {
    client = await DappClient.init({
      name: "testDappClient",
      logger: "error",
      relayUrl:
        process.env.TEST_RELAY_URL || "wss://staging.relay.walletconnect.com",
      projectId: process.env.TEST_PROJECT_ID!,
      metadata: dappMetadata,
    });
    peer = await WalletClient.init({
      name: "testWalletClientAsPeer",
      logger: "error",
      relayUrl:
        process.env.TEST_RELAY_URL || "wss://staging.relay.walletconnect.com",
      projectId: process.env.TEST_PROJECT_ID!,
      metadata: walletMetadata,
    });
  });
  afterEach(async () => {
    await disconnectSocket(client.core);
    await disconnectSocket(peer.core);
  });
  it("can be instantiated", () => {
    expect(client instanceof DappClient).toBe(true);
    expect(client.core).toBeDefined();
    expect(client.events).toBeDefined();
    expect(client.logger).toBeDefined();
    expect(client.core.expirer).toBeDefined();
    expect(client.core.history).toBeDefined();
    expect(client.core.pairing).toBeDefined();
  });
});

describe("WalletClient", () => {
  let client: IWalletClient;
  let peer: IDappClient;

  beforeEach(async () => {
    client = await WalletClient.init({
      name: "testWalletClient",
      logger: "error",
      relayUrl:
        process.env.TEST_RELAY_URL || "wss://staging.relay.walletconnect.com",
      projectId: process.env.TEST_PROJECT_ID!,
      metadata: dappMetadata,
    });
    peer = await DappClient.init({
      name: "testDappClientAsPeer",
      logger: "error",
      relayUrl:
        process.env.TEST_RELAY_URL || "wss://staging.relay.walletconnect.com",
      projectId: process.env.TEST_PROJECT_ID!,
      metadata: walletMetadata,
    });
  });
  afterEach(async () => {
    await disconnectSocket(client.core);
    await disconnectSocket(peer.core);
  });
  it("can be instantiated", () => {
    expect(client instanceof WalletClient).toBe(true);
    expect(client.core).toBeDefined();
    expect(client.events).toBeDefined();
    expect(client.logger).toBeDefined();
    expect(client.core.expirer).toBeDefined();
    expect(client.core.history).toBeDefined();
    expect(client.core.pairing).toBeDefined();
  });
});
