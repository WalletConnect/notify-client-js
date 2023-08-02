import { IWalletClient } from "../../src";
import { waitForEvent } from "../helpers/async";
import axios from "axios";
import { gmDappMetadata } from "./mocks";

export const createPushSubscription = async (
  wallet: IWalletClient,
  account: string,
  onSign: (message: string) => Promise<string>
) => {
  let gotPushSubscriptionResponse = false;
  let pushSubscriptionEvent: any;

  wallet.once("push_subscription", (event) => {
    gotPushSubscriptionResponse = true;
    pushSubscriptionEvent = event;
  });

  await wallet.subscribe({
    metadata: gmDappMetadata,
    account,
    onSign,
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
