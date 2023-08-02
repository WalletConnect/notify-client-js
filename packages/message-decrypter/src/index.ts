import { Core, Crypto } from "@walletconnect/core";

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

  // Set symkey to decode push_message
  await crypto.setSymKey(symkey, topic);

  return crypto.decode(topic, encoded);
};
