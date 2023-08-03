import { RelayerTypes, CryptoTypes } from "@walletconnect/types";

import {
  ErrorResponse,
  JsonRpcError,
  JsonRpcRequest,
  JsonRpcResponse,
  JsonRpcResult,
} from "@walletconnect/jsonrpc-utils";
import { JsonRpcTypes } from "./jsonrpc";
import { PushClientTypes } from "./baseClient";
import { IWalletClient } from "./walletClient";

export interface RpcOpts {
  req: RelayerTypes.PublishOptions;
  res: RelayerTypes.PublishOptions;
}

export declare namespace PushEngineTypes {
  interface EventCallback<T extends JsonRpcRequest | JsonRpcResponse> {
    topic: string;
    payload: T;
    publishedAt: number;
  }
}

export abstract class IPushEngine {
  constructor(public client: IWalletClient) {}

  public abstract init(): void;

  // ---------- Public Methods ------------------------------------------ //

  public abstract enableSync(params: {
    account: string;
    onSign: (message: string) => Promise<string>;
  }): Promise<void>;

  public abstract subscribe(params: {
    metadata: PushClientTypes.Metadata;
    account: string;
    onSign: (message: string) => Promise<string>;
  }): Promise<{ id: number; subscriptionAuth: string }>;

  public abstract update(params: {
    topic: string;
    scope: string[];
  }): Promise<boolean>;

  // decrypt push subscription message
  public abstract decryptMessage(params: {
    topic: string;
    encryptedMessage: string;
  }): Promise<PushClientTypes.PushMessage>;

  // get all messages for a subscription
  public abstract getMessageHistory(params: {
    topic: string;
  }): Record<number, PushClientTypes.PushMessageRecord>;

  // delete active subscription
  public abstract deleteSubscription(params: { topic: string }): Promise<void>;

  public abstract deletePushMessage(params: { id: number }): void;

  // ---------- Public Methods ------------------------------------------ //

  // query all active subscriptions
  public abstract getActiveSubscriptions(params?: {
    account: string;
  }): Record<string, PushClientTypes.PushSubscription>;

  // ---------- Protected Helpers --------------------------------------- //

  protected abstract sendRequest<M extends JsonRpcTypes.WcMethod>(
    topic: string,
    method: M,
    params: JsonRpcTypes.RequestParams[M],
    encodeOpts?: CryptoTypes.EncodeOptions
  ): Promise<number>;

  protected abstract sendResult<M extends JsonRpcTypes.WcMethod>(
    id: number,
    topic: string,
    result: JsonRpcTypes.Results[M],
    encodeOpts?: CryptoTypes.EncodeOptions
  ): Promise<number>;

  protected abstract sendError(
    id: number,
    topic: string,
    error: ErrorResponse,
    opts?: CryptoTypes.EncodeOptions
  ): Promise<number>;

  protected abstract setExpiry(topic: string, expiry: number): Promise<void>;

  // ---------- Protected Relay Event Methods ----------------------------------- //

  protected abstract onRelayEventRequest(
    event: PushEngineTypes.EventCallback<JsonRpcRequest>
  ): void;

  protected abstract onRelayEventResponse(
    event: PushEngineTypes.EventCallback<JsonRpcResponse>
  ): Promise<void>;

  // ---------- Protected Relay Event Handlers --------------------------------- //

  protected abstract onPushSubscribeResponse(
    topic: string,
    payload:
      | JsonRpcResult<JsonRpcTypes.Results["wc_notifySubscribe"]>
      | JsonRpcError
  ): Promise<void>;

  protected abstract onPushMessageRequest(
    topic: string,
    payload: JsonRpcRequest<JsonRpcTypes.RequestParams["wc_notifyMessage"]>,
    publishedAt: number
  ): Promise<void>;

  protected abstract onPushMessageResponse(
    topic: string,
    payload:
      | JsonRpcResult<JsonRpcTypes.Results["wc_notifyMessage"]>
      | JsonRpcError
  ): void;

  protected abstract onPushDeleteRequest(
    topic: string,
    payload: JsonRpcRequest<JsonRpcTypes.RequestParams["wc_notifyDelete"]>
  ): Promise<void>;

  protected abstract onPushUpdateResponse(
    topic: string,
    payload:
      | JsonRpcResult<JsonRpcTypes.Results["wc_notifyUpdate"]>
      | JsonRpcError
  ): Promise<void>;
}
