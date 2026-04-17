import type { MessagePayload } from "@/database/schemas/index.ts";
import {
  blobToBase64,
  type IngressAdapter,
  type IngressEnvelope,
  verifyHmacSha256,
} from "@/server/channels.ts";
import { setChannelContext } from "@/runtime/thread-metadata.ts";
import {
  downloadWhatsAppMedia,
  getWhatsAppHeaderValue,
  resolveWhatsAppConfig,
  type WhatsAppConfig,
  type WhatsAppWebhookPayload,
} from "./shared.ts";

export function createWhatsAppIngressAdapter(
  config?: Partial<WhatsAppConfig>,
): IngressAdapter {
  const cfg = resolveWhatsAppConfig(config);

  return {
    async handle(request) {
      if (request.method === "GET") {
        const query = request.query ?? {};
        const mode = query["hub.mode"] as string | undefined;
        const token = query["hub.verify_token"] as string | undefined;
        const challenge = query["hub.challenge"] as string | undefined;

        if (mode === "subscribe" && token === cfg.webhookVerifyToken) {
          return { status: 200, response: challenge, messages: [] };
        }

        return { status: 403, response: { error: "Forbidden" }, messages: [] };
      }

      if (cfg.appSecret) {
        const signature = getWhatsAppHeaderValue(
          request.headers,
          "x-hub-signature-256",
        );
        if (!signature) {
          return {
            status: 403,
            response: { error: "Missing X-Hub-Signature-256 header" },
            messages: [],
          };
        }
        if (!request.rawBody) {
          return {
            status: 400,
            response: { error: "Raw body required for signature verification" },
            messages: [],
          };
        }
        const valid = await verifyHmacSha256(
          request.rawBody,
          cfg.appSecret,
          signature,
        );
        if (!valid) {
          return {
            status: 403,
            response: { error: "Invalid webhook signature" },
            messages: [],
          };
        }
      }

      const data = request.body as WhatsAppWebhookPayload;
      const messages: IngressEnvelope[] = [];

      for (const entry of data.entry || []) {
        for (const change of entry.changes || []) {
          const { messages: incomingMessages, metadata, contacts } =
            change.value ||
            {};
          const phoneNumberId = metadata?.phone_number_id;
          const userName = contacts?.[0]?.profile?.name;

          for (const message of incomingMessages || []) {
            const text = message.text?.body;
            const audioBlob = await downloadWhatsAppMedia(
              message,
              "audio",
              cfg,
            );
            const videoBlob = await downloadWhatsAppMedia(
              message,
              "video",
              cfg,
            );
            const mediaBlob = audioBlob || videoBlob;

            type ContentItem =
              | { type: "text"; text: string }
              | { type: "audio"; dataBase64: string; mimeType: string }
              | { type: "file"; dataBase64: string; mimeType: string };

            const contentParts: ContentItem[] = [];
            if (text) contentParts.push({ type: "text", text });
            if (audioBlob) {
              contentParts.push({
                type: "audio",
                dataBase64: await blobToBase64(audioBlob),
                mimeType: message.audio?.mime_type || "audio/ogg",
              });
            }
            if (videoBlob) {
              contentParts.push({
                type: "file",
                dataBase64: await blobToBase64(videoBlob),
                mimeType: message.video?.mime_type || "video/mp4",
              });
            }

            const content: MessagePayload["content"] = contentParts.length === 0
              ? text || ""
              : contentParts.length === 1 && !mediaBlob
              ? text || ""
              : contentParts;

            messages.push({
              message: {
                content,
                sender: {
                  type: "user" as const,
                  name: userName,
                  externalId: message.from,
                  metadata: { phone: message.from },
                },
                thread: {
                  externalId: message.from,
                },
                metadata: {
                  user: { name: userName, phone: message.from },
                },
              },
              threadMetadataPatch: setChannelContext(undefined, "whatsapp", {
                recipientPhone: message.from,
                channelId: phoneNumberId ?? null,
                businessId: entry.id,
                userName: userName ?? null,
              }),
            });
          }
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

export const whatsappIngressAdapter = createWhatsAppIngressAdapter();

export default whatsappIngressAdapter;
