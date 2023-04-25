import { PushClientTypes } from "./baseClient";

export declare namespace JsonRpcTypes {
  export type WcMethod =
    | "wc_pushRequest"
    | "wc_pushSubscribe"
    | "wc_pushMessage"
    | "wc_pushDelete";

  // ---- JSON-RPC Requests -----------------------------
  export interface RequestParams {
    wc_pushRequest: {
      publicKey: string;
      account: string;
      metadata: PushClientTypes.Metadata;
    };
    wc_pushSubscribe: {
      subscriptionAuth: string;
    };
    wc_pushMessage: {
      title: string;
      body: string;
      icon: string;
      url: string;
    };
    wc_pushDelete: {
      code: number;
      message: string;
    };
  }

  // ---- JSON-RPC Responses -----------------------------
  export interface Results {
    wc_pushRequest: {
      subscriptionAuth: string;
    };
    wc_pushSubscribe: true;
    wc_pushMessage: true;
    wc_pushDelete: true;
  }
}
