import pino from "pino";
import { Core, Store } from "@walletconnect/core";
import {
  generateChildLogger,
  getDefaultLoggerOptions,
  getLoggerContext,
} from "@walletconnect/logger";
import { EventEmitter } from "events";

import { PushEngine } from "./controllers";
import { IWalletClient, PushClientTypes } from "./types";
import {
  PUSH_CLIENT_PROTOCOL,
  PUSH_CLIENT_STORAGE_PREFIX,
  PUSH_CLIENT_VERSION,
  PUSH_WALLET_CLIENT_DEFAULT_NAME,
} from "./constants";

// @ts-expect-error - `IWalletClient` not yet fully implemented.
export class WalletClient extends IWalletClient {
  public readonly protocol = PUSH_CLIENT_PROTOCOL;
  public readonly version = PUSH_CLIENT_VERSION;
  public readonly name: IWalletClient["name"] = PUSH_WALLET_CLIENT_DEFAULT_NAME;
  public readonly metadata: IWalletClient["metadata"];

  public core: IWalletClient["core"];
  public logger: IWalletClient["logger"];
  public events: IWalletClient["events"] = new EventEmitter();
  public engine: IWalletClient["engine"];
  public requests: IWalletClient["requests"];

  static async init(opts: PushClientTypes.Options) {
    const client = new WalletClient(opts);
    await client.initialize();

    return client;
  }

  constructor(opts: PushClientTypes.Options) {
    super(opts);

    this.name = opts.name || PUSH_WALLET_CLIENT_DEFAULT_NAME;
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
    this.engine = new PushEngine(this);
  }

  get context() {
    return getLoggerContext(this.logger);
  }

  get pairing() {
    return this.core.pairing.pairings;
  }

  // ---------- Engine ----------------------------------------------- //

  public approve: IWalletClient["approve"] = async (params) => {
    try {
      return await this.engine.approve(params);
    } catch (error: any) {
      this.logger.error(error.message);
      throw error;
    }
  };

  // ---------- Events ----------------------------------------------- //

  public emit: IWalletClient["emit"] = (name, listener) => {
    return this.events.emit(name, listener);
  };

  public on: IWalletClient["on"] = (name, listener) => {
    return this.events.on(name, listener);
  };

  public once: IWalletClient["once"] = (name, listener) => {
    return this.events.once(name, listener);
  };

  public off: IWalletClient["off"] = (name, listener) => {
    return this.events.off(name, listener);
  };

  public removeListener: IWalletClient["removeListener"] = (name, listener) => {
    return this.events.removeListener(name, listener);
  };

  // ---------- Private ----------------------------------------------- //

  private async initialize() {
    this.logger.trace(`Initialized`);
    try {
      await this.core.start();
      await this.requests.init();
      await this.engine.init();
      this.logger.info(`PushWalletClient Initialization Success`);
    } catch (error: any) {
      this.logger.info(`PushWalletClient Initialization Failure`);
      this.logger.error(error.message);
      throw error;
    }
  }
}
