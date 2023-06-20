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
  PUSH_CLIENT_PROTOCOL,
  PUSH_CLIENT_STORAGE_PREFIX,
  PUSH_CLIENT_VERSION,
  PUSH_WALLET_CLIENT_DEFAULT_NAME,
} from "./constants";
import { PushEngine } from "./controllers";
import { IWalletClient, PushClientTypes } from "./types";
import { ISyncClient } from "@walletconnect/sync-client";

export class WalletClient extends IWalletClient {
  public readonly protocol = PUSH_CLIENT_PROTOCOL;
  public readonly version = PUSH_CLIENT_VERSION;
  public readonly name: IWalletClient["name"] = PUSH_WALLET_CLIENT_DEFAULT_NAME;
  public readonly keyserverUrl: IWalletClient["keyserverUrl"];

  public core: IWalletClient["core"];
  public logger: IWalletClient["logger"];
  public events: IWalletClient["events"] = new EventEmitter();
  public engine: IWalletClient["engine"];
  public requests: IWalletClient["requests"];
  public proposals: IWalletClient["proposals"];
  public subscriptions: IWalletClient["subscriptions"];
  public messages: IWalletClient["messages"];
  public identityKeys: IWalletClient["identityKeys"];

  public syncClient: IWalletClient["syncClient"];
  public SyncStoreController: IWalletClient["SyncStoreController"];

  static async init(opts: PushClientTypes.WalletClientOptions) {
    const client = new WalletClient(opts);
    await client.initialize();

    return client;
  }

  constructor(opts: PushClientTypes.WalletClientOptions) {
    super(opts);

    this.name = opts.name || PUSH_WALLET_CLIENT_DEFAULT_NAME;

    const logger =
      typeof opts.logger !== "undefined" && typeof opts.logger !== "string"
        ? opts.logger
        : pino(
            getDefaultLoggerOptions({
              level: opts.logger || "error",
            })
          );
    this.syncClient = opts.syncClient;
    this.SyncStoreController = opts.SyncStoreController;

    this.keyserverUrl = opts?.keyserverUrl ?? DEFAULT_KEYSERVER_URL;
    this.core = opts.core || new Core(opts);
    this.logger = generateChildLogger(logger, this.name);
    this.requests = new Store(
      this.core,
      this.logger,
      "requests",
      PUSH_CLIENT_STORAGE_PREFIX
    );
    this.proposals = new Store(
      this.core,
      this.logger,
      "proposals",
      PUSH_CLIENT_STORAGE_PREFIX
    );
    this.subscriptions = new Store(
      this.core,
      this.logger,
      "subscriptions",
      PUSH_CLIENT_STORAGE_PREFIX
    );
    this.messages = new Store(
      this.core,
      this.logger,
      "messages",
      PUSH_CLIENT_STORAGE_PREFIX
    );
    this.identityKeys = new IdentityKeys(this.core);
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

  public reject: IWalletClient["reject"] = async (params) => {
    try {
      return await this.engine.reject(params);
    } catch (error: any) {
      this.logger.error(error.message);
      throw error;
    }
  };

  public subscribe: IWalletClient["subscribe"] = async (params) => {
    try {
      return await this.engine.subscribe(params);
    } catch (error: any) {
      this.logger.error(error.message);
      throw error;
    }
  };

  public update: IWalletClient["update"] = async (params) => {
    try {
      return await this.engine.update(params);
    } catch (error: any) {
      this.logger.error(error.message);
      throw error;
    }
  };

  public decryptMessage: IWalletClient["decryptMessage"] = async (params) => {
    try {
      return await this.engine.decryptMessage(params);
    } catch (error: any) {
      this.logger.error(error.message);
      throw error;
    }
  };

  public getMessageHistory: IWalletClient["getMessageHistory"] = (params) => {
    try {
      return this.engine.getMessageHistory(params);
    } catch (error: any) {
      this.logger.error(error.message);
      throw error;
    }
  };

  public deletePushMessage: IWalletClient["deletePushMessage"] = (params) => {
    try {
      return this.engine.deletePushMessage(params);
    } catch (error: any) {
      this.logger.error(error.message);
      throw error;
    }
  };

  public getActiveSubscriptions: IWalletClient["getActiveSubscriptions"] = (
    params
  ) => {
    try {
      return this.engine.getActiveSubscriptions(params);
    } catch (error: any) {
      this.logger.error(error.message);
      throw error;
    }
  };

  public deleteSubscription: IWalletClient["deleteSubscription"] = async (
    params
  ) => {
    try {
      return await this.engine.deleteSubscription(params);
    } catch (error: any) {
      this.logger.error(error.message);
      throw error;
    }
  };

  public register: IWalletClient["register"] = async ({ account, onSign }) => {
    try {
      return await this.engine.register({ account, onSign });
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

  // ---------- Helpers ----------------------------------------------- //

  public initSyncStores: IWalletClient["initSyncStores"] = async ({
    account,
    signature,
  }) => {
    this.subscriptions = new this.SyncStoreController(
      "com.walletconnect.notify.pushSubscription",
      this.syncClient,
      account,
      signature,
      (subTopic, subscription) => {
        if (!subscription) return;

        console.log(
          "Public: ",
          subscription.selfPublicKey,
          " // Private: ",
          subscription.selfPrivateKey
        );

        this.core.crypto.keychain
          .set(subscription.selfPublicKey, subscription.selfPrivateKey)
          .then(() => {
            return this.core.crypto.generateSharedKey(
              subscription.selfPublicKey,
              subscription.dappPublicKey,
              subTopic
            );
          });

        if (!this.core.relayer.subscriber.topics.includes(subTopic)) {
          this.core.relayer.subscriber.subscribe(subTopic);
        }
      }
    );
    await this.subscriptions.init();
  };

  // ---------- Private ----------------------------------------------- //

  private async initialize() {
    this.logger.trace(`Initialized`);
    try {
      await this.core.start();
      await this.requests.init();
      await this.proposals.init();
      await this.subscriptions.init();
      await this.messages.init();
      await this.identityKeys.init();
      await this.engine.init();
      this.logger.info(`PushWalletClient Initialization Success`);
    } catch (error: any) {
      this.logger.info(`PushWalletClient Initialization Failure`);
      this.logger.error(error.message);
      throw error;
    }
  }
}
