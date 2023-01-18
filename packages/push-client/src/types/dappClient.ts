import { IPushEngine } from "./engine";
import { IBaseClient, PushClientTypes } from "./baseClient";

export abstract class IDappClient extends IBaseClient {
  public abstract metadata: PushClientTypes.Metadata;

  constructor(public opts: PushClientTypes.DappClientOptions) {
    super();
  }

  // ---------- Public Methods (dapp) ----------------------------------------------- //

  public abstract request: IPushEngine["request"];
  public abstract notify: IPushEngine["notify"];
}
