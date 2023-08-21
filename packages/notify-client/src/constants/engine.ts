import { THIRTY_DAYS, THIRTY_SECONDS } from "@walletconnect/time";
import { JsonRpcTypes, RpcOpts } from "../types";

// Expiries
export const NOTIFY_SUBSCRIPTION_EXPIRY = THIRTY_DAYS;

// JWT-related constants
export const JWT_SCP_SEPARATOR = " ";

// RPC Options
export const ENGINE_RPC_OPTS: Record<JsonRpcTypes.WcMethod, RpcOpts> = {
  wc_notifySubscribe: {
    req: {
      ttl: THIRTY_SECONDS,
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
      ttl: THIRTY_SECONDS,
      tag: 4008,
    },
    res: {
      ttl: THIRTY_DAYS,
      tag: 4009,
    },
  },
};
