import { FIVE_MINUTES, THIRTY_DAYS } from "@walletconnect/time";
import { JsonRpcTypes, RpcOpts } from "../types";

// Expiries
export const NOTIFY_SUBSCRIPTION_EXPIRY = THIRTY_DAYS;

// JWT-related constants
export const JWT_SCP_SEPARATOR = " ";

export const LIMITED_IDENTITY_STATEMENT =
  "I further authorize this DAPP to send and receive messages on my behalf for this domain using my WalletConnect identity.";
export const UNLIMITED_IDENTITY_STATEMENT =
  "I further authorize this WALLET to send and receive messages on my behalf for ALL domains using my WalletConnect identity.";

// RPC Options
export const ENGINE_RPC_OPTS: Record<JsonRpcTypes.WcMethod, RpcOpts> = {
  wc_notifySubscribe: {
    req: {
      ttl: FIVE_MINUTES,
      tag: 4000,
    },
    res: {
      ttl: THIRTY_DAYS,
      tag: 4001,
    },
  },
  wc_notifyMessage: {
    req: {
      ttl: THIRTY_DAYS,
      tag: 4002,
    },
    res: {
      ttl: THIRTY_DAYS,
      tag: 4003,
    },
  },
  wc_notifyDelete: {
    req: {
      ttl: THIRTY_DAYS,
      tag: 4004,
    },
    res: {
      ttl: THIRTY_DAYS,
      tag: 4005,
    },
  },
  wc_notifyUpdate: {
    req: {
      ttl: FIVE_MINUTES,
      tag: 4008,
    },
    res: {
      ttl: THIRTY_DAYS,
      tag: 4009,
    },
  },
  wc_notifyWatchSubscription: {
    req: {
      ttl: FIVE_MINUTES,
      tag: 4010,
    },
    res: {
      ttl: FIVE_MINUTES,
      tag: 4011,
    },
  },
  wc_notifySubscriptionsChanged: {
    req: {
      ttl: FIVE_MINUTES,
      tag: 4012,
    },
    res: {
      ttl: FIVE_MINUTES,
      tag: 4013,
    },
  },
};
