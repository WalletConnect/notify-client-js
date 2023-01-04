import { ONE_DAY } from "@walletconnect/time";
import { JsonRpcTypes, RpcOpts } from "../types";

export const ENGINE_RPC_OPTS: Record<JsonRpcTypes.WcMethod, RpcOpts> = {
  wc_pushRequest: {
    req: {
      ttl: ONE_DAY,
      prompt: true,
      tag: 4000,
    },
    res: {
      ttl: ONE_DAY,
      prompt: false,
      tag: 4001,
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
