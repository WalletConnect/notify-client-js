import { ONE_DAY, THIRTY_DAYS } from "@walletconnect/time";
import { JsonRpcTypes, RpcOpts } from "../types";

// Expiries
export const NOTIFY_REQUEST_EXPIRY = ONE_DAY;
export const NOTIFY_SUBSCRIPTION_EXPIRY = THIRTY_DAYS;

// JWT-related constants
export const JWT_SCP_SEPARATOR = " ";

// RPC Options
export const ENGINE_RPC_OPTS: Record<JsonRpcTypes.WcMethod, RpcOpts> = {
  wc_notifyMessage: {
    req: {
      ttl: THIRTY_DAYS,
      tag: 4002,
    },
    res: {
      ttl: ONE_DAY,
      tag: 4003,
    },
  },
  wc_notifyDelete: {
    req: {
      ttl: ONE_DAY,
      tag: 4004,
    },
    res: {
      ttl: ONE_DAY,
      tag: 4005,
    },
  },
  wc_notifySubscribe: {
    req: {
      ttl: ONE_DAY,
      tag: 4006,
    },
    res: {
      ttl: ONE_DAY,
      tag: 4007,
    },
  },
  wc_notifyUpdate: {
    req: {
      ttl: ONE_DAY,
      tag: 4008,
    },
    res: {
      ttl: ONE_DAY,
      tag: 4009,
    },
  },
};
