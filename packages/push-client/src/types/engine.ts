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
import { IDappClient } from "./dappClient";

export interface RpcOpts {
  req: RelayerTypes.PublishOptions;
  res: RelayerTypes.PublishOptions;
}

export declare namespace PushEngineTypes {
  interface EventCallback<T extends JsonRpcRequest | JsonRpcResponse> {
    topic: string;
    payload: T;
    publishedAt: number;
    senderPublicKey?: string;
  }
}

export abstract class IPushEngine {
  constructor(public client: IWalletClient | IDappClient) {}

  public abstract init(): void;

  // ---------- Public Methods (dapp) ----------------------------------- //

  // request push subscription
  public abstract request(params: {
    account: string;
    pairingTopic: string;
  }): Promise<{ id: number }>;

  // propose push subscription
  public abstract propose(params: {
    account: string;
    pairingTopic: string;
    scope?: string[];
  }): Promise<{ id: number }>;

  // send push notification message
  public abstract notify(params: {
    topic: string;
    message: PushClientTypes.PushMessage;
  }): Promise<void>;

  // ---------- Public Methods (wallet) --------------------------------- //

  // approve push subscription
  public abstract approve(params: {
    id: number;
    onSign: (message: string) => Promise<string>;
  }): Promise<void>;

  // reject push subscription
  public abstract reject(params: { id: number; reason: string }): Promise<void>;

  public abstract subscribe(params: {
    metadata: PushClientTypes.Metadata;
    account: string;
    onSign: (message: string) => Promise<string>;
  }): Promise<boolean>;

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

  public abstract deletePushMessage(params: { id: number }): void;

  // ---------- Public Methods (common) --------------------------------- //

  // query all active subscriptions
  public abstract getActiveSubscriptions(): Record<
    string,
    PushClientTypes.PushSubscription
  >;

  // delete active subscription
  public abstract deleteSubscription(params: { topic: string }): Promise<void>;

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

  protected abstract onPushRequest(
    topic: string,
    payload: JsonRpcRequest<JsonRpcTypes.RequestParams["wc_pushRequest"]>
  ): Promise<void>;

  protected abstract onPushResponse(
    topic: string,
    payload:
      | JsonRpcResult<JsonRpcTypes.Results["wc_pushRequest"]>
      | JsonRpcError,
    senderPublicKey?: string
  ): void;

  protected abstract onPushProposeRequest(
    topic: string,
    payload: JsonRpcRequest<JsonRpcTypes.RequestParams["wc_pushPropose"]>
  ): Promise<void>;

  protected abstract onPushSubscribeResponse(
    topic: string,
    payload:
      | JsonRpcResult<JsonRpcTypes.Results["wc_pushSubscribe"]>
      | JsonRpcError
  ): Promise<void>;

  protected abstract onPushMessageRequest(
    topic: string,
    payload: JsonRpcRequest<JsonRpcTypes.RequestParams["wc_pushMessage"]>,
    publishedAt: number
  ): Promise<void>;

  protected abstract onPushMessageResponse(
    topic: string,
    payload:
      | JsonRpcResult<JsonRpcTypes.Results["wc_pushMessage"]>
      | JsonRpcError
  ): void;

  protected abstract onPushDeleteRequest(
    topic: string,
    payload: JsonRpcRequest<JsonRpcTypes.RequestParams["wc_pushDelete"]>
  ): Promise<void>;

  protected abstract onPushUpdateResponse(
    topic: string,
    payload: JsonRpcResult<JsonRpcTypes.Results["wc_pushUpdate"]> | JsonRpcError
  ): Promise<void>;
}
