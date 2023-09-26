import { Core, Store } from "@walletconnect/core";
import {
  generateChildLogger,
  getDefaultLoggerOptions,
  getLoggerContext,
} from "@walletconnect/logger";
import { EventEmitter } from "events";
import pino from "pino";

import { IdentityKeys } from "@walletconnect/identity-keys";
import {
  DEFAULT_KEYSERVER_URL,
  DEFAULT_NOTIFY_SERVER_URL,
  NOTIFY_CLIENT_PROTOCOL,
  NOTIFY_CLIENT_STORAGE_PREFIX,
  NOTIFY_CLIENT_VERSION,
  NOTIFY_WALLET_CLIENT_DEFAULT_NAME,
} from "./constants";
import { NotifyEngine } from "./controllers";
import { INotifyClient, NotifyClientTypes } from "./types";

export class NotifyClient extends INotifyClient {
  public readonly protocol = NOTIFY_CLIENT_PROTOCOL;
  public readonly version = NOTIFY_CLIENT_VERSION;
  public readonly name: INotifyClient["name"] =
    NOTIFY_WALLET_CLIENT_DEFAULT_NAME;
  public readonly keyserverUrl: INotifyClient["keyserverUrl"];
  public readonly notifyServerUrl: INotifyClient["notifyServerUrl"];

  public core: INotifyClient["core"];
  public logger: INotifyClient["logger"];
  public events: INotifyClient["events"] = new EventEmitter();
  public engine: INotifyClient["engine"];
  public subscriptions: INotifyClient["subscriptions"];
  public messages: INotifyClient["messages"];
  public identityKeys: INotifyClient["identityKeys"];

  static async init(opts: NotifyClientTypes.ClientOptions) {
    const client = new NotifyClient(opts);
    await client.initialize();

    return client;
  }

  constructor(opts: NotifyClientTypes.ClientOptions) {
    super(opts);

    this.name = opts.name || NOTIFY_WALLET_CLIENT_DEFAULT_NAME;

    const logger =
      typeof opts.logger !== "undefined" && typeof opts.logger !== "string"
        ? opts.logger
        : pino(
            getDefaultLoggerOptions({
              level: opts.logger || "error",
            })
          );

    this.keyserverUrl = opts?.keyserverUrl ?? DEFAULT_KEYSERVER_URL;
    this.notifyServerUrl = DEFAULT_NOTIFY_SERVER_URL;
    this.core = opts.core || new Core(opts);

    this.logger = generateChildLogger(logger, this.name);
    this.subscriptions = new Store(
      this.core,
      this.logger,
      "subscriptions",
      NOTIFY_CLIENT_STORAGE_PREFIX
    );
    this.messages = new Store(
      this.core,
      this.logger,
      "messages",
      NOTIFY_CLIENT_STORAGE_PREFIX
    );
    this.identityKeys =
      opts.identityKeys ?? new IdentityKeys(this.core, this.keyserverUrl);
    this.engine = new NotifyEngine(this);
  }

  get context() {
    return getLoggerContext(this.logger);
  }

  get pairing() {
    return this.core.pairing.pairings;
  }

  // ---------- Engine ----------------------------------------------- //

  public subscribe: INotifyClient["subscribe"] = async (params) => {
    try {
      return await this.engine.subscribe(params);
    } catch (error: any) {
      this.logger.error(error.message);
      throw error;
    }
  };

  public update: INotifyClient["update"] = async (params) => {
    try {
      return await this.engine.update(params);
    } catch (error: any) {
      this.logger.error(error.message);
      throw error;
    }
  };

  public decryptMessage: INotifyClient["decryptMessage"] = async (params) => {
    try {
      return await this.engine.decryptMessage(params);
    } catch (error: any) {
      this.logger.error(error.message);
      throw error;
    }
  };

  public getMessageHistory: INotifyClient["getMessageHistory"] = (params) => {
    try {
      return this.engine.getMessageHistory(params);
    } catch (error: any) {
      this.logger.error(error.message);
      throw error;
    }
  };

  public deleteNotifyMessage: INotifyClient["deleteNotifyMessage"] = (
    params
  ) => {
    try {
      return this.engine.deleteNotifyMessage(params);
    } catch (error: any) {
      this.logger.error(error.message);
      throw error;
    }
  };

  public getActiveSubscriptions: INotifyClient["getActiveSubscriptions"] = (
    params
  ) => {
    try {
      return this.engine.getActiveSubscriptions(params);
    } catch (error: any) {
      this.logger.error(error.message);
      throw error;
    }
  };

  public deleteSubscription: INotifyClient["deleteSubscription"] = async (
    params
  ) => {
    try {
      return await this.engine.deleteSubscription(params);
    } catch (error: any) {
      this.logger.error(error.message);
      throw error;
    }
  };

  public register: INotifyClient["register"] = async (params) => {
    try {
      return await this.engine.register(params);
    } catch (error: any) {
      this.logger.error(error.message);
      throw error;
    }
  };

  // ---------- Events ----------------------------------------------- //

  public emit: INotifyClient["emit"] = (name, listener) => {
    return this.events.emit(name, listener);
  };

  public on: INotifyClient["on"] = (name, listener) => {
    return this.events.on(name, listener);
  };

  public once: INotifyClient["once"] = (name, listener) => {
    return this.events.once(name, listener);
  };

  public off: INotifyClient["off"] = (name, listener) => {
    return this.events.off(name, listener);
  };

  public removeListener: INotifyClient["removeListener"] = (name, listener) => {
    return this.events.removeListener(name, listener);
  };

  // ---------- Private ----------------------------------------------- //

  private async initialize() {
    this.logger.trace(`Initialized`);
    try {
      await this.core.start();
      await this.subscriptions.init();
      await this.messages.init();
      await this.identityKeys.init();
      this.engine.init();

      this.logger.info(`NotifyClient Initialization Success`);
    } catch (error: any) {
      this.logger.info(`NotifyClient Initialization Failure`);
      this.logger.error(error.message);
      throw error;
    }
  }
}
