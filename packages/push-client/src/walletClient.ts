import { Core, RELAYER_DEFAULT_RELAY_URL, Store } from "@walletconnect/core";
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
import { HistoryClient } from "@walletconnect/history";
import { fetchAndInjectHistory } from "./utils/history";

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

  public historyClient: HistoryClient;

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

    this.historyClient = new HistoryClient(this.core);

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

  public enableSync: IWalletClient["enableSync"] = async ({
    account,
    onSign,
  }) => {
    try {
      return await this.engine.enableSync({ account, onSign });
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
    console.log("1TE Init sync stores");
    this.subscriptions = new this.SyncStoreController(
      "com.walletconnect.notify.pushSubscription",
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

        const existingSubExists =
          this.messages.getAll({ topic: subTopic }).length > 0;
        if (existingSubExists) return;

        this.messages.set(subTopic, { topic: subTopic, messages: [] });
        this.core.crypto.setSymKey(subscription.symKey).then(() => {
          if (!this.core.relayer.subscriber.topics.includes(subTopic)) {
            this.core.relayer.subscriber.subscribe(subTopic);
          }
        });
      }
    );
    await this.subscriptions.init();

    const historyFetchedStores = ["com.walletconnect.notify.pushSubscription"];

    const stores = this.syncClient.storeMap.getAll().filter((store) => {
      return (
        historyFetchedStores.includes(store.key) && store.account === account
      );
    });

    console.log(
      "1TE fetching history",
      account,
      stores.map((store) => store.account)
    );

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
      await this.proposals.init();
      await this.subscriptions.init();
      await this.messages.init();
      await this.identityKeys.init();
      this.engine.init();

      // Sync all accounts
      for (const {
        account,
        signature,
      } of this.syncClient.signatures.getAll()) {
        console.log("1te Initting for", account);
        this.initSyncStores({ account, signature });
      }

      this.logger.info(`PushWalletClient Initialization Success`);
    } catch (error: any) {
      this.logger.info(`PushWalletClient Initialization Failure`);
      this.logger.error(error.message);
      throw error;
    }
  }
}
