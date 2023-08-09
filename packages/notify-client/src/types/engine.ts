import { RelayerTypes, CryptoTypes } from "@walletconnect/types";
import {
  ErrorResponse,
  JsonRpcError,
  JsonRpcRequest,
  JsonRpcResponse,
  JsonRpcResult,
} from "@walletconnect/jsonrpc-utils";
import { JsonRpcTypes } from "./jsonrpc";
import { NotifyClientTypes } from "./client";
import { INotifyClient } from "./client";

export interface RpcOpts {
  req: RelayerTypes.PublishOptions;
  res: RelayerTypes.PublishOptions;
}

export declare namespace NotifyEngineTypes {
  interface EventCallback<T extends JsonRpcRequest | JsonRpcResponse> {
    topic: string;
    payload: T;
    publishedAt: number;
  }
}

export abstract class INotifyEngine {
  constructor(public client: INotifyClient) {}

  public abstract init(): void;

  // ---------- Public Methods ------------------------------------------ //

  public abstract enableSync(params: {
    account: string;
    onSign: (message: string) => Promise<string>;
  }): Promise<void>;

  public abstract subscribe(params: {
    metadata: NotifyClientTypes.Metadata;
    account: string;
    onSign: (message: string) => Promise<string>;
  }): Promise<{ id: number; subscriptionAuth: string }>;

  public abstract update(params: {
    topic: string;
    scope: string[];
  }): Promise<boolean>;

  // decrypt notify subscription message
  public abstract decryptMessage(params: {
    topic: string;
    encryptedMessage: string;
  }): Promise<NotifyClientTypes.NotifyMessage>;

  // get all messages for a subscription
  public abstract getMessageHistory(params: {
    topic: string;
  }): Record<number, NotifyClientTypes.NotifyMessageRecord>;

  // delete active subscription
  public abstract deleteSubscription(params: { topic: string }): Promise<void>;

  public abstract deleteNotifyMessage(params: { id: number }): void;

  // ---------- Public Methods ------------------------------------------ //

  // query all active subscriptions
  public abstract getActiveSubscriptions(params?: {
    account: string;
  }): Record<string, NotifyClientTypes.NotifySubscription>;

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
    event: NotifyEngineTypes.EventCallback<JsonRpcRequest>
  ): void;

  protected abstract onRelayEventResponse(
    event: NotifyEngineTypes.EventCallback<JsonRpcResponse>
  ): Promise<void>;

  // ---------- Protected Relay Event Handlers --------------------------------- //

  protected abstract onNotifySubscribeResponse(
    topic: string,
    payload:
      | JsonRpcResult<JsonRpcTypes.Results["wc_notifySubscribe"]>
      | JsonRpcError
  ): Promise<void>;

  protected abstract onNotifyMessageRequest(
    topic: string,
    payload: JsonRpcRequest<JsonRpcTypes.RequestParams["wc_notifyMessage"]>,
    publishedAt: number
  ): Promise<void>;

  protected abstract onNotifyMessageResponse(
    topic: string,
    payload:
      | JsonRpcResult<JsonRpcTypes.Results["wc_notifyMessage"]>
      | JsonRpcError
  ): void;

  protected abstract onNotifyDeleteRequest(
    topic: string,
    payload: JsonRpcRequest<JsonRpcTypes.RequestParams["wc_notifyDelete"]>
  ): Promise<void>;

  protected abstract onNotifyUpdateResponse(
    topic: string,
    payload:
      | JsonRpcResult<JsonRpcTypes.Results["wc_notifyUpdate"]>
      | JsonRpcError
  ): Promise<void>;
}