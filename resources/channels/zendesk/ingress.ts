import type { MessagePayload } from "@/database/schemas/index.ts";
import {
  blobToBase64,
  type IngressAdapter,
  type IngressEnvelope,
  timingSafeEqual,
} from "@/server/channels.ts";
import { setChannelContext } from "@/runtime/thread-metadata.ts";
import {
  getZendeskHeaderValue,
  normalizeZendeskAudioMime,
  resolveZendeskConfig,
  startsWithZendeskOggMagic,
  type ZendeskChannelContext,
  type ZendeskConfig,
  type ZendeskWebhookPayload,
} from "./shared.ts";

export function createZendeskIngressAdapter(
  config?: Partial<ZendeskConfig>,
): IngressAdapter {
  const cfg = resolveZendeskConfig(config);

  return {
    async handle(request) {
      if (request.method === "GET") {
        return { status: 200, response: "ok", messages: [] };
      }

      if (cfg.webhookSecret) {
        const apiKey = getZendeskHeaderValue(request.headers, "x-api-key");
        if (!apiKey) {
          return {
            status: 403,
            response: { error: "Missing X-API-Key header" },
            messages: [],
          };
        }
        if (!timingSafeEqual(apiKey, cfg.webhookSecret)) {
          return {
            status: 403,
            response: { error: "Invalid webhook secret" },
            messages: [],
          };
        }
      }

      const data = request.body as ZendeskWebhookPayload;
      if (!data.events?.length) {
        return {
          status: 400,
          response: { error: "No events found in payload" },
          messages: [],
        };
      }

      const messages: IngressEnvelope[] = [];

      for (const event of data.events) {
        if (event.type !== "conversation:message") continue;

        const { conversation, message } = event.payload;
        const { author, content } = message;

        if (author?.type !== "user") continue;
        if (!content) continue;

        let audioBlob: Blob | undefined;
        let mediaBlob: Blob | undefined;
        if (content.type === "file" && content.mediaUrl) {
          try {
            const res = await fetch(content.mediaUrl);
            const blob = await res.blob();
            const isAudio = content.mediaType?.startsWith("audio/") ||
              /\.(mp3|wav|ogg|m4a|aac)$/i.test(content.fileName || "") ||
              await startsWithZendeskOggMagic(blob);
            if (isAudio) audioBlob = blob;
            else mediaBlob = blob;
          } catch (err) {
            console.error("[zendesk] media download error:", err);
          }
        }

        type ContentItem =
          | { type: "text"; text: string }
          | { type: "audio"; dataBase64: string; mimeType: string }
          | {
            type: "file";
            dataBase64: string;
            mimeType: string;
            name?: string;
          };

        const contentParts: ContentItem[] = [];
        if (content.text) {
          contentParts.push({ type: "text", text: content.text });
        }
        if (audioBlob) {
          contentParts.push({
            type: "audio",
            dataBase64: await blobToBase64(audioBlob),
            mimeType: normalizeZendeskAudioMime(
              content.mediaType || "audio/ogg",
            ),
          });
        }
        if (mediaBlob) {
          contentParts.push({
            type: "file",
            dataBase64: await blobToBase64(mediaBlob),
            mimeType: content.mediaType || "application/octet-stream",
            name: content.fileName,
          });
        }

        const payloadContent: MessagePayload["content"] =
          contentParts.length <= 1 && !audioBlob && !mediaBlob
            ? content.text || ""
            : contentParts;

        messages.push({
          message: {
            content: payloadContent,
            sender: {
              type: "user" as const,
              name: author.displayName,
              externalId: author.user?.externalId || author.user?.id,
              metadata: {
                userId: author.user?.id,
                externalId: author.user?.externalId,
              },
            },
            thread: {
              externalId: conversation.id,
            },
            metadata: {
              user: {
                id: author.user?.id,
                externalId: author.user?.externalId,
                name: author.displayName,
              },
            },
          },
          threadMetadataPatch: setChannelContext(
            undefined,
            "zendesk",
            {
              conversationId: conversation.id,
              conversationType: conversation.type ?? null,
              switchboardIntegration: conversation.activeSwitchboardIntegration,
              source: message.source,
              lastInboundMessageId: message.id,
            } satisfies ZendeskChannelContext,
          ),
        });
      }

      return {
        status: 200,
        response: { status: "ok" },
        messages,
      };
    },
  };
}

export const zendeskIngressAdapter = createZendeskIngressAdapter();

export default zendeskIngressAdapter;
