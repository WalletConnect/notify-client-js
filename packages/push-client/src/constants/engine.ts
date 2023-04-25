import { ONE_DAY, THIRTY_DAYS } from "@walletconnect/time";
import { JsonRpcTypes, RpcOpts } from "../types";

export const PUSH_REQUEST_EXPIRY = ONE_DAY;
export const PUSH_SUBSCRIPTION_EXPIRY = THIRTY_DAYS;

export const ENGINE_RPC_OPTS: Record<JsonRpcTypes.WcMethod, RpcOpts> = {
  wc_pushRequest: {
    req: {
      ttl: PUSH_REQUEST_EXPIRY,
      prompt: true,
      tag: 4000,
    },
    res: {
      ttl: PUSH_REQUEST_EXPIRY,
      prompt: false,
      tag: 4001,
    },
  },
  wc_pushSubscribe: {
    req: {
      ttl: ONE_DAY,
      prompt: true,
      tag: 4006,
    },
    res: {
      ttl: ONE_DAY,
      prompt: false,
      tag: 4007,
    },
  },
  wc_pushMessage: {
    req: {
      ttl: ONE_DAY,
      prompt: true,
      tag: 4002,
    },
    res: {
      ttl: ONE_DAY,
      prompt: false,
      tag: 4003,
    },
  },
  wc_pushDelete: {
    req: {
      ttl: ONE_DAY,
      prompt: true,
      tag: 4004,
    },
    res: {
      ttl: ONE_DAY,
      prompt: false,
      tag: 4005,
    },
  },
};
