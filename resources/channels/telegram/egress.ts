import type { StreamEvent } from "@/runtime/index.ts";
import {
  dataUrlToBlob,
  type EgressAdapter,
  extractText,
} from "@/server/channels.ts";
import {
  callTelegramAPI,
  getTelegramContext,
  resolveTelegramConfig,
  type TelegramConfig,
} from "./shared.ts";

export function createTelegramEgressAdapter(
  config?: Partial<TelegramConfig>,
): EgressAdapter {
  return {
    async validateThreadContext(thread) {
      const telegramContext = getTelegramContext(thread?.metadata);
      if (typeof telegramContext?.chatId !== "number") {
        throw {
          status: 422,
          message: "Thread metadata is missing telegram chat_id",
        };
      }
    },
    async deliver(context) {
      const cfg = resolveTelegramConfig(config, context.context);
      const telegramContext = getTelegramContext(context.thread?.metadata);
      if (!telegramContext) return;

      const { chatId } = telegramContext;

      for await (
        const event of context.handle.events as AsyncIterable<StreamEvent>
      ) {
        const ep = event.payload as Record<string, unknown>;
        const sender = ep?.sender as Record<string, unknown> | undefined;

        if (event.type === "NEW_MESSAGE" && sender?.type === "agent") {
          const text = extractText(ep?.content);
          if (text) {
            await callTelegramAPI(cfg, "sendMessage", {
              chat_id: chatId,
              text: text,
            });
          }
        }

        if (event.type === "ASSET_CREATED") {
          const dataUrl = ep?.dataUrl as string | undefined;
          const mime = ep?.mime as string | undefined;
          if (dataUrl && mime) {
            const blob = dataUrlToBlob(dataUrl);
            const formData = new FormData();
            formData.append("chat_id", String(chatId));

            if (mime.startsWith("image/")) {
              formData.append("photo", blob, "image.png");
              await callTelegramAPI(cfg, "sendPhoto", formData);
            } else if (mime.startsWith("audio/")) {
              formData.append("audio", blob, "audio.mp3");
              await callTelegramAPI(cfg, "sendAudio", formData);
            } else {
              formData.append("document", blob, "document");
              await callTelegramAPI(cfg, "sendDocument", formData);
            }
          }
        }
      }
    },
  };
}

export const telegramEgressAdapter = createTelegramEgressAdapter();
export default telegramEgressAdapter;
