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

export type WhatsAppMessage = {
  from: string;
  id: string;
  timestamp: string;
  type: string;
  text?: { body: string };
  audio?: { id: string; mime_type?: string };
  video?: { id: string; mime_type?: string };
  document?: { id: string; mime_type?: string; filename?: string };
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

export type WhatsAppReplyButtonInput = {
  text?: string;
  payload?: string;
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
    action: {
      buttons: Array<{
        type: "reply";
        reply: { id: string; title: string };
      }>;
    };
  };
};

const MAX_REPLY_BUTTONS = 3;
const MAX_REPLY_BUTTON_TITLE_LENGTH = 20;
const MAX_REPLY_BUTTON_ID_LENGTH = 256;

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : value.slice(0, maxLength);
}

function normalizeReplyButtonId(value: string): string {
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

export function buildWhatsAppReplyButtonsPayload(
  to: string,
  action: WhatsAppActionPayload,
): WhatsAppInteractiveButtonMessage | null {
  const text = typeof action.message === "string" ? action.message.trim() : "";
  const items = Array.isArray(action.content) ? action.content : [];
  const buttons:
    WhatsAppInteractiveButtonMessage["interactive"]["action"]["buttons"] = [];
  const seenIds = new Set<string>();

  for (const item of items) {
    if (buttons.length >= MAX_REPLY_BUTTONS) break;
    const title = item?.text?.trim();
    if (!title) continue;

    const idBase = item.payload?.trim() || title;
    let id = normalizeReplyButtonId(idBase);
    if (!id) continue;

    let suffix = 2;
    const baseId = id;
    while (seenIds.has(id)) {
      id = truncate(`${baseId}_${suffix++}`, MAX_REPLY_BUTTON_ID_LENGTH);
    }
    seenIds.add(id);

    buttons.push({
      type: "reply",
      reply: {
        id,
        title: truncate(title, MAX_REPLY_BUTTON_TITLE_LENGTH),
      },
    });
  }

  if (!to || !text || buttons.length === 0) return null;

  return {
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: {
      type: "button",
      body: { text },
      action: { buttons },
    },
  };
}

export async function sendWhatsAppActionMessage(
  config: WhatsAppConfig,
  to: string,
  action: WhatsAppActionPayload,
): Promise<boolean> {
  if (action.type !== "reply_buttons") return false;
  const body = buildWhatsAppReplyButtonsPayload(to, action);
  if (!body) return false;
  return await callWhatsAppGraphAPI(config, body) !== null;
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

export async function callWhatsAppGraphAPI(
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
