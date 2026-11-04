/**
 * WhatsApp Business numbers connected to the app, each in a space (an
 * org's, a team's): its members see it and link their phones to it; those
 * who manage the space connect and disconnect it, and may open it to anyone
 * (`open`: a customer line, whose strangers are contacts, answered by
 * `agent`). What Meta knows it by (its phone number id) and as (the number
 * shown, the business's name). Its credentials aren't here: they're in
 * `whatsapp_secret`, which nothing outside reads and no event carries.
 */
import { defineCollection, type Infer } from "../../../../runtime/mod.ts";

const numberSchema = {
  type: "object",
  properties: {
    /** The space it's connected to. */
    in: { type: "string" },
    /** Meta's id for it (the phone number id), which messages to it name. */
    phoneId: { type: "string" },
    /** The number as people dial it: "+1 555-0100". */
    phone: { type: "string" },
    /** The business's name, as Meta verified it. */
    name: { type: "string" },
    /** Where the app is (what people open to link their phone). */
    url: { type: "string" },
    /** Who connected it: `person:ana`. */
    by: { type: "string" },
    /** What went wrong last talking to Meta (its token refused, say), until it works again. */
    problem: { type: "string" },
    /** Open to anyone: a customer line. Strangers who write are contacts, each in a chat. */
    open: { type: "boolean" },
    /** Who answers its customers: an agent of its space (else who answers new chats there). */
    agent: { type: "string" },
    /** Hours of quiet after which a customer's next message starts a new chat (`GAP`). */
    gap: { type: "number" },
    /** Messages a customer may send a minute (20): more go unanswered. */
    rate: { type: "integer" },
    /** What customers are told in, when their message can't go on: `en`, `pt`. */
    language: { type: "string", enum: ["en", "pt"] },
    at: { type: "string" },
  },
  required: ["in", "phoneId", "phone", "at"],
} as const;

/**
 * Hours a customer's chat stays the one they're in, quiet: past them, their
 * next message starts a new chat. Twelve: a conversation that goes on later
 * the same day (asking in the morning, paying at lunch) stays one chat, and
 * one the next morning starts afresh, inside the 24 hours Meta lets a
 * business answer freely.
 */
export const GAP = 12;

export const number = defineCollection({ schema: numberSchema, indexes: [["phoneId"]] });

export type WhatsAppNumber = Infer<typeof numberSchema> & { _id: string };
