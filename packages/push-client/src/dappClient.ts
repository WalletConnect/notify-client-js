import pino from "pino";
import { Core, Store } from "@walletconnect/core";
import {
  generateChildLogger,
  getDefaultLoggerOptions,
  getLoggerContext,
} from "@walletconnect/logger";
import { EventEmitter } from "events";

import { PushEngine } from "./controllers";
import { IDappClient, PushClientTypes } from "./types";
import {
  PUSH_DAPP_CLIENT_DEFAULT_NAME,
  PUSH_CLIENT_PROTOCOL,
  PUSH_CLIENT_VERSION,
  PUSH_CLIENT_STORAGE_PREFIX,
} from "./constants";

// @ts-expect-error - `IDappClient` not yet fully implemented.
export class DappClient extends IDappClient {
  public readonly protocol = PUSH_CLIENT_PROTOCOL;
  public readonly version = PUSH_CLIENT_VERSION;
  public readonly name: IDappClient["name"] = PUSH_DAPP_CLIENT_DEFAULT_NAME;
  public readonly metadata: IDappClient["metadata"];

  public core: IDappClient["core"];
  public logger: IDappClient["logger"];
  public events: IDappClient["events"] = new EventEmitter();
  public engine: IDappClient["engine"];
  public requests: IDappClient["requests"];
  public subscriptions: IDappClient["subscriptions"];

  static async init(opts: PushClientTypes.Options) {
    const client = new DappClient(opts);
    await client.initialize();

    return client;
  }

  constructor(opts: PushClientTypes.Options) {
    super(opts);

    this.name = opts.name || PUSH_DAPP_CLIENT_DEFAULT_NAME;
    this.metadata = opts.metadata;

    const logger =
      typeof opts.logger !== "undefined" && typeof opts.logger !== "string"
        ? opts.logger
        : pino(
            getDefaultLoggerOptions({
              level: opts.logger || "error",
            })
          );

    this.core = opts.core || new Core(opts);
    this.logger = generateChildLogger(logger, this.name);
    this.requests = new Store(
      this.core,
      this.logger,
      "requests",
      PUSH_CLIENT_STORAGE_PREFIX
    );
    this.subscriptions = new Store(
      this.core,
      this.logger,
      "subscriptions",
      PUSH_CLIENT_STORAGE_PREFIX
    );
    this.engine = new PushEngine(this);
  }

  get context() {
    return getLoggerContext(this.logger);
  }

  get pairing() {
    return this.core.pairing.pairings;
  }

  // ---------- Engine ----------------------------------------------- //

  public request: IDappClient["request"] = async (params) => {
    try {
      return await this.engine.request(params);
    } catch (error: any) {
      this.logger.error(error.message);
      throw error;
    }
  };

  public notify: IDappClient["notify"] = async (params) => {
    try {
      return await this.engine.notify(params);
    } catch (error: any) {
      this.logger.error(error.message);
      throw error;
    }
  };

  public getActiveSubscriptions: IDappClient["getActiveSubscriptions"] = () => {
    try {
      return this.engine.getActiveSubscriptions();
    } catch (error: any) {
      this.logger.error(error.message);
      throw error;
    }
  };

  public delete: IDappClient["delete"] = async (params) => {
    try {
      return await this.engine.delete(params);
    } catch (error: any) {
      this.logger.error(error.message);
      throw error;
    }
  };

  // ---------- Events ----------------------------------------------- //

  public emit: IDappClient["emit"] = (name, listener) => {
    return this.events.emit(name, listener);
  };

  public on: IDappClient["on"] = (name, listener) => {
    return this.events.on(name, listener);
  };

  public once: IDappClient["once"] = (name, listener) => {
    return this.events.once(name, listener);
  };

  public off: IDappClient["off"] = (name, listener) => {
    return this.events.off(name, listener);
  };

  public removeListener: IDappClient["removeListener"] = (name, listener) => {
    return this.events.removeListener(name, listener);
  };

  // ---------- Private ----------------------------------------------- //

  private async initialize() {
    this.logger.trace(`Initialized`);
    try {
      await this.core.start();
      await this.requests.init();
      await this.subscriptions.init();
      await this.engine.init();
      this.logger.info(`PushDappClient Initialization Success`);
    } catch (error: any) {
      this.logger.info(`PushDappClient Initialization Failure`);
      this.logger.error(error.message);
      throw error;
    }
  }
}
