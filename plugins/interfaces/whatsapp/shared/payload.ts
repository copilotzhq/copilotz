/**
 * What a webhook delivery says, as WhatsApp's Cloud API sends it: for each
 * business number (by its phone number id), the messages people sent it,
 * with who sent each (their WhatsApp id, the phone number they write from)
 * and the name their profile shows. Statuses of what was sent are left out.
 *
 * ```json
 * { "object": "whatsapp_business_account", "entry": [{ "changes": [{ "field": "messages",
 *   "value": { "metadata": { "phone_number_id": "1234" },
 *     "contacts": [{ "wa_id": "5511…", "profile": { "name": "Ana" } }],
 *     "messages": [{ "id": "wamid.…", "from": "5511…", "type": "text", "text": { "body": "hi" } }] } }] }] }
 * ```
 */

/** A message as WhatsApp sends it: its id, its sender, its kind, and that kind's fields. */
export type WaMessage = {
  id: string;
  from: string;
  type: string;
  timestamp?: string;
  /** What it replies to (a message the number sent, quoted). */
  context?: { id?: string; from?: string };
  text?: { body: string };
  image?: WaMedia;
  audio?: WaMedia & { voice?: boolean };
  video?: WaMedia;
  document?: WaMedia & { filename?: string };
  sticker?: WaMedia;
  location?: { latitude: number; longitude: number; name?: string; address?: string };
  button?: { text?: string };
  interactive?: {
    button_reply?: { title?: string };
    list_reply?: { title?: string; description?: string };
  };
  [more: string]: unknown;
};

export type WaMedia = { id: string; mime_type?: string; caption?: string };

export type Inbound = { phoneId: string; message: WaMessage; name?: string };

const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

/** The messages a delivery carries, each with the number it was sent to. */
export function inboundOf(payload: unknown): Inbound[] {
  if (!isObject(payload) || !Array.isArray(payload.entry)) return [];
  return payload.entry.flatMap((entry) =>
    (isObject(entry) && Array.isArray(entry.changes) ? entry.changes : []).flatMap((change) => {
      const value = isObject(change) && isObject(change.value) ? change.value : undefined;
      const phoneId = isObject(value?.metadata) ? value.metadata.phone_number_id : undefined;
      if (typeof phoneId !== "string" || !Array.isArray(value?.messages)) return [];
      const names = new Map(
        (Array.isArray(value.contacts) ? value.contacts : []).flatMap((c) =>
          isObject(c) && typeof c.wa_id === "string"
            ? [[c.wa_id, isObject(c.profile) ? String(c.profile.name ?? "") : ""]]
            : []
        ),
      );
      return value.messages.flatMap((m): Inbound[] =>
        isObject(m) && typeof m.id === "string" && typeof m.from === "string" &&
          typeof m.type === "string"
          ? [{
            phoneId,
            message: m as WaMessage,
            ...(names.get(m.from) ? { name: names.get(m.from) } : {}),
          }]
          : []
      );
    })
  );
}

/** The media a message carries, if any: what to fetch, and what to call it. */
export function mediaOf(m: WaMessage): { id: string; type: string; name: string } | undefined {
  const extension = (type: string, fallback: string) =>
    ({
      "image/jpeg": "jpg",
      "image/png": "png",
      "image/webp": "webp",
      "audio/ogg": "ogg",
      "audio/mpeg": "mp3",
      "audio/mp4": "m4a",
      "audio/aac": "aac",
      "audio/amr": "amr",
      "video/mp4": "mp4",
      "video/3gpp": "3gp",
      "application/pdf": "pdf",
    } as Record<string, string>)[type.split(";")[0].trim()] ?? fallback;
  const of = (media: WaMedia | undefined, base: string, fallback: string, name?: string) => {
    if (!media?.id) return undefined;
    const type = media.mime_type ?? "application/octet-stream";
    return { id: media.id, type, name: name || `${base}.${extension(type, fallback)}` };
  };
  switch (m.type) {
    case "image":
      return of(m.image, "photo", "jpg");
    case "sticker":
      return of(m.sticker, "sticker", "webp");
    case "audio":
      return of(m.audio, m.audio?.voice ? "voice-note" : "audio", "ogg");
    case "video":
      return of(m.video, "video", "mp4");
    case "document":
      return of(m.document, "document", "bin", m.document?.filename);
  }
  return undefined;
}

/** What a message says in words: its text, a caption, a button's title, a place. */
export function wordsOf(m: WaMessage): string {
  switch (m.type) {
    case "text":
      return m.text?.body ?? "";
    case "image":
    case "video":
    case "document":
      return (m[m.type] as WaMedia | undefined)?.caption ?? "";
    case "button":
      return m.button?.text ?? "";
    case "interactive":
      return m.interactive?.button_reply?.title ?? m.interactive?.list_reply?.title ?? "";
    case "location": {
      const at = m.location;
      if (!at) return "";
      const where = [at.name, at.address].filter(Boolean).join(", ");
      return `📍 ${where ? `${where} ` : ""}(${at.latitude}, ${at.longitude})`.trim();
    }
  }
  return "";
}
