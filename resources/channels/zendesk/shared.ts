import { parseDataUrl } from "@/runtime/storage/assets.ts";

export type ZendeskConfig = {
  appId: string;
  apiKey: string;
  apiSecret: string;
  webhookSecret: string;
  businessName: string;
  businessLogo: string | null;
};

type ChannelRuntimeContext = Record<string, unknown> | undefined;

export type ZendeskWebhookPayload = {
  app?: { id: string };
  webhook?: { id: string };
  events?: ZendeskEvent[];
};

export type ZendeskEvent = {
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

export type ZendeskChannelContext = {
  conversationId: string;
  conversationType?: string | null;
  switchboardIntegration?: unknown;
  source?: unknown;
  lastInboundMessageId?: string | null;
};

type ZendeskOutboundMessage = {
  author: {
    type: "business";
    displayName: string;
    avatarUrl: string | null;
  };
  content: {
    type: string;
    text?: string;
    mediaUrl?: string;
    actions?: Array<{
      type: "reply";
      text: string;
      payload: string;
    }>;
  };
};

export function resolveZendeskConfig(
  config?: Partial<ZendeskConfig>,
  context?: ChannelRuntimeContext,
): ZendeskConfig {
  const contextConfig = getZendeskContextConfig(context);
  return {
    appId: contextConfig?.appId || config?.appId ||
      Deno.env.get("ZENDESK_APP_ID") || "",
    apiKey: contextConfig?.apiKey || config?.apiKey ||
      Deno.env.get("ZENDESK_API_KEY") || "",
    apiSecret: contextConfig?.apiSecret || config?.apiSecret ||
      Deno.env.get("ZENDESK_API_SECRET") || "",
    webhookSecret: contextConfig?.webhookSecret || config?.webhookSecret ||
      Deno.env.get("ZENDESK_WEBHOOK_SECRET") || "",
    businessName: contextConfig?.businessName || config?.businessName ||
      Deno.env.get("ZENDESK_BUSINESS_NAME") || "Business",
    businessLogo: contextConfig?.businessLogo ?? config?.businessLogo ??
      Deno.env.get("ZENDESK_BUSINESS_LOGO") ?? null,
  };
}

function getZendeskContextConfig(
  context?: ChannelRuntimeContext,
): Partial<ZendeskConfig> | undefined {
  const channels = context?.channels;
  if (!channels || typeof channels !== "object") return undefined;
  const zendesk = (channels as Record<string, unknown>).zendesk;
  if (!zendesk || typeof zendesk !== "object") return undefined;
  return zendesk as Partial<ZendeskConfig>;
}

export function getZendeskHeaderValue(
  headers: Record<string, string>,
  key: string,
): string | undefined {
  const lowerKey = key.toLowerCase();
  const match = Object.entries(headers).find(([name]) =>
    name.toLowerCase() === lowerKey
  );
  return match?.[1];
}

function businessAuthor(
  config: ZendeskConfig,
): ZendeskOutboundMessage["author"] {
  return {
    type: "business",
    displayName: config.businessName,
    avatarUrl: config.businessLogo,
  };
}

export async function sendZendeskTextMessage(
  config: ZendeskConfig,
  conversationId: string,
  text: string,
): Promise<void> {
  await callZendeskSmoochAPI(config, conversationId, {
    author: businessAuthor(config),
    content: { type: "text", text },
  });
}

export async function sendZendeskActionMessage(
  config: ZendeskConfig,
  conversationId: string,
  action: Record<string, unknown>,
): Promise<void> {
  const items = action.content as
    | Array<{ text: string; payload: string }>
    | undefined;
  if (!items?.length) return;

  await callZendeskSmoochAPI(config, conversationId, {
    author: businessAuthor(config),
    content: {
      type: "text",
      text: (action.message as string) || "",
      actions: items.map((item) => ({
        type: "reply" as const,
        text: item.text,
        payload: item.payload,
      })),
    },
  });
}

const MIME_TO_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
  "image/bmp": "bmp",
  "audio/ogg": "ogg",
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/wav": "wav",
  "audio/webm": "webm",
  "audio/aac": "aac",
  "audio/mp4": "m4a",
  "audio/m4a": "m4a",
  "audio/amr": "amr",
  "audio/opus": "opus",
  "audio/flac": "flac",
  "video/mp4": "mp4",
  "video/webm": "webm",
  "application/pdf": "pdf",
};

function mimeToExt(mime: string): string {
  const base = mime.split(";")[0].trim().toLowerCase();
  return MIME_TO_EXT[base] || base.split("/")[1] || "bin";
}

export async function uploadZendeskAttachment(
  config: ZendeskConfig,
  conversationId: string,
  dataUrl: string,
): Promise<{ mediaUrl: string; mediaType: string } | null> {
  const parsed = parseDataUrl(dataUrl);
  if (!parsed) return null;

  const { bytes, mime: mimeType } = parsed;
  const baseMime = mimeType.split(";")[0].trim();
  const ext = mimeToExt(mimeType);
  const formData = new FormData();
  const blob = new Blob([bytes.buffer as ArrayBuffer], { type: baseMime });
  formData.append("source", blob, `file.${ext}`);

  try {
    const res = await fetch(
      `https://api.smooch.io/v2/apps/${config.appId}/attachments?access=public&for=message&conversationId=${conversationId}`,
      {
        method: "POST",
        headers: {
          Authorization: `Basic ${
            btoa(`${config.apiKey}:${config.apiSecret}`)
          }`,
        },
        body: formData,
      },
    );
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status}: ${body}`);
    }
    const json = await res.json();
    return json?.attachment ?? null;
  } catch (err) {
    console.error("[zendesk] attachment upload error:", err);
    return null;
  }
}

export async function callZendeskSmoochAPI(
  config: ZendeskConfig,
  conversationId: string,
  body: ZendeskOutboundMessage | Record<string, unknown>,
): Promise<unknown> {
  try {
    const res = await fetch(
      `https://api.smooch.io/v2/apps/${config.appId}/conversations/${conversationId}/messages`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Basic ${
            btoa(`${config.apiKey}:${config.apiSecret}`)
          }`,
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

const AUDIO_MIME_MAP: Record<string, string> = {
  "audio/ogg": "audio/opus",
  "audio/x-wav": "audio/wav",
  "audio/x-m4a": "audio/mp4",
};

export function normalizeZendeskAudioMime(raw: string): string {
  const base = raw.split(";")[0].trim().toLowerCase();
  return AUDIO_MIME_MAP[base] || base;
}

export async function startsWithZendeskOggMagic(blob: Blob): Promise<boolean> {
  const slice = blob.slice(0, 4);
  const buf = await slice.arrayBuffer();
  const header = new TextDecoder().decode(buf);
  return header === "OggS";
}
