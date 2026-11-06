/**
 * A chat message on WhatsApp (the `whatsapp.message` View): its
 * Markdown as WhatsApp formats it, in parts of at most 4096 characters split
 * where a reader would pause, then its files: pictures (jpeg or png, up to
 * 5 MB) as images, anything else as documents. A short text goes as the
 * first file's caption: one message, not two. An app shows its messages
 * otherwise with a `whatsapp.message` View of its own (the last
 * plugin's wins).
 */
import type { ViewContext } from "../../../../runtime/mod.ts";
import type { Message } from "../../../agents/chat/contract.ts";
import { joined, type WaPart } from "../shared/parts.ts";
import { split, toWhatsApp } from "../shared/text.ts";

const PICTURE = 5 * 1024 * 1024;

export const messageView = (m: Message, _ctx: ViewContext): WaPart[] => {
  const texts = split(toWhatsApp(m.text ?? "")).filter(Boolean);
  const files = (m.files ?? []).map((f): WaPart =>
    /^image\/(jpeg|png)$/.test(f.type) && f.size <= PICTURE
      ? { type: "image", image: { file: f.id } }
      : { type: "document", document: { file: f.id }, filename: f.name }
  );
  const words: WaPart[] = texts.map((text) => ({ type: "text", text }));
  // A short text and its files: the text as the first one's caption.
  const captioned = texts.length === 1 && files.length ? joined(texts[0], files[0]) : undefined;
  return captioned ? [captioned, ...files.slice(1)] : [...words, ...files];
};
