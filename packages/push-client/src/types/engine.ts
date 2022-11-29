import { RelayerTypes, CryptoTypes } from "@walletconnect/types";

import {
  ErrorResponse,
  JsonRpcError,
  JsonRpcRequest,
  JsonRpcResponse,
  JsonRpcResult,
} from "@walletconnect/jsonrpc-utils";
import { JsonRpcTypes } from "./jsonrpc";

export interface RpcOpts {
  req: RelayerTypes.PublishOptions;
  res: RelayerTypes.PublishOptions;
}

export declare namespace PushEngineTypes {
  interface EventCallback<T extends JsonRpcRequest | JsonRpcResponse> {
    topic: string;
    payload: T;
  }
}

export abstract class IPushEngine {
  // FIXME: add client types
  constructor(public client: any /*IWalletPushClient | IDappPushClient*/) {}

  public abstract init(): void;

  // ---------- Public Methods (dapp) ----------------------------------- //

  // request push subscription
  public abstract request(params: {
    account: string;
    pairingTopic: string;
  }): Promise<{ id: string }>;

  // send push notification message
  // FIXME: add PushMessage type
  public abstract notify(params: {
    topic: string;
    message: any /*PushMessage*/;
  }): Promise<void>;

  // ---------- Public Methods (wallet) --------------------------------- //

  // approve push subscription
  public abstract approve(params: {}): Promise<boolean>;

  // reject push subscription
  public abstract reject(params: { reason: string }): Promise<boolean>;

  // decrypt push subscription message
  // FIXME: add PushMessage type
  public abstract decryptMessage(
    topic: string,
    encryptedMessage: string
  ): Promise</*PushMessage*/ any>;

  // ---------- Public Methods (common) --------------------------------- //

  // query all active subscriptions
  // FIXME: add PushSubscription type
  public abstract getActiveSubscriptions(): Promise<
    Record<string, any /*PushSubscription*/>
  >;

  // delete active subscription
  public abstract delete(params: { topic: string }): Promise<void>;

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
      | JsonRpcError
  ): void;
}
