export declare namespace JsonRpcTypes {
  export type WcMethod = "wc_pushRequest" | "wc_pushMessage";

  // ---- JSON-RPC Requests -----------------------------
  export interface RequestParams {
    wc_pushRequest: {
      publicKey: string;
      account: string;
      // FIXME: use Metadata type
      metadata: any /*Metadata*/;
    };
    wc_pushMessage: {
      title: string;
      body: string;
      icon: string;
      url: string;
    };
  }

  // ---- JSON-RPC Responses -----------------------------
  export interface Results {
    wc_pushRequest: {
      publicKey: string;
    };
    wc_pushMessage: true;
  }
}
