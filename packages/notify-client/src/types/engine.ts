import {
  ErrorResponse,
  JsonRpcError,
  JsonRpcRequest,
  JsonRpcResponse,
  JsonRpcResult,
} from "@walletconnect/jsonrpc-utils";
import { CryptoTypes } from "@walletconnect/types";
import { INotifyClient, NotifyClientTypes } from "./client";
import { JsonRpcTypes } from "./jsonrpc";
import EventEmitter from "events";
import { CacaoSignature } from "@walletconnect/cacao";
import { IdentityKeys } from "@walletconnect/identity-keys";

export interface RpcOpts {
  req: { ttl: number; tag: number };
  res: { ttl: number; tag: number };
}

export type SupportedSignatureTypes = CacaoSignature["t"];

export declare namespace NotifyEngineTypes {
  interface EventCallback<T extends JsonRpcRequest | JsonRpcResponse> {
    topic: string;
    payload: T;
    publishedAt: number;
  }

  type EventResponseOrError<T> = { topic: string } & (
    | (T & { error: null })
    | {
        error: string;
      }
  );

  type Event =
    | "notify_get_notifications_response"
    | "notify_mark_notifications_as_read_response";

  interface EventArguments {
    notify_mark_notifications_as_read_response: EventResponseOrError<{}>;
    notify_get_notifications_response: EventResponseOrError<{
      notifications: NotifyClientTypes.NotifyNotification[];
      hasMore: boolean;
      hasMoreUnread: boolean;
    }>;
  }
}

export abstract class INotifyEngine {
  constructor(public client: INotifyClient) {}

  public abstract init(): Promise<void>;

  // ---------- Public Methods ------------------------------------------ //

  public abstract hasFinishedInitialLoad(): boolean;

  public abstract prepareRegistrationWithRecaps(params: {
    domain: string;
    allApps?: boolean;
  }): Promise<
    Awaited<ReturnType<IdentityKeys["prepareRegistrationWithRecaps"]>> & {
      allApps: boolean;
    }
  >;

  public abstract prepareRegistration(params: {
    account: string;
    domain: string;
    allApps?: boolean;
  }): Promise<{
    registerParams: NotifyClientTypes.NotifyRegistrationParams;
    message: string;
  }>;

  public abstract register(params: {
    registerParams: NotifyClientTypes.NotifyRegistrationParams;
    signature: string;
    signatureType?: SupportedSignatureTypes;
  }): Promise<string>;

  public abstract isRegistered(params: {
    account: string;
    allApps?: boolean;
    domain: string;
  }): boolean;

  public abstract unregister(params: { account: string }): Promise<void>;

  public abstract subscribe(params: {
    appDomain: string;
    account: string;
  }): Promise<boolean>;

  public abstract update(params: {
    topic: string;
    scope: string[];
  }): Promise<boolean>;

  // decrypt notify subscription message
  public abstract decryptMessage(params: {
    topic: string;
    encryptedMessage: string;
  }): Promise<NotifyClientTypes.NotifyNotification>;

  public abstract markNotificationsAsRead(params: {
    topic: string;
    notificationIds: string[];
  }): Promise<void>;

  public abstract markAllNotificationsAsRead(params: {
    topic: string;
  }): Promise<void>;

  // delete active subscription
  public abstract deleteSubscription(params: { topic: string }): Promise<void>;

  public abstract deleteNotifyMessage(params: { id: number }): void;

  public abstract getNotificationHistory(params: {
    topic: string;
    limit?: number;
    startingAfter?: string;
    unreadFirst?: boolean;
  }): Promise<{
    notifications: NotifyClientTypes.NotifyNotification[];
    hasMore: boolean;
    hasMoreUnread: boolean;
  }>;

  // get notification types for a specific subscription
  public abstract getNotificationTypes(params: {
    appDomain: string;
  }): NotifyClientTypes.ScopeMap;

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

  protected abstract onNotifyDeleteResponse(
    topic: string,
    payload:
      | JsonRpcResult<JsonRpcTypes.Results["wc_notifyDelete"]>
      | JsonRpcError
  ): void;

  protected abstract onNotifyWatchSubscriptionsResponse(
    topic: string,
    payload:
      | JsonRpcResult<JsonRpcTypes.Results["wc_notifyWatchSubscription"]>
      | JsonRpcError
  ): Promise<void>;

  protected abstract onNotifySubscriptionsChangedRequest(
    topic: string,
    payload: JsonRpcRequest<
      JsonRpcTypes.RequestParams["wc_notifySubscriptionsChanged"]
    >
  ): Promise<void>;

  protected abstract onNotifyUpdateResponse(
    topic: string,
    payload:
      | JsonRpcResult<JsonRpcTypes.Results["wc_notifyUpdate"]>
      | JsonRpcError
  ): Promise<void>;

  protected abstract onNotifyGetNotificationsResponse(
    topic: string,
    payload:
      | JsonRpcResult<JsonRpcTypes.Results["wc_notifyGetNotifications"]>
      | JsonRpcError
  ): Promise<void>;

  protected abstract onNotifyMarkNotificationsAsReadResponse(
    topic: string,
    payload:
      | JsonRpcResult<JsonRpcTypes.Results["wc_notifyMarkNotificationsAsRead"]>
      | JsonRpcError
  ): Promise<void>;

  protected abstract on: <E extends NotifyEngineTypes.Event>(
    event: E,
    listener: (args: NotifyEngineTypes.EventArguments[E]) => void
  ) => EventEmitter;

  protected abstract once: <E extends NotifyEngineTypes.Event>(
    event: E,
    listener: (args: NotifyEngineTypes.EventArguments[E]) => void
  ) => EventEmitter;

  protected abstract off: <E extends NotifyEngineTypes.Event>(
    event: E,
    listener: (args: NotifyEngineTypes.EventArguments[E]) => void
  ) => EventEmitter;

  protected abstract emit: <E extends NotifyEngineTypes.Event>(
    event: E,
    args: NotifyEngineTypes.EventArguments[E]
  ) => boolean;
}
