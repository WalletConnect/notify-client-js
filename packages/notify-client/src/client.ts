import { Core, RELAYER_DEFAULT_RELAY_URL, Store } from "@walletconnect/core";
import {
  generateChildLogger,
  getDefaultLoggerOptions,
  getLoggerContext,
} from "@walletconnect/logger";
import { EventEmitter } from "events";
import pino from "pino";

import { HistoryClient } from "@walletconnect/history";
import { IdentityKeys } from "@walletconnect/identity-keys";
import {
  DEFAULT_KEYSERVER_URL,
  NOTIFY_CLIENT_PROTOCOL,
  NOTIFY_CLIENT_STORAGE_PREFIX,
  NOTIFY_CLIENT_VERSION,
  NOTIFY_WALLET_CLIENT_DEFAULT_NAME,
} from "./constants";
import { NotifyEngine } from "./controllers";
import { INotifyClient, NotifyClientTypes } from "./types";
import { fetchAndInjectHistory } from "./utils/history";

export class NotifyClient extends INotifyClient {
  public readonly protocol = NOTIFY_CLIENT_PROTOCOL;
  public readonly version = NOTIFY_CLIENT_VERSION;
  public readonly name: INotifyClient["name"] =
    NOTIFY_WALLET_CLIENT_DEFAULT_NAME;
  public readonly keyserverUrl: INotifyClient["keyserverUrl"];

  public core: INotifyClient["core"];
  public logger: INotifyClient["logger"];
  public events: INotifyClient["events"] = new EventEmitter();
  public engine: INotifyClient["engine"];
  public requests: INotifyClient["requests"];
  public subscriptions: INotifyClient["subscriptions"];
  public messages: INotifyClient["messages"];
  public identityKeys: INotifyClient["identityKeys"];

  public historyClient: HistoryClient;

  public syncClient: INotifyClient["syncClient"];
  public SyncStoreController: INotifyClient["SyncStoreController"];

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

    this.syncClient = opts.syncClient;
    this.SyncStoreController = opts.SyncStoreController;

    this.keyserverUrl = opts?.keyserverUrl ?? DEFAULT_KEYSERVER_URL;
    this.core = opts.core || new Core(opts);

    this.historyClient = new HistoryClient(this.core);

    this.logger = generateChildLogger(logger, this.name);
    this.requests = new Store(
      this.core,
      this.logger,
      "requests",
      NOTIFY_CLIENT_STORAGE_PREFIX
    );
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
    this.identityKeys = opts.identityKeys ?? new IdentityKeys(this.core);
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

  public register: INotifyClient["register"] = async ({ account, onSign }) => {
    try {
      return await this.engine.register({ account, onSign });
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

  // ---------- Helpers ----------------------------------------------- //

  public initSyncStores: INotifyClient["initSyncStores"] = async ({
    account,
    signature,
  }) => {
    this.subscriptions = new this.SyncStoreController(
      "com.walletconnect.notify.notifySubscription",
      this.syncClient,
      account,
      signature,
      (subTopic, subscription) => {
        if (!subscription) {
          // Unsubscribe only if currently subscribed
          if (this.core.relayer.subscriber.topics.includes(subTopic)) {
            this.core.relayer.subscriber.unsubscribe(subTopic);
          }
          // Delete messages since subscription was removed
          this.messages.delete(subTopic, {
            code: -1,
            message: "Deleted parent subscription",
          });

          // Delete symkey since subscription was removed
          this.core.crypto.deleteSymKey(subTopic);

          return;
        }

        if (subscription) {
          const existingSubExists =
            this.messages.getAll({ topic: subTopic }).length > 0;
          if (existingSubExists) return;

          this.messages.set(subTopic, { topic: subTopic, messages: [] });
          this.core.crypto.setSymKey(subscription.symKey, subTopic).then(() => {
            if (!this.core.relayer.subscriber.topics.includes(subTopic)) {
              this.core.relayer.subscriber.subscribe(subTopic);
            }
          });
        }
      }
    );
    await this.subscriptions.init();

    const historyFetchedStores = [
      "com.walletconnect.notify.notifySubscription",
    ];

    const stores = this.syncClient.storeMap.getAll().filter((store) => {
      return (
        historyFetchedStores.includes(store.key) && store.account === account
      );
    });

    stores.forEach((store) => {
      fetchAndInjectHistory(
        store.topic,
        store.key,
        this.core,
        this.historyClient
      )
        .catch((e) => this.logger.error(e.message))
        .then(() => {
          this.subscriptions.getAll().forEach(({ topic, metadata }) => {
            fetchAndInjectHistory(
              topic,
              metadata.name,
              this.core,
              this.historyClient
            );
          });
        });
    });
  };

  // ---------- Private ----------------------------------------------- //

  private async initialize() {
    this.logger.trace(`Initialized`);
    try {
      await this.historyClient.registerTags({
        relayUrl: this.core.relayUrl || RELAYER_DEFAULT_RELAY_URL,
        tags: ["4002", "5000", "5002"],
      });

      await this.core.start();
      await this.requests.init();
      await this.subscriptions.init();
      await this.messages.init();
      await this.identityKeys.init();
      this.engine.init();

      // Sync all accounts
      for (const {
        account,
        signature,
      } of this.syncClient.signatures.getAll()) {
        this.initSyncStores({ account, signature });
      }

      this.logger.info(`NotifyClient Initialization Success`);
    } catch (error: any) {
      this.logger.info(`NotifyClient Initialization Failure`);
      this.logger.error(error.message);
      throw error;
    }
  }
}
