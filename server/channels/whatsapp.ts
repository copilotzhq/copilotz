/**
 * WhatsApp Cloud API channel handler.
 *
 * Handles webhook verification (GET) and inbound messages (POST).
 * Responses are pushed back to the user via the WhatsApp Cloud API.
 *
 * @module
 *
 * @example
 * ```ts
 * import { whatsappChannel } from "copilotz/server/channels/whatsapp";
 *
 * // Reads WHATSAPP_* env vars by default:
 * const res = await whatsappChannel(req, copilotz);
 *
 * // Or pass explicit config:
 * const res = await whatsappChannel(req, copilotz, {
 *   accessToken: "...",
 *   phoneId: "...",
 *   appSecret: "...",
 *   webhookVerifyToken: "...",
 * });
 * ```
 */

import type { Copilotz } from "@/index.ts";
import type { MessagePayload } from "@/database/schemas/index.ts";
import type { StreamEvent } from "@/runtime/index.ts";
import type { ChannelRequest, ChannelResponse } from "./types.ts";
import {
  blobToBase64,
  extractText,
  parseDataUrl,
  splitString,
  verifyHmacSha256,
} from "./utils.ts";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export type WhatsAppConfig = {
  accessToken: string;
  phoneId: string;
  appSecret: string;
  webhookVerifyToken: string;
  /** Graph API version (default: `"v19.0"`). */
  graphApiVersion?: string;
};

function resolveConfig(config?: Partial<WhatsAppConfig>): WhatsAppConfig {
  return {
    accessToken: config?.accessToken || Deno.env.get("WHATSAPP_ACCESS_TOKEN") || "",
    phoneId: config?.phoneId || Deno.env.get("WHATSAPP_PHONE_ID") || "",
    appSecret: config?.appSecret || Deno.env.get("WHATSAPP_APP_SECRET") || "",
    webhookVerifyToken: config?.webhookVerifyToken || Deno.env.get("WHATSAPP_WEBHOOK_VERIFY_TOKEN") || "",
    graphApiVersion: config?.graphApiVersion || "v19.0",
  };
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type WhatsAppWebhookEntry = {
  id: string;
  changes?: Array<{
    value: {
      messages?: Array<WhatsAppMessage>;
      metadata?: { phone_number_id?: string };
      contacts?: Array<{ profile?: { name?: string } }>;
    };
  }>;
};

type WhatsAppMessage = {
  from: string;
  id: string;
  timestamp: string;
  type: string;
  text?: { body: string };
  audio?: { id: string; mime_type?: string };
  video?: { id: string; mime_type?: string };
  document?: { id: string; mime_type?: string; filename?: string };
};

type WhatsAppWebhookPayload = {
  entry?: WhatsAppWebhookEntry[];
};

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

export async function whatsappChannel(
  request: ChannelRequest,
  copilotz: Copilotz,
  config?: Partial<WhatsAppConfig>,
): Promise<ChannelResponse> {
  const cfg = resolveConfig(config);

  if (request.method === "GET") {
    return handleVerification(request, cfg);
  }

  return handleWebhook(request, copilotz, cfg);
}

// ---------------------------------------------------------------------------
// GET — webhook verification
// ---------------------------------------------------------------------------

function handleVerification(
  request: ChannelRequest,
  config: WhatsAppConfig,
): ChannelResponse {
  const body = request.body as Record<string, unknown> | null;
  const url = safeParseUrl(request.url);

  const mode = (body?.["hub.mode"] ?? url?.searchParams.get("hub.mode")) as string | undefined;
  const token = (body?.["hub.verify_token"] ?? url?.searchParams.get("hub.verify_token")) as string | undefined;
  const challenge = (body?.["hub.challenge"] ?? url?.searchParams.get("hub.challenge")) as string | undefined;

  if (mode === "subscribe" && token === config.webhookVerifyToken) {
    return { status: 200, body: challenge };
  }

  return { status: 403, body: { error: "Forbidden" } };
}

function safeParseUrl(url: string): URL | null {
  try {
    return new URL(url, "http://localhost");
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// POST — inbound webhook
// ---------------------------------------------------------------------------

async function handleWebhook(
  request: ChannelRequest,
  copilotz: Copilotz,
  config: WhatsAppConfig,
): Promise<ChannelResponse> {
  if (config.appSecret) {
    const signature = request.headers.get("x-hub-signature-256");
    if (!signature) {
      return { status: 403, body: { error: "Missing X-Hub-Signature-256 header" } };
    }
    if (!request.rawBody) {
      return { status: 400, body: { error: "Raw body required for signature verification" } };
    }
    const valid = await verifyHmacSha256(request.rawBody, config.appSecret, signature);
    if (!valid) {
      return { status: 403, body: { error: "Invalid webhook signature" } };
    }
  }

  const data = request.body as WhatsAppWebhookPayload;
  const promises: Promise<void>[] = [];

  for (const entry of data.entry || []) {
    for (const change of entry.changes || []) {
      const { messages, metadata, contacts } = change.value || {};
      const phoneNumberId = metadata?.phone_number_id;
      const userName = contacts?.[0]?.profile?.name;

      for (const message of messages || []) {
        const text = message.text?.body;
        const audioBlob = await downloadMedia(message, "audio", config);
        const videoBlob = await downloadMedia(message, "video", config);
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

        const content: MessagePayload["content"] =
          contentParts.length === 0
            ? text || ""
            : contentParts.length === 1 && !mediaBlob
              ? text || ""
              : contentParts;

        const payload: MessagePayload = {
          content,
          sender: {
            type: "user",
            name: userName,
            externalId: message.from,
            metadata: { phone: message.from },
          },
          thread: {
            externalId: message.from,
            metadata: {
              channelId: phoneNumberId,
              businessId: entry.id,
            },
          },
          metadata: {
            user: { name: userName, phone: message.from },
          },
        };

        promises.push(
          processAndRespond(copilotz, payload, config, message.from),
        );
      }
    }
  }

  await Promise.all(promises);
  return { status: 200, body: { status: "ok" } };
}

// ---------------------------------------------------------------------------
// Agent run + respond
// ---------------------------------------------------------------------------

async function processAndRespond(
  copilotz: Copilotz,
  payload: MessagePayload,
  config: WhatsAppConfig,
  recipientPhone: string,
): Promise<void> {
  const controller = await copilotz.run(payload);

  for await (const event of controller.events as AsyncIterable<StreamEvent>) {
    const ep = event.payload as Record<string, unknown>;
    const sender = ep?.sender as Record<string, unknown> | undefined;

    switch (event.type) {
      case "NEW_MESSAGE": {
        if (sender?.type !== "agent") break;
        const text = extractText(ep?.content);
        if (text) {
          await sendText(config, recipientPhone, text);
        }
        break;
      }
      case "ASSET_CREATED": {
        const dataUrl = ep?.dataUrl as string | undefined;
        const mime = ep?.mime as string | undefined;
        if (dataUrl && mime) {
          const uploaded = await uploadMedia(config, dataUrl);
          if (uploaded) {
            await callGraphAPI(config, {
              messaging_product: "whatsapp",
              to: recipientPhone,
              type: uploaded.type,
              [uploaded.type]: { id: uploaded.id },
            });
          }
        }
        break;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Graph API — send text (split at 1500 chars)
// ---------------------------------------------------------------------------

async function sendText(
  config: WhatsAppConfig,
  to: string,
  text: string,
): Promise<void> {
  const chunks = splitString(text, 1500, ["\n", ".", ";"]);
  for (const chunk of chunks) {
    if (!chunk) continue;
    await callGraphAPI(config, {
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body: chunk },
    });
  }
}

// ---------------------------------------------------------------------------
// Graph API — upload media
// ---------------------------------------------------------------------------

function whatsappMediaType(mimeType: string): string {
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("video/")) return "video";
  if (mimeType.startsWith("audio/")) return "audio";
  return "document";
}

async function uploadMedia(
  config: WhatsAppConfig,
  dataUrl: string,
): Promise<{ id: string; type: string } | null> {
  const parsed = parseDataUrl(dataUrl);
  if (!parsed) return null;

  const { bytes, mimeType } = parsed;
  const mediaType = whatsappMediaType(mimeType);
  const formData = new FormData();
  const blob = new Blob([bytes.buffer as ArrayBuffer], { type: mimeType });
  formData.append("file", blob, `file.${mimeType.split("/")[1]}`);
  formData.append("type", mimeType);
  formData.append("messaging_product", "whatsapp");

  try {
    const res = await fetch(
      `https://graph.facebook.com/${config.graphApiVersion}/${config.phoneId}/media?access_token=${config.accessToken}`,
      { method: "POST", body: formData },
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    return { id: json?.id, type: mediaType };
  } catch (err) {
    console.error("[whatsapp] media upload error:", err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Graph API — low-level send
// ---------------------------------------------------------------------------

async function callGraphAPI(
  config: WhatsAppConfig,
  body: Record<string, unknown>,
): Promise<unknown> {
  try {
    const res = await fetch(
      `https://graph.facebook.com/${config.graphApiVersion}/${config.phoneId}/messages?access_token=${config.accessToken}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    console.error("[whatsapp] send error:", err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Graph API — download media (audio/video/document)
// ---------------------------------------------------------------------------

async function downloadMedia(
  message: WhatsAppMessage,
  type: "audio" | "video" | "document",
  config: WhatsAppConfig,
): Promise<Blob | undefined> {
  const ref = message[type];
  if (!ref) return undefined;

  try {
    const metaRes = await fetch(
      `https://graph.facebook.com/${config.graphApiVersion}/${ref.id}/`,
      { headers: { Authorization: `Bearer ${config.accessToken}` } },
    );
    const meta = await metaRes.json();
    if (!meta?.url) return undefined;

    const contentRes = await fetch(meta.url, {
      headers: { Authorization: `Bearer ${config.accessToken}` },
    });
    return await contentRes.blob();
  } catch (err) {
    console.error(`[whatsapp] ${type} download error:`, err);
    return undefined;
  }
}
