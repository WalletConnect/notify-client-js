import { HistoryClient } from "@walletconnect/history";
import { ICore } from "@walletconnect/types";

export const fetchAndInjectHistory = async (
  topic: string,
  name: string,
  core: ICore,
  historyClient: HistoryClient
) => {
  try {
    const messages = await historyClient.getMessages({
      topic,
      direction: "backward",
      messageCount: 200,
    });

    core.logger.info(
      `Fetched ${messages.messageResponse.messages.length} messages from history`
    );

    await messages.injectIntoRelayer();
  } catch (e: any) {
    throw new Error(
      `Failed to fetch and inject history for ${name}: ${e.message}`
    );
  }
};
