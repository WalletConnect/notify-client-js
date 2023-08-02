import { generateRandomBytes32 } from "@walletconnect/utils";
import { IDappClient, IWalletClient } from "../../src";
import { waitForEvent } from "../helpers/async";
import axios from "axios";
import { Wallet as EthersWallet } from "@ethersproject/wallet";

export const setupKnownPairing = async (
  clientA: IWalletClient | IDappClient,
  clientB: IWalletClient | IDappClient
) => {
  const symKey = generateRandomBytes32();
  const pairingTopic = await clientA.core.crypto.setSymKey(symKey);
  await clientA.core.relayer.subscribe(pairingTopic);
  const peerPairingTopic = await clientB.core.crypto.setSymKey(symKey);
  await clientB.core.relayer.subscribe(peerPairingTopic);

  // `pairingTopic` and `peerPairingTopic` should be identical -> just return one of them.
  return pairingTopic;
};

export const createPushSubscription = async (
  dapp: IDappClient,
  wallet: IWalletClient,
  account?: string,
  onSign?: (message: string) => Promise<string>
) => {
  const pairingTopic = await setupKnownPairing(wallet, dapp);
  let gotPushPropose = false;
  let pushProposeEvent: any;
  let gotResponse = false;
  let responseEvent: any;

  const ethersWallet = EthersWallet.createRandom();
  account = `eip155:1:${ethersWallet.address}`;
  onSign = (message: string) => ethersWallet.signMessage(message);

  wallet.once("push_proposal", (event) => {
    gotPushPropose = true;
    pushProposeEvent = event;
  });
  dapp.once("push_response", (event) => {
    gotResponse = true;
    responseEvent = event;
  });

  const { id } = await dapp.propose({
    account,
    pairingTopic,
  });

  await waitForEvent(() => gotPushPropose);

  await wallet.approve({ id, onSign });
  await waitForEvent(() => gotResponse);

  return { proposalId: id, pushProposeEvent, responseEvent, pairingTopic };
};

export const sendPushMessage = async (
  projectId: string,
  account: string,
  messageBody: string
) => {
  if (!process.env.GM_PROJECT_ID) {
    throw new ReferenceError(
      "Cannot send push message. GM_PROJECT_ID env variable not set"
    );
  }
  if (!process.env.GM_PROJECT_SECRET) {
    throw new ReferenceError(
      "Cannot send push message. GM_PROJECT_SECRET env variable not set"
    );
  }
  const url = ` https://cast.walletconnect.com/${process.env.GM_PROJECT_ID}/notify`;

  const body = {
    notification: {
      body: messageBody,
      title: "Test Message",
      icon: "",
      url: "https://test.coms",
      type: "gm_hourly",
    },
    accounts: [account],
  };

  return axios.post(url, body, {
    headers: {
      Authorization: `Bearer ${process.env.GM_PROJECT_SECRET}`,
    },
  });
};
