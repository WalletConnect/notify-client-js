import axios from "axios";
import { DEFAULT_NOTIFY_SERVER_URL, INotifyClient } from "../../src";
import { waitForEvent } from "./async";
import { gmDappMetadata } from "./mocks";

const NOTIFY_SERVER_URL =
  process.env.NOTIFY_SERVER_URL || DEFAULT_NOTIFY_SERVER_URL;

export const createNotifySubscription = async (
  wallet: INotifyClient,
  account: string,
  onSign: (message: string) => Promise<string>
) => {
  let gotNotifySubscriptionResponse = false;
  let notifySubscriptionEvent: any;

  wallet.once("notify_subscription", (event) => {
    gotNotifySubscriptionResponse = true;
    notifySubscriptionEvent = event;
  });

  await wallet.register({
    domain: "notify.gm.walletconnect.com",
    limited: false,
    account,
    onSign,
  });

  await wallet.subscribe({
    metadata: gmDappMetadata,
    account,
  });

  await waitForEvent(() => gotNotifySubscriptionResponse);

  return { notifySubscriptionEvent };
};

export const sendNotifyMessage = async (
  account: string,
  messageBody: string
) => {
  if (!process.env.GM_PROJECT_ID) {
    throw new ReferenceError(
      "Cannot send notify message. GM_PROJECT_ID env variable not set"
    );
  }
  if (!process.env.NOTIFY_GM_PROJECT_SECRET) {
    throw new ReferenceError(
      "Cannot send notify message. NOTIFY_GM_PROJECT_SECRET env variable not set"
    );
  }
  const url = `${NOTIFY_SERVER_URL}/${process.env.GM_PROJECT_ID}/notify`;

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
      Authorization: `Bearer ${process.env.NOTIFY_GM_PROJECT_SECRET}`,
    },
  });
};
