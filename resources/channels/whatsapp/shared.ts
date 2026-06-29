import { splitString } from "@/server/channels.ts";
import { parseDataUrl } from "@/runtime/storage/assets.ts";

export type WhatsAppConfig = {
  accessToken: string;
  phoneId: string;
  appSecret: string;
  webhookVerifyToken: string;
  graphApiVersion?: string;
};

type ChannelRuntimeContext = Record<string, unknown> | undefined;

export function whatsappChannelDebugEnabled(): boolean {
  const value = Deno.env.get("COPILOTZ_DEBUG_CHANNELS")?.toLowerCase();
  return value === "1" || value === "true";
}

export function debugWhatsAppChannel(
  event: string,
  details: Record<string, unknown>,
): void {
  if (!whatsappChannelDebugEnabled()) return;
  console.log("[copilotz:channels:whatsapp]", { event, ...details });
}

function maskWhatsAppRecipient(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  return value.length <= 4 ? "***" : `***${value.slice(-4)}`;
}

function summarizeWhatsAppMessage(body: Record<string, unknown>) {
  const text = body.text && typeof body.text === "object"
    ? body.text as Record<string, unknown>
    : undefined;
  const interactive = body.interactive && typeof body.interactive === "object"
    ? body.interactive as Record<string, unknown>
    : undefined;

  return {
    type: typeof body.type === "string" ? body.type : null,
    recipient: maskWhatsAppRecipient(body.to),
    textLength: typeof text?.body === "string" ? text.body.length : null,
    interactiveType: typeof interactive?.type === "string"
      ? interactive.type
      : null,
  };
}

function summarizeWhatsAppGraphResponse(payload: unknown) {
  if (!payload || typeof payload !== "object") return {};
  const record = payload as Record<string, unknown>;
  const error = record.error && typeof record.error === "object"
    ? record.error as Record<string, unknown>
    : undefined;
  const messages = Array.isArray(record.messages) ? record.messages : [];
  const firstMessage = messages[0] && typeof messages[0] === "object"
    ? messages[0] as Record<string, unknown>
    : undefined;

  return {
    messageId: typeof firstMessage?.id === "string" ? firstMessage.id : null,
    error: error
      ? {
        message: typeof error.message === "string" ? error.message : null,
        type: typeof error.type === "string" ? error.type : null,
        code: typeof error.code === "number" ? error.code : null,
        errorSubcode: typeof error.error_subcode === "number"
          ? error.error_subcode
          : null,
        fbtraceId: typeof error.fbtrace_id === "string"
          ? error.fbtrace_id
          : null,
      }
      : null,
  };
}

async function readWhatsAppGraphResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export type WhatsAppWebhookEntry = {
  id: string;
  changes?: Array<{
    value: {
      messages?: Array<WhatsAppMessage>;
      metadata?: { phone_number_id?: string };
      contacts?: Array<{ profile?: { name?: string } }>;
    };
  }>;
};

export type WhatsAppInteractiveReply = {
  id?: string;
  title?: string;
  description?: string;
};

export type WhatsAppMessage = {
  from: string;
  id: string;
  timestamp: string;
  type: string;
  text?: { body: string };
  audio?: { id: string; mime_type?: string };
  video?: { id: string; mime_type?: string };
  document?: { id: string; mime_type?: string; filename?: string };
  interactive?: {
    type?: string;
    button_reply?: WhatsAppInteractiveReply;
    list_reply?: WhatsAppInteractiveReply;
  };
};

export type WhatsAppWebhookPayload = {
  entry?: WhatsAppWebhookEntry[];
};

export function resolveWhatsAppConfig(
  config?: Partial<WhatsAppConfig>,
  context?: ChannelRuntimeContext,
): WhatsAppConfig {
  const contextConfig = getWhatsAppContextConfig(context);
  return {
    accessToken: contextConfig?.accessToken || config?.accessToken ||
      Deno.env.get("WHATSAPP_ACCESS_TOKEN") || "",
    phoneId: contextConfig?.phoneId || config?.phoneId ||
      Deno.env.get("WHATSAPP_PHONE_ID") || "",
    appSecret: contextConfig?.appSecret || config?.appSecret ||
      Deno.env.get("WHATSAPP_APP_SECRET") || "",
    webhookVerifyToken: contextConfig?.webhookVerifyToken ||
      config?.webhookVerifyToken ||
      Deno.env.get("WHATSAPP_WEBHOOK_VERIFY_TOKEN") || "",
    graphApiVersion: contextConfig?.graphApiVersion ||
      config?.graphApiVersion || "v25.0",
  };
}

function getWhatsAppContextConfig(
  context?: ChannelRuntimeContext,
): Partial<WhatsAppConfig> | undefined {
  const channels = context?.channels;
  if (!channels || typeof channels !== "object") return undefined;
  const whatsapp = (channels as Record<string, unknown>).whatsapp;
  if (!whatsapp || typeof whatsapp !== "object") return undefined;
  return whatsapp as Partial<WhatsAppConfig>;
}

export function getWhatsAppHeaderValue(
  headers: Record<string, string>,
  key: string,
): string | undefined {
  const lowerKey = key.toLowerCase();
  const match = Object.entries(headers).find(([name]) =>
    name.toLowerCase() === lowerKey
  );
  return match?.[1];
}

export type WhatsAppReplyButtonInput = {
  type?: string;
  text?: string;
  payload?: string;
};

export type WhatsAppReplyButton = {
  type: "reply";
  reply: {
    id: string;
    title: string;
  };
};

export type WhatsAppActionPayload = Record<string, unknown> & {
  type?: string;
  message?: string;
  content?: WhatsAppReplyButtonInput[];
};

export type WhatsAppInteractiveButtonMessage = {
  messaging_product: "whatsapp";
  to: string;
  type: "interactive";
  interactive: {
    type: "button";
    body: { text: string };
    action: { buttons: WhatsAppReplyButton[] };
  };
};

const MAX_REPLY_BUTTONS = 3;
const MAX_REPLY_BUTTON_TITLE_LENGTH = 20;
const MAX_REPLY_BUTTON_ID_LENGTH = 256;

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : value.slice(0, maxLength);
}

function normalizeReplyId(value: string): string {
  return truncate(
    value
      .trim()
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9_-]+/g, "_")
      .replace(/^_+|_+$/g, ""),
    MAX_REPLY_BUTTON_ID_LENGTH,
  );
}

export function normalizeWhatsAppReplyButtons(
  items: WhatsAppReplyButtonInput[] | undefined,
): WhatsAppReplyButton[] {
  const buttons: WhatsAppReplyButton[] = [];
  const seenIds = new Set<string>();

  for (const item of items ?? []) {
    if (buttons.length >= MAX_REPLY_BUTTONS) break;

    const title = truncate(
      item?.text?.trim() ?? "",
      MAX_REPLY_BUTTON_TITLE_LENGTH,
    );
    if (!title) continue;

    const idBase = item?.payload?.trim() || item?.text?.trim() || "";
    const baseId = normalizeReplyId(idBase);
    if (!baseId) continue;

    let id = baseId;
    let suffix = 2;
    while (seenIds.has(id)) {
      id = truncate(`${baseId}_${suffix++}`, MAX_REPLY_BUTTON_ID_LENGTH);
    }
    seenIds.add(id);

    buttons.push({
      type: "reply",
      reply: { id, title },
    });
  }

  return buttons;
}

export function normalizeWhatsAppActionPayload(
  payload: Record<string, unknown> | null | undefined,
): WhatsAppActionPayload | null {
  if (!payload || typeof payload !== "object") return null;

  const nestedAction = payload.action;
  if (nestedAction && typeof nestedAction === "object") {
    const action = nestedAction as WhatsAppActionPayload;
    return {
      ...action,
      message: typeof payload.content === "string"
        ? payload.content
        : (typeof action.message === "string" ? action.message : ""),
    };
  }

  return payload as WhatsAppActionPayload;
}

export function buildWhatsAppReplyButtonsMessage(
  to: string,
  action: WhatsAppActionPayload,
): WhatsAppInteractiveButtonMessage | null {
  const bodyText = typeof action.message === "string"
    ? action.message.trim()
    : "";
  const buttons = normalizeWhatsAppReplyButtons(action.content);
  if (!bodyText || buttons.length === 0) return null;

  return {
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: bodyText },
      action: { buttons },
    },
  };
}

export async function sendWhatsAppActionMessage(
  config: WhatsAppConfig,
  to: string,
  action: WhatsAppActionPayload,
): Promise<void> {
  if (action.type !== "reply_buttons") return;

  const body = buildWhatsAppReplyButtonsMessage(to, action);
  if (!body) return;

  await callWhatsAppGraphAPI(config, body);
}

export async function sendWhatsAppText(
  config: WhatsAppConfig,
  to: string,
  text: string,
): Promise<void> {
  const chunks = splitString(text, 1500, ["\n", ".", ";"]);
  for (const chunk of chunks) {
    if (!chunk) continue;
    await callWhatsAppGraphAPI(config, {
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body: chunk },
    });
  }
}

function whatsappMediaType(mimeType: string): string {
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("video/")) return "video";
  if (mimeType.startsWith("audio/")) return "audio";
  return "document";
}

export async function uploadWhatsAppMedia(
  config: WhatsAppConfig,
  dataUrl: string,
): Promise<{ id: string; type: string } | null> {
  const parsed = parseDataUrl(dataUrl);
  if (!parsed) return null;

  const { bytes, mime: mimeType } = parsed;
  const mediaType = whatsappMediaType(mimeType);
  const formData = new FormData();
  const blob = new Blob([bytes.buffer as ArrayBuffer], { type: mimeType });
  formData.append("file", blob, `file.${mimeType.split("/")[1]}`);
  formData.append("type", mimeType);
  formData.append("messaging_product", "whatsapp");

  try {
    debugWhatsAppChannel("media_upload_request", {
      graphApiVersion: config.graphApiVersion,
      phoneId: config.phoneId || null,
      accessTokenConfigured: config.accessToken.length > 0,
      mimeType,
      byteLength: bytes.byteLength,
    });
    const res = await fetch(
      `https://graph.facebook.com/${config.graphApiVersion}/${config.phoneId}/media?access_token=${config.accessToken}`,
      { method: "POST", body: formData },
    );
    const json = await readWhatsAppGraphResponse(res) as
      | Record<string, unknown>
      | null;
    debugWhatsAppChannel("media_upload_response", {
      status: res.status,
      ok: res.ok,
      ...summarizeWhatsAppGraphResponse(json),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const mediaId = typeof json?.id === "string" ? json.id : null;
    return mediaId ? { id: mediaId, type: mediaType } : null;
  } catch (err) {
    console.error("[whatsapp] media upload error:", err);
    return null;
  }
}

export async function callWhatsAppGraphAPI(
  config: WhatsAppConfig,
  body: Record<string, unknown>,
): Promise<unknown> {
  try {
    debugWhatsAppChannel("message_send_request", {
      graphApiVersion: config.graphApiVersion,
      phoneId: config.phoneId || null,
      accessTokenConfigured: config.accessToken.length > 0,
      message: summarizeWhatsAppMessage(body),
    });
    const res = await fetch(
      `https://graph.facebook.com/${config.graphApiVersion}/${config.phoneId}/messages?access_token=${config.accessToken}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
    );
    const payload = await readWhatsAppGraphResponse(res);
    debugWhatsAppChannel("message_send_response", {
      status: res.status,
      ok: res.ok,
      ...summarizeWhatsAppGraphResponse(payload),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return payload;
  } catch (err) {
    console.error("[whatsapp] send error:", err);
    return null;
  }
}

export async function downloadWhatsAppMedia(
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
