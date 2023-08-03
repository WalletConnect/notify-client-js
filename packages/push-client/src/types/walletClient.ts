import { IdentityKeys } from "@walletconnect/identity-keys";
import { IStore } from "@walletconnect/types";
import { IBaseClient, NotifyClientTypes } from "./baseClient";
import { INotifyEngine } from "./engine";
import { ISyncClient, SyncStore } from "@walletconnect/sync-client";
import { HistoryClient } from "@walletconnect/history";

export interface IdentityKeychain {
  accountId: string;
  identityKeyPub: string;
  identityKeyPriv: string;
}

export abstract class IWalletClient extends IBaseClient {
  public abstract readonly keyserverUrl: string;

  public abstract historyClient: HistoryClient;

  public abstract readonly syncClient: ISyncClient;
  public abstract readonly SyncStoreController: typeof SyncStore;

  public abstract requests: IStore<
    number,
    {
      topic: string;
      request: NotifyClientTypes.PushSubscriptionRequest;
    }
  >;
  public abstract messages: IStore<
    string,
    {
      topic: string;
      messages: Record<number, NotifyClientTypes.PushMessageRecord>;
    }
  >;
  public abstract identityKeys: IdentityKeys;

  constructor(public opts: NotifyClientTypes.WalletClientOptions) {
    super();
  }

  // ---------- Public Methods (wallet) ----------------------------------------------- //

  public abstract enableSync: INotifyEngine["enableSync"];
  public abstract subscribe: INotifyEngine["subscribe"];
  public abstract update: INotifyEngine["update"];
  public abstract decryptMessage: INotifyEngine["decryptMessage"];
  public abstract getMessageHistory: INotifyEngine["getMessageHistory"];
  public abstract deleteNotifyMessage: INotifyEngine["deleteNotifyMessage"];

  // ---------- Helpers  ------------------------------------------------------------ //
  public abstract initSyncStores: (params: {
    account: string;
    signature: string;
  }) => Promise<void>;
}
