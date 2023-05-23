import { PushClientTypes } from "./baseClient";

export declare namespace JsonRpcTypes {
  export type WcMethod =
    | "wc_pushRequest"
    | "wc_pushPropose"
    | "wc_pushSubscribe"
    | "wc_pushMessage"
    | "wc_pushDelete"
    | "wc_pushUpdate";

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
      type?: string;
    };
    wc_pushDelete: {
      code: number;
      message: string;
    };
    wc_pushUpdate: {
      subscriptionAuth: string;
    };
    wc_pushPropose: {
      publicKey: string;
      account: string;
      metadata: PushClientTypes.Metadata;
      scope: string[];
    };
  }

  // ---- JSON-RPC Responses -----------------------------
  export interface Results {
    wc_pushRequest: {
      subscriptionAuth: string;
    };
    wc_pushSubscribe: {
      publicKey: string;
    };
    wc_pushMessage: true;
    wc_pushDelete: true;
    wc_pushUpdate: true;
    wc_pushPropose: {
      subscriptionAuth: string;
    };
  }
}
