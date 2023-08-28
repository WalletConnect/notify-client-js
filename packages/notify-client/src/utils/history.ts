import {
  HistoricalMessages,
  HistoryClient,
  Message,
} from "@walletconnect/history";
import { JsonRpcRequest } from "@walletconnect/jsonrpc-utils";
import { ICore } from "@walletconnect/types";

const HISTORY_MAX_FETCH_SIZE = 200;

// Only inject necessary messages
// Primarily to reduce sync messages
export const reduceAndInjectHistory = async (
  core: ICore,
  messageArr: Message[],
  topic: string
) => {
  // payload id, Message
  const messages = new Map<number, Message>();
  // Sync store key, [Sync Request, Encoded Message]
  // We maintain the encoded message to avoid re-encoding later to reduce time complexity
  const syncMessages = new Map<string, [JsonRpcRequest<any>, Message]>();
  for (let i = 0; i < messageArr.length; ++i) {
    const message = messageArr[i];
    const decoded = await core.crypto.decode(message.topic, message.message);

    // No need to inject messages existing in relayer
    if (core.relayer.messages.has(message.topic, message.message)) {
      continue;
    }

    // Non sync messages do not need to be diffed
    if (!("params" in decoded) || !decoded.method.includes("wc_sync")) {
      messages.set(decoded.id, message);
      continue;
    }

    // From this point forward, all messages handled are sync messages
    if (syncMessages.has(decoded.params.key)) {
      const current = syncMessages.get(decoded.params.key)!;

      // Only the most recent syncSet or sync delete is relevant.
      if (current[0].id < decoded.id) {
        syncMessages.set(decoded.params.key, [decoded, message]);
      }
    } else {
      syncMessages.set(decoded.params.key, [decoded, message]);
    }
  }

  // Flushing sync messages into the general message map for injection
  for (const [syncDecodedMessage, syncMessage] of syncMessages.values()) {
    messages.set(syncDecodedMessage.id, syncMessage);
  }
  syncMessages.clear();

  const reducedHistoricalMessages = new HistoricalMessages(core, {
    direction: "backward",
    messages: Array.from(messages.values()),
    nextId: 0,
    topic: topic,
  });

  await reducedHistoricalMessages.injectIntoRelayer();
};

export const fetchAndInjectHistory = async (
  topic: string,
  name: string,
  core: ICore,
  historyClient: HistoryClient
) => {
  let lastMessageId = "";
  let retrievedCount = 0;

  // Fetch history until we have exhausted all of this topic's history.
  do {
    const baseFetchParams = {
      topic,
      direction: "backward",
      messageCount: HISTORY_MAX_FETCH_SIZE,
    } as const;

    const fetchParams = lastMessageId
      ? ({
          ...baseFetchParams,
          originId: lastMessageId,
        } as const)
      : baseFetchParams;

    try {
      const messages = await historyClient.getMessages(fetchParams);
      core.logger.info(
        `Fetched ${messages.messageResponse.messages.length} messages from history for topic: ${topic}, store: ${name}`
      );

      retrievedCount = messages.messageResponse.messages.length;
      // Origin Id is used by history API to determine from which message to pull backwards
      lastMessageId =
        messages.messageResponse.messages[
          messages.messageResponse.messages.length - 1
        ].message_id;

      const currentMessages = messages.messageResponse.messages;
      await reduceAndInjectHistory(core, currentMessages, topic);
    } catch (e) {
      retrievedCount = 0;
      core.logger.error(`Failed to fetch and inject history for ${name}`, e);
      break;
    }
  } while (retrievedCount === HISTORY_MAX_FETCH_SIZE);
};
