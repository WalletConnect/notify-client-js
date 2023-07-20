export declare namespace JsonRpcTypes {
  export type WcMethod =
    | "wc_pushSubscribe"
    | "wc_pushMessage"
    | "wc_pushDelete"
    | "wc_pushUpdate";

  // ---- JSON-RPC Requests -----------------------------
  export interface RequestParams {
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
  }

  // ---- JSON-RPC Responses -----------------------------
  export interface Results {
    wc_pushSubscribe: {
      publicKey: string;
    };
    wc_pushMessage: true;
    wc_pushDelete: true;
    wc_pushUpdate: true;
  }
}
