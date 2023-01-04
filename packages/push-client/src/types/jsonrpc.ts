export declare namespace JsonRpcTypes {
  export type WcMethod = "wc_pushRequest" | "wc_pushMessage" | "wc_pushDelete";

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
    wc_pushDelete: {
      code: number;
      message: string;
    };
  }

  // ---- JSON-RPC Responses -----------------------------
  export interface Results {
    wc_pushRequest: {
      publicKey: string;
    };
    wc_pushMessage: true;
    wc_pushDelete: true;
  }
}
