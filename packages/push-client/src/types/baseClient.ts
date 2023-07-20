import { ICore, CoreTypes, IStore, RelayerTypes } from "@walletconnect/types";
import { ErrorResponse } from "@walletconnect/jsonrpc-utils";
import EventEmitter from "events";
import { Logger } from "pino";

import { IPushEngine } from "./engine";
import { ISyncClient, SyncStore } from "@walletconnect/sync-client";

export declare namespace PushClientTypes {
  type Event =
    | "push_subscription"
    | "push_message"
    | "push_delete"
    | "push_update";

  type PushResponseEventArgs = {
    error?: ErrorResponse;
    subscription?: PushClientTypes.PushSubscription;
  };

  type PushMessageRequestEventArgs = { message: PushClientTypes.PushMessage };

  type PushDeleteRequestEventArgs = { id: number; topic: string };

  interface BaseEventArgs<T = unknown> {
    id: number;
    topic: string;
    params: T;
  }

  interface EventArguments {
    push_subscription: BaseEventArgs<PushResponseEventArgs>;
    push_message: BaseEventArgs<PushMessageRequestEventArgs>;
    push_delete: BaseEventArgs<PushDeleteRequestEventArgs>;
    push_update: BaseEventArgs<PushResponseEventArgs>;
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
  public abstract engine: IPushEngine;

  public abstract subscriptions: IStore<
    string,
    PushClientTypes.PushSubscription
  >;

  // ---------- Public Methods (common) ----------------------------------------------- //

  public abstract getActiveSubscriptions: IPushEngine["getActiveSubscriptions"];

  public abstract deleteSubscription: IPushEngine["deleteSubscription"];

  // ---------- Event Handlers ------------------------------------------------------- //

  public abstract emit: <E extends PushClientTypes.Event>(
    event: E,
    args: PushClientTypes.EventArguments[E]
  ) => boolean;

  public abstract on: <E extends PushClientTypes.Event>(
    event: E,
    listener: (args: PushClientTypes.EventArguments[E]) => void
  ) => EventEmitter;

  public abstract once: <E extends PushClientTypes.Event>(
    event: E,
    listener: (args: PushClientTypes.EventArguments[E]) => void
  ) => EventEmitter;

  public abstract off: <E extends PushClientTypes.Event>(
    event: E,
    listener: (args: PushClientTypes.EventArguments[E]) => void
  ) => EventEmitter;

  public abstract removeListener: <E extends PushClientTypes.Event>(
    event: E,
    listener: (args: PushClientTypes.EventArguments[E]) => void
  ) => EventEmitter;
}
