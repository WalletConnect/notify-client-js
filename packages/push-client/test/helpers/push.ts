import { generateRandomBytes32 } from "@walletconnect/utils";
import { IDappClient, IWalletClient } from "../../src";
import { mockAccount, onSignMock } from "./mocks";
import { waitForEvent } from "../helpers/async";

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

  wallet.once("push_proposal", (event) => {
    gotPushPropose = true;
    pushProposeEvent = event;
  });
  dapp.once("push_response", (event) => {
    gotResponse = true;
    responseEvent = event;
  });

  const { id } = await dapp.propose({
    account: account ?? mockAccount,
    pairingTopic,
  });

  await waitForEvent(() => gotPushPropose);

  await wallet.approve({ id, onSign: onSign ?? onSignMock });
  await waitForEvent(() => gotResponse);

  return { proposalId: id, pushProposeEvent, responseEvent };
};

export const sendPushMessage = async (
  projectId: string,
  account: string,
  messageBody: string
) => {
  const url = ` https://cast.walletconnect.com/${projectId}/notify`;

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

  return fetch(url, {
    method: "POST",
    body: JSON.stringify(body),
    headers: {
      "Content-Type": "application/json",
    },
  })
    .catch((r) => console.error(r))
    .then((res) => res && res.json());
};
