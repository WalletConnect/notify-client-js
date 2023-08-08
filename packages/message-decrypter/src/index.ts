import { Core, Crypto } from "@walletconnect/core";
import jwtDecode, { InvalidTokenError } from "jwt-decode";
import { NotifyMessageJWTClaims } from "./types";

const decodeAndValidateMessageAuth = (messageAuthJWT: string) => {
  let messageClaims: NotifyMessageJWTClaims;

  // Attempt to decode the messageAuth JWT. Will throw `InvalidTokenError` if invalid.
  try {
    messageClaims = jwtDecode<NotifyMessageJWTClaims>(messageAuthJWT);
  } catch (error: unknown) {
    throw new Error((error as InvalidTokenError).message);
  }

  // Validate `act` claim is as expected.
  if (messageClaims.act !== "notify_message") {
    throw new Error(
      `Invalid messageAuth JWT act claim: ${messageClaims.act}. Expected "notify_message"`
    );
  }

  return messageClaims;
};

export const decryptMessage = async (params: {
  topic: string;
  encoded: string;
  symkey: string;
}) => {
  const { topic, encoded, symkey } = params;
  // Do not init core to not start a websocket connection
  const core = new Core();

  const crypto = new Crypto(core, core.logger);
  await crypto.init();

  // Set symkey to decode notify_message
  await crypto.setSymKey(symkey, topic);

  const payload: any = await crypto.decode(topic, encoded);

  return decodeAndValidateMessageAuth(payload.params.messageAuth).msg;
};
