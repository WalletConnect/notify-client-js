export interface NotifyMessage {
  title: string;
  body: string;
  icon: string;
  url: string;
  type?: string;
}

export interface NotifyMessageJWTClaims {
  iat: number; // issued at
  exp: number; // expiry
  iss: string; // public key of cast server (did:key)
  ksu: string; // key server url
  aud: string; // blockchain account (did:pkh)
  act: "notify_message"; // action intent (must be "notify_message")
  sub: string; // subscriptionId (sha256 hash of subscriptionAuth)
  app: string; // dapp domain url,
  msg: NotifyMessage;
}
