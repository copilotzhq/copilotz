import type {
  WhatsAppActionPayload,
  WhatsAppMediaCarouselAction,
  WhatsAppMediaInput,
  WhatsAppReplyButton,
  WhatsAppReplyButtonInput,
  WhatsAppResolvedCarouselCard,
  WhatsAppResolvedMediaCarouselAction,
  WhatsAppUploadedMedia,
} from "./types.ts";

const MAX_REPLY_BUTTONS = 3;
const MAX_REPLY_BUTTON_TITLE_LENGTH = 20;
const MAX_REPLY_BUTTON_ID_LENGTH = 256;
const MIN_CAROUSEL_CARDS = 2;
const MAX_CAROUSEL_CARDS = 10;
const MAX_CAROUSEL_MESSAGE_LENGTH = 1024;
const MAX_CAROUSEL_CARD_BODY_LENGTH = 160;
const MAX_CAROUSEL_CARD_LINE_BREAKS = 2;
const MAX_CAROUSEL_IMAGE_BYTES = 5 * 1024 * 1024;

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : value.slice(0, maxLength);
}

function normalizeReplyId(value: string): string {
  return truncate(
    value.trim().toLowerCase().normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9_-]+/g, "_")
      .replace(/^_+|_+$/g, ""),
    MAX_REPLY_BUTTON_ID_LENGTH,
  );
}

export function normalizeWhatsAppReplyButtons(
  items: readonly WhatsAppReplyButtonInput[] | undefined,
): readonly WhatsAppReplyButton[] {
  const buttons: WhatsAppReplyButton[] = [];
  const seenIds = new Set<string>();
  for (const item of items ?? []) {
    if (buttons.length >= MAX_REPLY_BUTTONS) break;
    const title = truncate(
      typeof item?.text === "string" ? item.text.trim() : "",
      MAX_REPLY_BUTTON_TITLE_LENGTH,
    );
    if (!title) continue;
    const source = typeof item.payload === "string" && item.payload.trim()
      ? item.payload
      : item.text ?? "";
    const baseId = normalizeReplyId(source);
    if (!baseId) continue;
    let id = baseId;
    let suffix = 2;
    while (seenIds.has(id)) {
      id = truncate(`${baseId}_${suffix++}`, MAX_REPLY_BUTTON_ID_LENGTH);
    }
    seenIds.add(id);
    buttons.push({ type: "reply", reply: { id, title } });
  }
  return Object.freeze(buttons);
}

export function normalizeWhatsAppActionPayload(
  payload: unknown,
): WhatsAppActionPayload | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }
  const record = payload as Record<string, unknown>;
  const nested = record.action;
  if (nested && typeof nested === "object" && !Array.isArray(nested)) {
    const action = nested as WhatsAppActionPayload;
    return {
      ...action,
      message: typeof record.content === "string"
        ? record.content
        : typeof action.message === "string"
        ? action.message
        : "",
    };
  }
  return record as WhatsAppActionPayload;
}

export function buildWhatsAppReplyButtonsMessage(
  to: string,
  action: WhatsAppActionPayload,
): Readonly<Record<string, unknown>> | null {
  const text = typeof action.message === "string" ? action.message.trim() : "";
  const buttons = normalizeWhatsAppReplyButtons(action.content);
  if (!text || buttons.length === 0) return null;
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

function normalizeCarouselBody(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.replace(/\r\n?/g, "\n")
    .split("\n", MAX_CAROUSEL_CARD_LINE_BREAKS + 1).join("\n").trim();
  return normalized
    ? truncate(normalized, MAX_CAROUSEL_CARD_BODY_LENGTH)
    : undefined;
}

function carouselButtons(
  values: WhatsAppMediaCarouselAction["cards"][number]["buttons"],
): WhatsAppResolvedCarouselCard["buttons"] | null {
  if (!values?.length || values.length > MAX_REPLY_BUTTONS) return null;
  const result: Array<{
    type: "quick_reply";
    text: string;
    payload: string;
  }> = [];
  for (const value of values) {
    if (value.type && value.type !== "quick_reply") return null;
    const text = truncate(
      value.text?.trim() ?? "",
      MAX_REPLY_BUTTON_TITLE_LENGTH,
    );
    const payload = truncate(
      value.payload?.trim() ?? "",
      MAX_REPLY_BUTTON_ID_LENGTH,
    );
    if (!text || !payload) return null;
    result.push({ type: "quick_reply", text, payload });
  }
  return Object.freeze(result);
}

export async function resolveWhatsAppMediaCarouselAction(
  action: WhatsAppMediaCarouselAction,
  upload: (
    input: WhatsAppMediaInput,
  ) => Promise<WhatsAppUploadedMedia>,
): Promise<WhatsAppResolvedMediaCarouselAction | null> {
  const message = truncate(
    action.message?.trim() ?? "",
    MAX_CAROUSEL_MESSAGE_LENGTH,
  );
  if (
    !message || action.cards.length < MIN_CAROUSEL_CARDS ||
    action.cards.length > MAX_CAROUSEL_CARDS
  ) return null;
  const cards: WhatsAppResolvedCarouselCard[] = [];
  for (const card of action.cards) {
    const buttons = carouselButtons(card.buttons);
    if (!buttons) return null;
    const imageId = card.image?.id?.trim();
    const imageLink = card.image?.link?.trim();
    let image: WhatsAppResolvedCarouselCard["image"] | null = imageId
      ? { id: imageId }
      : imageLink && /^https:\/\//i.test(imageLink)
      ? { link: imageLink }
      : null;
    if (!image) {
      const bytes = card.image?.bytes;
      const mediaType = card.image?.mediaType?.trim() ?? "";
      if (
        !(bytes instanceof Uint8Array) || bytes.byteLength === 0 ||
        bytes.byteLength > MAX_CAROUSEL_IMAGE_BYTES ||
        !mediaType.startsWith("image/")
      ) return null;
      const uploaded = await upload({ bytes, mediaType });
      if (uploaded.type !== "image") return null;
      image = { id: uploaded.id };
    }
    const body = normalizeCarouselBody(card.body);
    cards.push(Object.freeze({ ...(body ? { body } : {}), image, buttons }));
  }
  const count = cards[0]?.buttons.length;
  if (!count || cards.some((card) => card.buttons.length !== count)) {
    return null;
  }
  const replyIds = cards.flatMap((card) =>
    card.buttons.map((button) => button.payload)
  );
  if (new Set(replyIds).size !== replyIds.length) return null;
  const fallbackText = action.fallbackText?.trim();
  return Object.freeze({
    type: "media_carousel",
    message,
    ...(fallbackText ? { fallbackText } : {}),
    cards: Object.freeze(cards),
  });
}

export function buildWhatsAppMediaCarouselMessage(
  to: string,
  action: WhatsAppResolvedMediaCarouselAction,
): Readonly<Record<string, unknown>> | null {
  if (
    !to || !action.message || action.cards.length < MIN_CAROUSEL_CARDS ||
    action.cards.length > MAX_CAROUSEL_CARDS
  ) return null;
  return {
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: {
      type: "carousel",
      body: { text: action.message },
      action: {
        cards: action.cards.map((card, index) => ({
          card_index: index,
          type: "cta_url",
          header: { type: "image", image: card.image },
          ...(card.body ? { body: { text: card.body } } : {}),
          action: {
            buttons: card.buttons.map((button) => ({
              type: "quick_reply",
              quick_reply: { id: button.payload, title: button.text },
            })),
          },
        })),
      },
    },
  };
}

/** Splits outbound text without coupling channel code to an HTTP server. */
export function splitWhatsAppText(
  text: string,
  limit = 1500,
): readonly string[] {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new TypeError("WhatsApp text limit must be positive.");
  }
  const result: string[] = [];
  let remaining = text.trim();
  while (remaining.length > limit) {
    const window = remaining.slice(0, limit + 1);
    const candidates = [
      window.lastIndexOf("\n"),
      window.lastIndexOf("."),
      window.lastIndexOf(";"),
    ];
    const boundary = Math.max(...candidates);
    const take = boundary > Math.floor(limit / 2) ? boundary + 1 : limit;
    result.push(remaining.slice(0, take).trim());
    remaining = remaining.slice(take).trimStart();
  }
  if (remaining) result.push(remaining);
  return Object.freeze(result);
}
