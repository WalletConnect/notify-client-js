import { ONE_DAY, THIRTY_DAYS } from "@walletconnect/time";
import { JsonRpcTypes, RpcOpts } from "../types";

// Expiries
export const PUSH_REQUEST_EXPIRY = ONE_DAY;
export const PUSH_SUBSCRIPTION_EXPIRY = THIRTY_DAYS;

// JWT-related constants
export const JWT_SCP_SEPARATOR = " ";

// RPC Options
export const ENGINE_RPC_OPTS: Record<JsonRpcTypes.WcMethod, RpcOpts> = {
  wc_pushMessage: {
    req: {
      ttl: THIRTY_DAYS,
      tag: 4002,
    },
    res: {
      ttl: ONE_DAY,
      tag: 4003,
    },
  },
  wc_pushDelete: {
    req: {
      ttl: ONE_DAY,
      tag: 4004,
    },
    res: {
      ttl: ONE_DAY,
      tag: 4005,
    },
  },
  wc_pushSubscribe: {
    req: {
      ttl: ONE_DAY,
      tag: 4006,
    },
    res: {
      ttl: ONE_DAY,
      tag: 4007,
    },
  },
  wc_pushUpdate: {
    req: {
      ttl: ONE_DAY,
      tag: 4008,
    },
    res: {
      ttl: ONE_DAY,
      tag: 4009,
    },
  },
  wc_pushPropose: {
    req: {
      ttl: ONE_DAY,
      tag: 4010,
    },
    res: {
      ttl: ONE_DAY,
      tag: 4011,
    },
  },
};
