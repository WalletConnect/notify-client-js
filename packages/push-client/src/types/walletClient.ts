import { IPushEngine } from "./engine";
import { IBaseClient, PushClientTypes } from "./baseClient";

export abstract class IWalletClient extends IBaseClient {
  constructor(public opts: PushClientTypes.Options) {
    super(opts);
  }

  // ---------- Public Methods (wallet) ----------------------------------------------- //

  public abstract approve: IPushEngine["approve"];
  public abstract reject: IPushEngine["reject"];
  public abstract decryptMessage: IPushEngine["decryptMessage"];
}
