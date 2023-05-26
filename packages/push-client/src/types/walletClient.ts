import { IdentityKeys } from "@walletconnect/identity-keys/dist/esm";
import { IStore } from "@walletconnect/types";
import { IBaseClient, PushClientTypes } from "./baseClient";
import { IPushEngine } from "./engine";

export interface IdentityKeychain {
  accountId: string;
  identityKeyPub: string;
  identityKeyPriv: string;
}

export abstract class IWalletClient extends IBaseClient {
  public abstract readonly keyserverUrl: string;

  public abstract messages: IStore<
    string,
    {
      topic: string;
      messages: Record<number, PushClientTypes.PushMessageRecord>;
    }
  >;
  public abstract identityKeys: IdentityKeys;

  constructor(public opts: PushClientTypes.WalletClientOptions) {
    super();
  }

  // ---------- Public Methods (wallet) ----------------------------------------------- //

  public abstract approve: IPushEngine["approve"];
  public abstract reject: IPushEngine["reject"];
  public abstract subscribe: IPushEngine["subscribe"];
  public abstract update: IPushEngine["update"];
  public abstract decryptMessage: IPushEngine["decryptMessage"];
  public abstract getMessageHistory: IPushEngine["getMessageHistory"];
  public abstract deletePushMessage: IPushEngine["deletePushMessage"];
}
