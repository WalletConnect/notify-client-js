import { IWalletClient } from "../../src";
import { gmDappMetadata, mockAccount, onSignMock } from "./mocks";
import { waitForEvent } from "../helpers/async";
import axios from "axios";

export const createPushSubscription = async (
  wallet: IWalletClient,
  account?: string,
  onSign?: (message: string) => Promise<string>
) => {
  let gotPushSubscriptionResponse = false;
  let pushSubscriptionEvent: any;

  wallet.once("push_subscription", (event) => {
    gotPushSubscriptionResponse = true;
    pushSubscriptionEvent = event;
  });

  await wallet.subscribe({
    metadata: gmDappMetadata,
    account: mockAccount,
    onSign: onSignMock,
  });

  await waitForEvent(() => gotPushSubscriptionResponse);

  return { pushSubscriptionEvent };
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

  return axios.post(url, body);
};
