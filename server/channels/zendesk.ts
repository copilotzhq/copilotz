/**
 * Zendesk Sunshine Conversations channel handler.
 *
 * Handles webhook ping (GET) and inbound messages (POST).
 * Responses are pushed back via the Smooch v2 API.
 *
 * @module
 *
 * @example
 * ```ts
 * import { zendeskChannel } from "copilotz/server/channels/zendesk";
 *
 * // Reads ZENDESK_* env vars by default:
 * const res = await zendeskChannel(req, copilotz);
 *
 * // Or pass explicit config:
 * const res = await zendeskChannel(req, copilotz, {
 *   appId: "...",
 *   apiKey: "...",
 *   apiSecret: "...",
 *   webhookSecret: "...",
 *   businessName: "My Business",
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
  timingSafeEqual,
} from "./utils.ts";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export type ZendeskConfig = {
  appId: string;
  apiKey: string;
  apiSecret: string;
  webhookSecret: string;
  businessName: string;
  businessLogo: string | null;
};

function resolveConfig(config?: Partial<ZendeskConfig>): ZendeskConfig {
  return {
    appId: config?.appId || Deno.env.get("ZENDESK_APP_ID") || "",
    apiKey: config?.apiKey || Deno.env.get("ZENDESK_API_KEY") || "",
    apiSecret: config?.apiSecret || Deno.env.get("ZENDESK_API_SECRET") || "",
    webhookSecret: config?.webhookSecret || Deno.env.get("ZENDESK_WEBHOOK_SECRET") || "",
    businessName: config?.businessName || Deno.env.get("ZENDESK_BUSINESS_NAME") || "Business",
    businessLogo: config?.businessLogo ?? Deno.env.get("ZENDESK_BUSINESS_LOGO") ?? null,
  };
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ZendeskWebhookPayload = {
  app?: { id: string };
  webhook?: { id: string };
  events?: ZendeskEvent[];
};

type ZendeskEvent = {
  type: string;
  payload: {
    conversation: {
      id: string;
      type?: string;
      activeSwitchboardIntegration?: unknown;
    };
    message: {
      id: string;
      author: {
        type: string;
        displayName?: string;
        user?: { id?: string; externalId?: string };
      };
      content: {
        type: string;
        text?: string;
        mediaUrl?: string;
        mediaType?: string;
        mediaSize?: number;
        altText?: string;
        fileName?: string;
      };
      source?: { integrationId?: string };
    };
  };
};

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

export async function zendeskChannel(
  request: ChannelRequest,
  copilotz: Copilotz,
  config?: Partial<ZendeskConfig>,
): Promise<ChannelResponse> {
  const cfg = resolveConfig(config);

  if (request.method === "GET") {
    return { status: 200, body: "ok" };
  }

  return handleWebhook(request, copilotz, cfg);
}

// ---------------------------------------------------------------------------
// POST — inbound webhook
// ---------------------------------------------------------------------------

async function handleWebhook(
  request: ChannelRequest,
  copilotz: Copilotz,
  config: ZendeskConfig,
): Promise<ChannelResponse> {
  if (config.webhookSecret) {
    const apiKey = request.headers.get("x-api-key");
    if (!apiKey) {
      return { status: 403, body: { error: "Missing X-API-Key header" } };
    }
    if (!timingSafeEqual(apiKey, config.webhookSecret)) {
      return { status: 403, body: { error: "Invalid webhook secret" } };
    }
  }

  const data = request.body as ZendeskWebhookPayload;
  if (!data.events?.length) {
    return { status: 400, body: { error: "No events found in payload" } };
  }

  const promises: Promise<void>[] = [];

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
        const isAudio =
          content.mediaType?.startsWith("audio/") ||
          /\.(mp3|wav|ogg|m4a|aac)$/i.test(content.fileName || "") ||
          await startsWithOggMagic(blob);
        if (isAudio) audioBlob = blob;
        else mediaBlob = blob;
      } catch (err) {
        console.error("[zendesk] media download error:", err);
      }
    }

    type ContentItem =
      | { type: "text"; text: string }
      | { type: "audio"; dataBase64: string; mimeType: string }
      | { type: "file"; dataBase64: string; mimeType: string; name?: string };

    const contentParts: ContentItem[] = [];
    if (content.text) contentParts.push({ type: "text", text: content.text });
    if (audioBlob) {
      contentParts.push({
        type: "audio",
        dataBase64: await blobToBase64(audioBlob),
        mimeType: normalizeAudioMime(content.mediaType || "audio/ogg"),
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

    const payload: MessagePayload = {
      content: payloadContent,
      sender: {
        type: "user",
        name: author.displayName,
        externalId: author.user?.externalId || author.user?.id,
        metadata: {
          userId: author.user?.id,
          externalId: author.user?.externalId,
        },
      },
      thread: {
        externalId: conversation.id,
        metadata: {
          conversationType: conversation.type,
          switchboardIntegration: conversation.activeSwitchboardIntegration,
          source: message.source,
          messageId: message.id,
        },
      },
      metadata: {
        user: {
          id: author.user?.id,
          externalId: author.user?.externalId,
          name: author.displayName,
        },
      },
    };

    promises.push(
      processAndRespond(copilotz, payload, config, conversation.id),
    );
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
  config: ZendeskConfig,
  conversationId: string,
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
          await sendTextMessage(config, conversationId, text);
        }
        break;
      }
      case "ASSET_CREATED": {
        const by = ep?.by as string | undefined;
        if (by === "user") break;

        const dataUrl = ep?.dataUrl as string | undefined;
        const mime = ep?.mime as string | undefined;
        if (!dataUrl || !mime) break;

        const attachment = await uploadAttachment(config, conversationId, dataUrl);
        if (!attachment) break;

        const mediaType = mime.startsWith("image/") ? "image" : "file";
        await callSmoochAPI(config, conversationId, {
          author: {
            type: "business",
            displayName: config.businessName,
            avatarUrl: config.businessLogo,
          },
          content: {
            type: mediaType,
            mediaUrl: attachment.mediaUrl,
          },
        });
        break;
      }
      case "ACTION": {
        const action = ep as Record<string, unknown>;
        if (action?.type === "reply_buttons") {
          await sendActionMessage(config, conversationId, action);
        }
        break;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Smooch API — send text
// ---------------------------------------------------------------------------

async function sendTextMessage(
  config: ZendeskConfig,
  conversationId: string,
  text: string,
): Promise<void> {
  await callSmoochAPI(config, conversationId, {
    author: {
      type: "business",
      displayName: config.businessName,
      avatarUrl: config.businessLogo,
    },
    content: { type: "text", text },
  });
}

// ---------------------------------------------------------------------------
// Smooch API — send reply_buttons action
// ---------------------------------------------------------------------------

async function sendActionMessage(
  config: ZendeskConfig,
  conversationId: string,
  action: Record<string, unknown>,
): Promise<void> {
  const items = action?.content as Array<{ text: string; payload: string }>;
  if (!items?.length) return;

  await callSmoochAPI(config, conversationId, {
    author: {
      type: "business",
      displayName: config.businessName,
      avatarUrl: config.businessLogo,
    },
    content: {
      type: "text",
      text: (action?.message as string) || "",
      actions: items.map((item) => ({
        type: "reply",
        text: item.text,
        payload: item.payload,
      })),
    },
  });
}

// ---------------------------------------------------------------------------
// Smooch API — upload attachment
// ---------------------------------------------------------------------------

const MIME_TO_EXT: Record<string, string> = {
  "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif",
  "image/webp": "webp", "image/svg+xml": "svg", "image/bmp": "bmp",
  "audio/ogg": "ogg", "audio/mpeg": "mp3", "audio/mp3": "mp3",
  "audio/wav": "wav", "audio/webm": "webm", "audio/aac": "aac",
  "audio/mp4": "m4a", "audio/m4a": "m4a", "audio/amr": "amr",
  "audio/opus": "opus", "audio/flac": "flac",
  "video/mp4": "mp4", "video/webm": "webm",
  "application/pdf": "pdf",
};

function mimeToExt(mime: string): string {
  const base = mime.split(";")[0].trim().toLowerCase();
  return MIME_TO_EXT[base] || base.split("/")[1] || "bin";
}

async function uploadAttachment(
  config: ZendeskConfig,
  conversationId: string,
  dataUrl: string,
): Promise<{ mediaUrl: string; mediaType: string } | null> {
  const parsed = parseDataUrl(dataUrl);
  if (!parsed) return null;

  const { bytes, mimeType } = parsed;
  const baseMime = mimeType.split(";")[0].trim();
  const ext = mimeToExt(mimeType);
  const formData = new FormData();
  const blob = new Blob([bytes], { type: baseMime });
  formData.append("source", blob, `file.${ext}`);

  try {
    const res = await fetch(
      `https://api.smooch.io/v2/apps/${config.appId}/attachments?access=public&for=message&conversationId=${conversationId}`,
      {
        method: "POST",
        headers: {
          Authorization: `Basic ${btoa(`${config.apiKey}:${config.apiSecret}`)}`,
        },
        body: formData,
      },
    );
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status}: ${body}`);
    }
    const json = await res.json();
    return json?.attachment;
  } catch (err) {
    console.error("[zendesk] attachment upload error:", err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Smooch API — low-level POST
// ---------------------------------------------------------------------------

async function callSmoochAPI(
  config: ZendeskConfig,
  conversationId: string,
  body: Record<string, unknown>,
): Promise<unknown> {
  try {
    const res = await fetch(
      `https://api.smooch.io/v2/apps/${config.appId}/conversations/${conversationId}/messages`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Basic ${btoa(`${config.apiKey}:${config.apiSecret}`)}`,
        },
        body: JSON.stringify(body),
      },
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    console.error("[zendesk] send error:", err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Audio utilities
// ---------------------------------------------------------------------------

const AUDIO_MIME_MAP: Record<string, string> = {
  "audio/ogg": "audio/opus",
  "audio/x-wav": "audio/wav",
  "audio/x-m4a": "audio/mp4",
};

function normalizeAudioMime(raw: string): string {
  const base = raw.split(";")[0].trim().toLowerCase();
  return AUDIO_MIME_MAP[base] || base;
}

async function startsWithOggMagic(blob: Blob): Promise<boolean> {
  const slice = blob.slice(0, 4);
  const buf = await slice.arrayBuffer();
  const header = new TextDecoder().decode(buf);
  return header === "OggS";
}
