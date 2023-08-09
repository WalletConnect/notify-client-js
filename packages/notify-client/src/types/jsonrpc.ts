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
      deleteAuth: string;
    };
    wc_notifyUpdate: {
      updateAuth: string;
    };
  }

  // ---- JSON-RPC Responses -----------------------------
  export interface Results {
    wc_notifySubscribe: {
      responseAuth: string;
    };
    wc_notifyMessage: { receiptAuth: string };
    wc_notifyDelete: true;
    wc_notifyUpdate: true;
  }
}
