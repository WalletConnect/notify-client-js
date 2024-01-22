import axios from "axios";
import {
  DEFAULT_NOTIFY_SERVER_URL,
  INotifyClient,
} from "../../src";
import { testDappMetadata, gmHackersMetadata } from "./mocks";

const NOTIFY_SERVER_URL =
  process.env.NOTIFY_SERVER_URL || DEFAULT_NOTIFY_SERVER_URL;

export const createNotifySubscription = async (
  wallet: INotifyClient,
  account: string,
  onSign: (message: string) => Promise<string>,
  differentSubscription?: boolean
) => {

  const domain = differentSubscription
    ? gmHackersMetadata.appDomain
    : testDappMetadata.appDomain;

  if (!wallet.isRegistered({ account, domain: testDappMetadata.appDomain })) {
    const preparedRegistration = await wallet.prepareRegistration({
      account,
      domain: testDappMetadata.appDomain,
      allApps: true,
    });

    console.log(">> about to register")

    await wallet.register({
      registerParams: preparedRegistration.registerParams,
      signature: await onSign(preparedRegistration.message),
    });
  }

  console.log(">> registered, about to subscribe")

  return wallet.subscribe({
    appDomain: domain,
    account,
  });

};

export const sendNotifyMessage = async (
  account: string,
  messageBody: string
) => {
  if (!process.env.TEST_PROJECT_ID) {
    throw new ReferenceError(
      "Cannot send notify message. TEST_PROJECT_ID env variable not set"
    );
  }
  if (!process.env.TEST_PROJECT_SECRET) {
    throw new ReferenceError(
      "Cannot send notify message. TEST_PROJECT_SECRET env variable not set"
    );
  }
  const url = `${NOTIFY_SERVER_URL}/${process.env.TEST_PROJECT_ID}/notify`;

  const body = {
    notification: {
      body: messageBody,
      title: "Test Message",
      url: "https://test.coms",
      // "Notification 1" notification ID, taken from Notify Test (ec020ad1-89bc-4f0f-b7bc-5602990e79b5) project on Cloud.
      type: "f173f231-a45c-4dc0-aa5d-956eb04f7360",
    },
    accounts: [account],
  };

  return axios.post(url, body, {
    headers: {
      Authorization: `Bearer ${process.env.TEST_PROJECT_SECRET}`,
    },
  });
};
