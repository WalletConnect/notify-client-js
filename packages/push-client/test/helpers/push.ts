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
  wallet: IWalletClient
) => {
  const pairingTopic = await setupKnownPairing(wallet, dapp);
  let gotPushRequest = false;
  let pushRequestEvent: any;
  let gotResponse = false;
  let responseEvent: any;

  wallet.once("push_request", (event) => {
    gotPushRequest = true;
    pushRequestEvent = event;
  });
  dapp.once("push_response", (event) => {
    gotResponse = true;
    responseEvent = event;
  });

  const { id } = await dapp.request({
    account: mockAccount,
    pairingTopic,
  });

  await waitForEvent(() => gotPushRequest);

  await wallet.approve({ id, onSign: onSignMock });
  await waitForEvent(() => gotResponse);
};
