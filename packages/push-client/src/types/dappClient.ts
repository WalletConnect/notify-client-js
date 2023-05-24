import { IStore } from "@walletconnect/types";
import { IPushEngine } from "./engine";
import { IBaseClient, PushClientTypes } from "./baseClient";

export interface ProposalKeychain {
  responseTopic: string;
  proposalKeyPub: string;
}

export abstract class IDappClient extends IBaseClient {
  public abstract metadata: PushClientTypes.Metadata;
  public abstract castUrl: string;

  public abstract proposalKeys: IStore<
    ProposalKeychain["responseTopic"],
    ProposalKeychain
  >;

  constructor(public opts: PushClientTypes.DappClientOptions) {
    super();
  }

  // ---------- Public Methods (dapp) ----------------------------------------------- //

  public abstract request: IPushEngine["request"];
  public abstract propose: IPushEngine["propose"];
  public abstract notify: IPushEngine["notify"];
}
