import { ICore, CoreTypes, IStore, RelayerTypes } from "@walletconnect/types";
import { ErrorResponse } from "@walletconnect/jsonrpc-utils";
import EventEmitter from "events";
import { Logger } from "pino";
import { HistoryClient } from "@walletconnect/history";
import { IdentityKeys } from "@walletconnect/identity-keys";
import { ISyncClient, SyncStore } from "@walletconnect/sync-client";

import { INotifyEngine } from "./engine";

export declare namespace NotifyClientTypes {
  type Event =
    | "notify_subscription"
    | "notify_message"
    | "notify_delete"
    | "notify_update";

  type NotifyResponseEventArgs = {
    error?: ErrorResponse;
    subscription?: NotifyClientTypes.NotifySubscription;
  };

  type NotifyMessageRequestEventArgs = {
    message: NotifyClientTypes.NotifyMessage;
  };

  type NotifyDeleteRequestEventArgs = { id: number; topic: string };

  interface BaseEventArgs<T = unknown> {
    id: number;
    topic: string;
    params: T;
  }

  interface EventArguments {
    notify_subscription: BaseEventArgs<NotifyResponseEventArgs>;
    notify_message: BaseEventArgs<NotifyMessageRequestEventArgs>;
    notify_delete: BaseEventArgs<NotifyDeleteRequestEventArgs>;
    notify_update: BaseEventArgs<NotifyResponseEventArgs>;
  }

  interface BaseJwtClaims {
    act: string; // action intent
    iat: number; // issued at
    exp: number; // expiry
    ksu: string; // key server url
  }

  interface ClientOptions extends CoreTypes.Options {
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

  interface NotifySubscriptionRequest {
    publicKey: string;
    metadata: Metadata;
    account: string;
    scope: ScopeMap;
    scopeUpdate?: string[];
  }

  interface NotifySubscription {
    topic: string;
    account: string;
    relay: RelayerTypes.ProtocolOptions;
    metadata: Metadata;
    scope: ScopeMap;
    expiry: number;
    symKey: string;
  }

  interface NotifyMessage {
    title: string;
    body: string;
    icon: string;
    url: string;
    type?: string;
  }

  interface NotifyMessageRecord {
    id: number;
    topic: string;
    message: NotifyMessage;
    publishedAt: number;
  }

  interface MessageJWTClaims extends BaseJwtClaims {
    act: "notify_message"; // action intent (must be "notify_message")
    iss: string; // public key of cast server (did:key)
    aud: string; // blockchain account (did:pkh)
    sub: string; // subscriptionId (sha256 hash of subscriptionAuth)
    app: string; // dapp domain url,
    msg: NotifyMessage;
  }

  interface MessageReceiptJWTClaims extends BaseJwtClaims {
    act: "notify_receipt"; // description of action intent. Must be equal to "notify_receipt"
    iss: string; // did:key of an identity key. Enables to resolve attached blockchain account.
    aud: string; // did:key of an identity key. Enables to resolve associated Dapp domain used.
    sub: string; // hash of the stringified notify message object received
    app: string; // dapp's domain url
  }

  interface NotifyDidDocument {
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

  interface NotifyConfigDocument {
    version: number;
    lastModified: number;
    types: Array<{
      name: string;
      description: string;
    }>;
  }
}

export interface IdentityKeychain {
  accountId: string;
  identityKeyPub: string;
  identityKeyPriv: string;
}

export abstract class INotifyClient {
  public abstract readonly protocol: string;
  public abstract readonly version: number;
  public abstract readonly name: string;
  public abstract readonly keyserverUrl: string;

  public abstract core: ICore;
  public abstract events: EventEmitter;
  public abstract logger: Logger;
  public abstract engine: INotifyEngine;

  public abstract historyClient: HistoryClient;

  public abstract readonly syncClient: ISyncClient;
  public abstract readonly SyncStoreController: typeof SyncStore;

  public abstract requests: IStore<
    number,
    {
      topic: string;
      request: NotifyClientTypes.NotifySubscriptionRequest;
    }
  >;
  public abstract messages: IStore<
    string,
    {
      topic: string;
      messages: Record<number, NotifyClientTypes.NotifyMessageRecord>;
    }
  >;
  public abstract identityKeys: IdentityKeys;

  public abstract subscriptions: IStore<
    string,
    NotifyClientTypes.NotifySubscription
  >;

  constructor(public opts: NotifyClientTypes.ClientOptions) {}

  // ---------- Public Methods ------------------------------------------------------- //

  public abstract enableSync: INotifyEngine["enableSync"];
  public abstract subscribe: INotifyEngine["subscribe"];
  public abstract update: INotifyEngine["update"];
  public abstract decryptMessage: INotifyEngine["decryptMessage"];
  public abstract getMessageHistory: INotifyEngine["getMessageHistory"];
  public abstract deleteNotifyMessage: INotifyEngine["deleteNotifyMessage"];
  public abstract getActiveSubscriptions: INotifyEngine["getActiveSubscriptions"];
  public abstract deleteSubscription: INotifyEngine["deleteSubscription"];

  // ---------- Helpers  ------------------------------------------------------------- //

  public abstract initSyncStores: (params: {
    account: string;
    signature: string;
  }) => Promise<void>;

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
