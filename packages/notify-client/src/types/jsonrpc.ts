export declare namespace JsonRpcTypes {
  export type WcMethod =
    | "wc_notifySubscribe"
    | "wc_notifyMessage"
    | "wc_notifyDelete"
    | "wc_notifyUpdate";

  // ---- JSON-RPC Requests -----------------------------
  export interface RequestParams {
    wc_notifySubscribe: {
      subscriptionAuth: string;
    };
    wc_notifyMessage: {
      messageAuth: string;
    };
    wc_notifyDelete: {
      code: number;
      message: string;
    };
    wc_notifyUpdate: {
      subscriptionAuth: string;
    };
  }

  // ---- JSON-RPC Responses -----------------------------
  export interface Results {
    wc_notifySubscribe: {
      publicKey: string;
    };
    wc_notifyMessage: true;
    wc_notifyDelete: true;
    wc_notifyUpdate: true;
  }
}
