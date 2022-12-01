import { IPushEngine } from "./engine";
import { IBaseClient, PushClientTypes } from "./baseClient";

export abstract class IDappClient extends IBaseClient {
  constructor(public opts: PushClientTypes.Options) {
    super(opts);
  }

  // ---------- Public Methods (dapp) ----------------------------------------------- //

  public abstract request: IPushEngine["request"];
  public abstract notify: IPushEngine["notify"];
}
