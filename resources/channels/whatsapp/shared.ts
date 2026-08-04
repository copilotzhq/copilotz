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
  const action = interactive?.action && typeof interactive.action === "object"
    ? interactive.action as Record<string, unknown>
    : undefined;

  return {
    type: typeof body.type === "string" ? body.type : null,
    recipient: maskWhatsAppRecipient(body.to),
    textLength: typeof text?.body === "string" ? text.body.length : null,
    interactiveType: typeof interactive?.type === "string"
      ? interactive.type
      : null,
    carouselCardCount: Array.isArray(action?.cards)
      ? action.cards.length
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
  fallbackText?: string;
  cards?: WhatsAppMediaCarouselCardInput[];
};

export type WhatsAppMediaBytesInput = {
  bytes: Uint8Array;
  mimeType: string;
};

export type WhatsAppMediaUploadInput = string | WhatsAppMediaBytesInput;

export type WhatsAppCarouselImageInput = {
  id?: string;
  link?: string;
  dataUrl?: string;
  bytes?: Uint8Array;
  mimeType?: string;
};

export type WhatsAppCarouselQuickReplyInput = {
  type?: "quick_reply";
  text?: string;
  payload?: string;
};

export type WhatsAppMediaCarouselCardInput = {
  body?: string;
  image?: WhatsAppCarouselImageInput;
  /** Opaque client-owned input that an egress override can turn into `image`. */
  renderData?: unknown;
  buttons?: WhatsAppCarouselQuickReplyInput[];
};

export type WhatsAppMediaCarouselAction = WhatsAppActionPayload & {
  type: "media_carousel";
  message: string;
  fallbackText?: string;
  cards: WhatsAppMediaCarouselCardInput[];
};

export type WhatsAppResolvedCarouselCard = {
  body?: string;
  image: { id: string } | { link: string };
  buttons: Array<{
    type: "quick_reply";
    text: string;
    payload: string;
  }>;
};

export type WhatsAppResolvedMediaCarouselAction = {
  type: "media_carousel";
  message: string;
  fallbackText?: string;
  cards: WhatsAppResolvedCarouselCard[];
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

export type WhatsAppInteractiveMediaCarouselMessage = {
  messaging_product: "whatsapp";
  to: string;
  type: "interactive";
  interactive: {
    type: "carousel";
    body: { text: string };
    action: {
      cards: Array<{
        card_index: number;
        type: "cta_url";
        header: {
          type: "image";
          image: { id: string } | { link: string };
        };
        body?: { text: string };
        action: {
          buttons: Array<{
            type: "quick_reply";
            quick_reply: { id: string; title: string };
          }>;
        };
      }>;
    };
  };
};

const MAX_REPLY_BUTTONS = 3;
const MAX_REPLY_BUTTON_TITLE_LENGTH = 20;
const MAX_REPLY_BUTTON_ID_LENGTH = 256;
const MIN_CAROUSEL_CARDS = 2;
const MAX_CAROUSEL_CARDS = 10;
const MAX_CAROUSEL_MESSAGE_LENGTH = 1024;
const MAX_CAROUSEL_CARD_BODY_LENGTH = 160;
const MAX_CAROUSEL_CARD_LINE_BREAKS = 2;
const MAX_CAROUSEL_IMAGE_BYTES = 5 * 1024 * 1024;
const CAROUSEL_UPLOAD_CONCURRENCY = 3;

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

function normalizeCarouselBody(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value
    .replace(/\r\n?/g, "\n")
    .split("\n", MAX_CAROUSEL_CARD_LINE_BREAKS + 1)
    .join("\n")
    .trim();
  return normalized
    ? truncate(normalized, MAX_CAROUSEL_CARD_BODY_LENGTH)
    : undefined;
}

function normalizeCarouselButtons(
  items: WhatsAppCarouselQuickReplyInput[] | undefined,
): WhatsAppResolvedCarouselCard["buttons"] | null {
  if (
    !Array.isArray(items) || items.length === 0 ||
    items.length > MAX_REPLY_BUTTONS
  ) {
    return null;
  }

  const buttons: WhatsAppResolvedCarouselCard["buttons"] = [];
  for (const item of items) {
    if (item?.type && item.type !== "quick_reply") return null;
    const text = truncate(
      typeof item?.text === "string" ? item.text.trim() : "",
      MAX_REPLY_BUTTON_TITLE_LENGTH,
    );
    const payload = truncate(
      typeof item?.payload === "string" ? item.payload.trim() : "",
      MAX_REPLY_BUTTON_ID_LENGTH,
    );
    if (!text || !payload) return null;
    buttons.push({ type: "quick_reply", text, payload });
  }
  return buttons;
}

function resolvedCarouselImage(
  image: WhatsAppCarouselImageInput | undefined,
): WhatsAppResolvedCarouselCard["image"] | null {
  const id = typeof image?.id === "string" ? image.id.trim() : "";
  if (id) return { id };
  const link = typeof image?.link === "string" ? image.link.trim() : "";
  if (link && /^https:\/\//i.test(link)) return { link };
  return null;
}

function carouselUploadInput(
  image: WhatsAppCarouselImageInput | undefined,
): WhatsAppMediaUploadInput | null {
  if (typeof image?.dataUrl === "string" && image.dataUrl.length > 0) {
    const parsed = parseDataUrl(image.dataUrl);
    if (
      parsed?.mime.startsWith("image/") && parsed.bytes.byteLength > 0 &&
      parsed.bytes.byteLength <= MAX_CAROUSEL_IMAGE_BYTES
    ) {
      return { bytes: parsed.bytes, mimeType: parsed.mime };
    }
    return null;
  }
  if (
    image?.bytes instanceof Uint8Array &&
    typeof image.mimeType === "string" &&
    image.mimeType.startsWith("image/") &&
    image.bytes.byteLength > 0 &&
    image.bytes.byteLength <= MAX_CAROUSEL_IMAGE_BYTES
  ) {
    return { bytes: image.bytes, mimeType: image.mimeType };
  }
  return null;
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, values.length) },
    async () => {
      while (nextIndex < values.length) {
        const index = nextIndex++;
        results[index] = await mapper(values[index], index);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

export async function resolveWhatsAppMediaCarouselAction(
  config: WhatsAppConfig,
  action: WhatsAppMediaCarouselAction,
): Promise<WhatsAppResolvedMediaCarouselAction | null> {
  const message = truncate(
    typeof action.message === "string" ? action.message.trim() : "",
    MAX_CAROUSEL_MESSAGE_LENGTH,
  );
  const cards = Array.isArray(action.cards) ? action.cards : [];
  if (
    !message || cards.length < MIN_CAROUSEL_CARDS ||
    cards.length > MAX_CAROUSEL_CARDS
  ) {
    return null;
  }

  const resolved = await mapWithConcurrency(
    cards,
    CAROUSEL_UPLOAD_CONCURRENCY,
    async (card): Promise<WhatsAppResolvedCarouselCard | null> => {
      const buttons = normalizeCarouselButtons(card?.buttons);
      if (!buttons) return null;
      const body = normalizeCarouselBody(card?.body);

      let image = resolvedCarouselImage(card?.image);
      if (!image) {
        const uploadInput = carouselUploadInput(card?.image);
        if (!uploadInput) return null;
        const uploaded = await uploadWhatsAppMedia(config, uploadInput);
        if (!uploaded || uploaded.type !== "image") return null;
        image = { id: uploaded.id };
      }

      return {
        ...(body ? { body } : {}),
        image,
        buttons,
      };
    },
  );

  if (resolved.some((card) => card === null)) return null;
  const normalizedCards = resolved as WhatsAppResolvedCarouselCard[];
  const buttonCount = normalizedCards[0]?.buttons.length;
  if (
    !buttonCount ||
    normalizedCards.some((card) => card.buttons.length !== buttonCount)
  ) {
    return null;
  }

  const replyIds = normalizedCards.flatMap((card) =>
    card.buttons.map((button) => button.payload)
  );
  if (new Set(replyIds).size !== replyIds.length) return null;

  const fallbackText = typeof action.fallbackText === "string"
    ? action.fallbackText.trim()
    : "";
  return {
    type: "media_carousel",
    message,
    ...(fallbackText ? { fallbackText } : {}),
    cards: normalizedCards,
  };
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

export function buildWhatsAppMediaCarouselMessage(
  to: string,
  action: WhatsAppResolvedMediaCarouselAction,
): WhatsAppInteractiveMediaCarouselMessage | null {
  if (
    !to || !action.message ||
    action.cards.length < MIN_CAROUSEL_CARDS ||
    action.cards.length > MAX_CAROUSEL_CARDS
  ) {
    return null;
  }

  return {
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: {
      type: "carousel",
      body: { text: action.message },
      action: {
        cards: action.cards.map((card, cardIndex) => ({
          card_index: cardIndex,
          type: "cta_url",
          header: { type: "image", image: card.image },
          ...(card.body ? { body: { text: card.body } } : {}),
          action: {
            buttons: card.buttons.map((button) => ({
              type: "quick_reply" as const,
              quick_reply: {
                id: button.payload,
                title: button.text,
              },
            })),
          },
        })),
      },
    },
  };
}

export async function sendWhatsAppMediaCarouselMessage(
  config: WhatsAppConfig,
  to: string,
  action: WhatsAppMediaCarouselAction,
): Promise<boolean> {
  const resolved = await resolveWhatsAppMediaCarouselAction(config, action);
  if (!resolved) return false;
  const body = buildWhatsAppMediaCarouselMessage(to, resolved);
  if (!body) return false;
  return (await callWhatsAppGraphAPI(config, body)) !== null;
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
  input: WhatsAppMediaUploadInput,
): Promise<{ id: string; type: string } | null> {
  const parsed = typeof input === "string" ? parseDataUrl(input) : null;
  const bytes = parsed?.bytes ??
    (typeof input === "object" ? input.bytes : undefined);
  const mimeType = parsed?.mime ??
    (typeof input === "object" ? input.mimeType : undefined);
  if (
    !(bytes instanceof Uint8Array) || bytes.byteLength === 0 ||
    typeof mimeType !== "string" || !mimeType.includes("/")
  ) {
    return null;
  }

  const mediaType = whatsappMediaType(mimeType);
  const formData = new FormData();
  const arrayBuffer = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  const blob = new Blob([arrayBuffer], { type: mimeType });
  const extension = mimeType.split("/")[1]?.replace(/[^a-z0-9.+-]/gi, "") ||
    "bin";
  formData.append("file", blob, `file.${extension}`);
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
