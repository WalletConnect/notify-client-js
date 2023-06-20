import { ICore, CoreTypes, IStore, RelayerTypes } from "@walletconnect/types";
import { ErrorResponse } from "@walletconnect/jsonrpc-utils";
import EventEmitter from "events";
import { Logger } from "pino";

import { IPushEngine } from "./engine";
import { ISyncClient, SyncStore } from "@walletconnect/sync-client";

export declare namespace PushClientTypes {
  type Event =
    | "push_response"
    | "push_proposal"
    | "push_subscription"
    | "push_message"
    | "push_delete"
    | "push_update";

  type PushRequestEventArgs = {
    id: number;
    account: string;
    metadata: Metadata;
  };

  type PushProposalRequestEventArgs = {
    id: number;
    account: string;
    metadata: Metadata;
  };

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
    push_request: BaseEventArgs<PushRequestEventArgs>;
    push_proposal: BaseEventArgs<PushProposalRequestEventArgs>;
    push_response: BaseEventArgs<PushResponseEventArgs>;
    push_subscription: BaseEventArgs<PushResponseEventArgs>;
    push_message: BaseEventArgs<PushMessageRequestEventArgs>;
    push_delete: BaseEventArgs<PushDeleteRequestEventArgs>;
    push_update: BaseEventArgs<PushResponseEventArgs>;
  }

  interface DappClientOptions extends CoreTypes.Options {
    metadata: Metadata;
    castUrl?: string;
    core?: ICore;
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

  interface PushProposal {
    publicKey: string;
    metadata: PushClientTypes.Metadata;
    account: string;
    scope: string[];
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

  public abstract proposals: IStore<
    number,
    {
      topic: string;
      proposal: PushClientTypes.PushProposal;
    }
  >;
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

  // ---------- Helpers  ------------------------------------------------------------ //
  public abstract initSyncStores: (params: {
    account: string;
    signature: string;
  }) => Promise<void>;
}
