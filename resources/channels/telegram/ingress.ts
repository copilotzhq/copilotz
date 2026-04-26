import {
  blobToBase64,
  type IngressAdapter,
  type IngressEnvelope,
} from "@/server/channels.ts";
import { setChannelContext } from "@/runtime/thread-metadata.ts";
import {
  downloadTelegramFile,
  resolveTelegramConfig,
  type TelegramConfig,
} from "./shared.ts";

export function createTelegramIngressAdapter(
  config?: Partial<TelegramConfig>,
): IngressAdapter {
  return {
    async handle(request) {
      const cfg = resolveTelegramConfig(config, request.context);

      // Validate secret token if provided
      if (cfg.secretToken) {
        const receivedToken = request.headers["x-telegram-bot-api-secret-token"];
        if (receivedToken !== cfg.secretToken) {
          return {
            status: 403,
            response: { error: "Forbidden: Invalid secret token" },
            messages: [],
          };
        }
      }

      const update = request.body as any;
      const messages: IngressEnvelope[] = [];

      const msg = update.message || update.edited_message;
      if (msg) {
        const chatId = msg.chat.id;
        const from = msg.from;
        const text = msg.text || msg.caption;

        type ContentItem =
          | { type: "text"; text: string }
          | { type: "image"; dataBase64: string; mimeType: string }
          | { type: "audio"; dataBase64: string; mimeType: string };

        const contentParts: ContentItem[] = [];
        if (text) contentParts.push({ type: "text", text });

        // Handle Photo (take highest resolution)
        if (msg.photo?.length) {
          const photo = msg.photo[msg.photo.length - 1];
          const blob = await downloadTelegramFile(cfg, photo.file_id);
          if (blob) {
            contentParts.push({
              type: "image",
              dataBase64: await blobToBase64(blob),
              mimeType: blob.type || "image/jpeg",
            });
          }
        }

        // Handle Audio/Voice
        const audioFile = msg.voice || msg.audio;
        if (audioFile) {
          const blob = await downloadTelegramFile(cfg, audioFile.file_id);
          if (blob) {
            contentParts.push({
              type: "audio",
              dataBase64: await blobToBase64(blob),
              mimeType: blob.type || (msg.voice ? "audio/ogg" : "audio/mpeg"),
            });
          }
        }

        if (contentParts.length > 0) {
          const content = contentParts.length === 1 && contentParts[0].type === "text"
            ? contentParts[0].text
            : contentParts;

          messages.push({
            message: {
              content,
              sender: {
                type: "user",
                id: String(from.id),
                name: from.username || `${from.first_name} ${from.last_name || ""}`.trim(),
                externalId: String(from.id),
                metadata: { telegram: from },
              },
              thread: {
                externalId: String(chatId),
              },
            },
            threadMetadataPatch: setChannelContext(undefined, "telegram", {
              chatId,
              userId: from.id,
              userName: from.username,
            }),
          });
        }
      }

      // Handle callback queries (buttons)
      if (update.callback_query) {
        const cq = update.callback_query;
        const chatId = cq.message?.chat.id;
        const from = cq.from;
        const data = cq.data;

        if (chatId && data) {
          messages.push({
            message: {
              content: data,
              sender: {
                type: "user",
                id: String(from.id),
                name: from.username || `${from.first_name} ${from.last_name || ""}`.trim(),
                externalId: String(from.id),
                metadata: { telegram: from },
              },
              thread: {
                externalId: String(chatId),
              },
            },
            threadMetadataPatch: setChannelContext(undefined, "telegram", {
              chatId,
              userId: from.id,
              userName: from.username,
            }),
          });
        }
      }

      return {
        status: 200,
        response: { status: "ok" },
        messages,
      };
    },
  };
}

export const telegramIngressAdapter = createTelegramIngressAdapter();
export default telegramIngressAdapter;
