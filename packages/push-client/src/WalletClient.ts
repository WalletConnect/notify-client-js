import pino from "pino";
import { Core } from "@walletconnect/core";
import {
  generateChildLogger,
  getDefaultLoggerOptions,
  getLoggerContext,
} from "@walletconnect/logger";
import { getAppMetadata } from "@walletconnect/utils";
import { EventEmitter } from "events";

import { PushEngine } from "./controllers";
import { IWalletClient, PushClientTypes } from "./types";
import {
  PUSH_DAPP_CLIENT_DEFAULT_NAME,
  PUSH_CLIENT_PROTOCOL,
  PUSH_CLIENT_VERSION,
} from "./constants";

export class WalletClient extends IWalletClient {
  public readonly protocol = PUSH_CLIENT_PROTOCOL;
  public readonly version = PUSH_CLIENT_VERSION;
  public readonly name: IWalletClient["name"] = PUSH_DAPP_CLIENT_DEFAULT_NAME;
  public readonly metadata: IWalletClient["metadata"];

  public core: IWalletClient["core"];
  public logger: IWalletClient["logger"];
  public events: IWalletClient["events"] = new EventEmitter();
  public engine: IWalletClient["engine"];

  static async init(opts: PushClientTypes.Options) {
    const client = new WalletClient(opts);
    await client.initialize();

    return client;
  }

  constructor(opts: PushClientTypes.Options) {
    super(opts);

    this.name = opts?.name || PUSH_DAPP_CLIENT_DEFAULT_NAME;
    this.metadata = opts?.metadata || getAppMetadata();

    const logger =
      typeof opts?.logger !== "undefined" && typeof opts?.logger !== "string"
        ? opts.logger
        : pino(
            getDefaultLoggerOptions({
              level: opts?.logger || "error",
            })
          );

    this.core = opts?.core || new Core(opts);
    this.logger = generateChildLogger(logger, this.name);
    this.engine = new PushEngine(this);
  }

  get context() {
    return getLoggerContext(this.logger);
  }

  get pairing() {
    return this.core.pairing.pairings;
  }

  // ---------- Events ----------------------------------------------- //

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

  // ---------- Engine ----------------------------------------------- //

  // ---------- Private ----------------------------------------------- //

  private async initialize() {
    this.logger.trace(`Initialized`);
    try {
      await this.core.start();
      await this.engine.init();
      this.logger.info(`PushDappClient Initialization Success`);
    } catch (error: any) {
      this.logger.info(`PushDappClient Initialization Failure`);
      this.logger.error(error.message);
      throw error;
    }
  }
}
