/**
 * A chat message on WhatsApp (the `message` View, renderer `whatsapp`): its
 * Markdown as WhatsApp formats it, in parts of at most 4096 characters split
 * where a reader would pause. An app shows its messages otherwise with a
 * `message` View of its own in this medium (the last plugin's wins).
 */
import type { ViewContext } from "../../../../runtime/mod.ts";
import type { Message } from "../../../agents/chat/contract.ts";
import type { WaPart } from "../shared/parts.ts";
import { split, toWhatsApp } from "../shared/text.ts";

export const messageView = (m: Message, _ctx: ViewContext): WaPart[] =>
  split(toWhatsApp(m.text ?? "")).filter(Boolean).map((text) => ({ type: "text", text }));
