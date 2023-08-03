import { ICore, CoreTypes, IStore, RelayerTypes } from "@walletconnect/types";
import { ErrorResponse } from "@walletconnect/jsonrpc-utils";
import EventEmitter from "events";
import { Logger } from "pino";

import { INotifyEngine } from "./engine";
import { ISyncClient, SyncStore } from "@walletconnect/sync-client";

export declare namespace NotifyClientTypes {
  type Event =
    | "notify_subscription"
    | "notify_message"
    | "notify_delete"
    | "notify_update";

  type PushResponseEventArgs = {
    error?: ErrorResponse;
    subscription?: NotifyClientTypes.PushSubscription;
  };

  type PushMessageRequestEventArgs = { message: NotifyClientTypes.PushMessage };

  type PushDeleteRequestEventArgs = { id: number; topic: string };

  interface BaseEventArgs<T = unknown> {
    id: number;
    topic: string;
    params: T;
  }

  interface EventArguments {
    notify_subscription: BaseEventArgs<PushResponseEventArgs>;
    notify_message: BaseEventArgs<PushMessageRequestEventArgs>;
    notify_delete: BaseEventArgs<PushDeleteRequestEventArgs>;
    notify_update: BaseEventArgs<PushResponseEventArgs>;
  }

  interface WalletClientOptions extends CoreTypes.Options {
    core?: ICore;
    keyserverUrl?: string;
    syncClient: ISyncClient;
    SyncStoreController: typeof SyncStore;
  }

  interface Metadata {
    name: string;
    description: string;
    url: string;
    icons: string[];
    redirect?: {
      native?: string;
      universal?: string;
    };
  }

  type ScopeMap = Record<string, { description: string; enabled: boolean }>;

  interface PushSubscriptionRequest {
    publicKey: string;
    metadata: Metadata;
    account: string;
    scope: ScopeMap;
    scopeUpdate?: string[];
  }

  interface PushSubscription {
    topic: string;
    account: string;
    relay: RelayerTypes.ProtocolOptions;
    metadata: Metadata;
    scope: ScopeMap;
    expiry: number;
    symKey: string;
  }

  interface NotifyMessageJWTClaims {
    iat: number; // issued at
    exp: number; // expiry
    iss: string; // public key of cast server (did:key)
    ksu: string; // key server url
    aud: string; // blockchain account (did:pkh)
    act: string; // action intent (must be "notify_message")
    sub: string; // subscriptionId (sha256 hash of subscriptionAuth)
    app: string; // dapp domain url,
    msg: PushMessage;
  }

  interface PushMessage {
    title: string;
    body: string;
    icon: string;
    url: string;
    type?: string;
  }

  interface PushMessageRecord {
    id: number;
    topic: string;
    message: PushMessage;
    publishedAt: number;
  }

  interface PushDidDocument {
    "@context": string[];
    id: string;
    verificationMethod: Array<{
      id: string;
      type: string;
      controller: string;
      publicKeyJwk: {
        kty: string;
        crv: string;
        x: string;
      };
    }>;
    keyAgreement: string[];
  }

  interface PushConfigDocument {
    version: number;
    lastModified: number;
    types: Array<{
      name: string;
      description: string;
    }>;
  }
}

export abstract class IBaseClient {
  public abstract readonly protocol: string;
  public abstract readonly version: number;
  public abstract readonly name: string;

  public abstract core: ICore;
  public abstract events: EventEmitter;
  public abstract logger: Logger;
  public abstract engine: INotifyEngine;

  public abstract subscriptions: IStore<
    string,
    NotifyClientTypes.PushSubscription
  >;

  // ---------- Public Methods (common) ----------------------------------------------- //

  public abstract getActiveSubscriptions: INotifyEngine["getActiveSubscriptions"];

  public abstract deleteSubscription: INotifyEngine["deleteSubscription"];

  // ---------- Event Handlers ------------------------------------------------------- //

  public abstract emit: <E extends NotifyClientTypes.Event>(
    event: E,
    args: NotifyClientTypes.EventArguments[E]
  ) => boolean;

  public abstract on: <E extends NotifyClientTypes.Event>(
    event: E,
    listener: (args: NotifyClientTypes.EventArguments[E]) => void
  ) => EventEmitter;

  public abstract once: <E extends NotifyClientTypes.Event>(
    event: E,
    listener: (args: NotifyClientTypes.EventArguments[E]) => void
  ) => EventEmitter;

  public abstract off: <E extends NotifyClientTypes.Event>(
    event: E,
    listener: (args: NotifyClientTypes.EventArguments[E]) => void
  ) => EventEmitter;

  public abstract removeListener: <E extends NotifyClientTypes.Event>(
    event: E,
    listener: (args: NotifyClientTypes.EventArguments[E]) => void
  ) => EventEmitter;
}
