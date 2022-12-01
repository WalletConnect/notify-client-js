import { ICore, CoreTypes } from "@walletconnect/types";
import { JsonRpcError, JsonRpcResult } from "@walletconnect/jsonrpc-utils";
import EventEmitter from "events";
import { Logger } from "pino";

import { IPushEngine } from "./engine";

export declare namespace PushClientTypes {
  type Event = "push_request" | "push_response";

  // FIXME: specify non-`any` type
  type PushRequestEventArgs = any;

  // FIXME: specify non-`any` type
  type PushResponseEventArgs = JsonRpcResult<any> | JsonRpcError;

  interface BaseEventArgs<T = unknown> {
    id: number;
    topic: string;
    params: T;
  }

  interface EventArguments {
    push_request: BaseEventArgs<PushRequestEventArgs>;
    push_response: BaseEventArgs<PushResponseEventArgs>;
  }

  interface Options extends CoreTypes.Options {
    metadata: Metadata;
    core?: ICore;
    projectId: string;
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
}

export abstract class IBaseClient {
  public abstract readonly protocol: string;
  public abstract readonly version: number;
  public abstract readonly name: string;

  public abstract core: ICore;
  public abstract metadata: PushClientTypes.Metadata;
  public abstract projectId: string;
  public abstract events: EventEmitter;
  public abstract logger: Logger;
  public abstract engine: IPushEngine;

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
