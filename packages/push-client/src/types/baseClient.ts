import { ICore, CoreTypes, IStore, RelayerTypes } from "@walletconnect/types";
import { JsonRpcError, JsonRpcResult } from "@walletconnect/jsonrpc-utils";
import EventEmitter from "events";
import { Logger } from "pino";

import { IPushEngine } from "./engine";

export declare namespace PushClientTypes {
  type Event =
    | "push_request"
    | "push_response"
    | "push_message"
    | "push_delete";

  // FIXME: specify non-`any` type
  type PushRequestEventArgs = any;

  // FIXME: specify non-`any` type
  type PushResponseEventArgs = JsonRpcResult<any> | JsonRpcError;

  type PushMessageRequestEventArgs = { message: PushClientTypes.PushMessage };

  type PushDeleteRequestEventArgs = { id: number; topic: string };

  interface BaseEventArgs<T = unknown> {
    id: number;
    topic: string;
    params: T;
  }

  interface EventArguments {
    push_request: BaseEventArgs<PushRequestEventArgs>;
    push_response: BaseEventArgs<PushResponseEventArgs>;
    push_message: BaseEventArgs<PushMessageRequestEventArgs>;
    push_delete: BaseEventArgs<PushDeleteRequestEventArgs>;
  }

  interface Options extends CoreTypes.Options {
    metadata: Metadata;
    core?: ICore;
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

  interface PushSubscription {
    topic: string;
    relay: RelayerTypes.ProtocolOptions;
    metadata?: Metadata;
  }

  interface PushMessage {
    title: string;
    body: string;
    icon: string;
    url: string;
  }
}

export abstract class IBaseClient {
  public abstract readonly protocol: string;
  public abstract readonly version: number;
  public abstract readonly name: string;

  public abstract core: ICore;
  public abstract metadata: PushClientTypes.Metadata;
  public abstract events: EventEmitter;
  public abstract logger: Logger;
  public abstract engine: IPushEngine;
  // FIXME: replace any typing here.
  public abstract requests: IStore<number, { topic: string; payload: any }>;
  // FIXME: replace any typing here.
  public abstract subscriptions: IStore<
    string,
    PushClientTypes.PushSubscription
  >;

  constructor(public opts: PushClientTypes.Options) {}

  // ---------- Public Methods (common) ----------------------------------------------- //

  public abstract getActiveSubscriptions: IPushEngine["getActiveSubscriptions"];
  public abstract delete: IPushEngine["delete"];

  // ---------- Event Handlers ----------------------------------------------- //

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
