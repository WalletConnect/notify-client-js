import { vi } from "vitest";
import { IWalletClient } from "../../src";

export const dappMetadata = {
  name: "dapp (requester)",
  description: "Test DappClient as Requester",
  url: "www.walletconnect.com",
  icons: [],
};

export const gmDappMetadata = {
  name: "gm-dapp",
  description: "Get a gm every hour",
  icons: [
    "https://explorer-api.walletconnect.com/v3/logo/md/32b894e5-f91e-4fcd-6891-38d31fa6ba00?projectId=25de36e8afefd5babb4b45580efb4e06",
  ],
  url: "https://gm.walletconnect.com",
};

export const mockAccount =
  "eip155:1:0xB68328542D0C08c47882D1276c7cC4D6fB9eAe71";

export const onSignMock = () =>
  Promise.resolve(
    "0x5cf19252d326699e9078686035cf8cb020aadf15cb817bb56bcd5605dc0068c15ebdd3230de9b61ab7973d0346b5933f0b0206894b1f6e4af4e2eb8162c52c1d1c"
  );

export const mockIdentityMethods = (wallet: IWalletClient) => {
  wallet.identityKeys.registerIdentity = vi.fn(async () => {
    return "0x";
  });
  wallet.identityKeys.generateIdAuth = vi.fn(async () => {
    return "eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCJ9.eyJpYXQiOjE2ODI1MjUwMjQsImV4cCI6MTc2ODkyNTAyNCwiaXNzIjoiZGlkOmtleTp6Nk1ranVEdXFFU3JHN2ZTSldDNjhiajF6MXJxUU05NHBzU2Q1aktuRmRtMVc5NHMiLCJzdWIiOiJkaWQ6cGtoOmVpcDE1NToxOjB4ZEEzRkI3ZENiOTY2OGI2NTVlZkU0ZjZEMDFCN0YyQjE4OTUzOEYxNSIsImF1ZCI6Imh0dHBzOi8vZ20ud2FsbGV0Y29ubmVjdC5jb20iLCJrc3UiOiJodHRwczovL2tleXMud2FsbGV0Y29ubmVjdC5jb20iLCJzY3AiOiJwcm9tb3Rpb25hbCBwcml2YXRlIGFsZXJ0cyIsImFjdCI6InB1c2hfc3Vic2NyaXB0aW9uIn0.Buc9iTbfT_CmJjxgDy9gL53KLqdBiLsKk0IyQ1ynCMJTw2_XvMjwI_9jZfvwGzBXhjtK6XpQzrerxrUGO_5XAA";
  });
  wallet.identityKeys.getIdentity = vi.fn(
    async () =>
      "1acf41c75a13dd332e3520eb5210a9d25591c1fd98a1fcfe5fb848cbf47edd0b"
  );
};
