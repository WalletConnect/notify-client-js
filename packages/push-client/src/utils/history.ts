import { HistoryClient } from "@walletconnect/history";
import { ICore, JsonRpcRecord } from "@walletconnect/types";

export const fetchAndInjectHistory = async (
  topic: string,
  name: string,
  core: ICore,
  historyClient: HistoryClient
) => {
  try {
    const lastMessage = core.history.values.reduce((latestRec, rec) => {
      if (rec.topic === topic) {
        if (rec.id > (latestRec?.id ?? 0)) {
          return rec;
        }
        return latestRec;
      }
      return latestRec;
    }, undefined as JsonRpcRecord | undefined);

    const originId =
      lastMessage?.request.id ?? (lastMessage?.response as any)?.result.id;
    const messages = await historyClient.getMessages({
      originId,
      topic,
      direction: "backward",
      messageCount: 200,
    });

    core.logger.info(
      `Fetched ${messages.messageResponse.messages.length} messages from history, using originId ${originId}`
    );

    await messages.injectIntoRelayer();
  } catch (e: any) {
    throw new Error(
      `Failed to fetch and inject history for ${name}: ${e.message}`
    );
  }
};
