/**
 * Phones that wrote to a connected number, by number and WhatsApp id
 * (`<number>:<wa_id>`): whom each is linked to (`person`), once they've
 * sent the code the app gave them, and, for them, where their messages go
 * (`space`, their Personal space unless they chose another; `thread`, the
 * conversation they're in). One that isn't linked is only what's needed to
 * answer it politely, once a day, and to stop guessing codes. Each person
 * reads their own.
 */
import { defineCollection, type Infer } from "../../../../runtime/mod.ts";

const phoneSchema = {
  type: "object",
  properties: {
    /** The connected number it wrote to. */
    number: { type: "string" },
    /** Its WhatsApp id: the phone number, digits only. */
    phone: { type: "string" },
    /** The name its WhatsApp profile shows. */
    name: { type: "string" },
    /** Whose phone it is, once linked. */
    person: { type: "string" },
    linked: { type: "string" },
    /** The space their messages go to; their Personal space without one. */
    space: { type: "string" },
    /** The conversation their messages go to; a new one without it. */
    thread: { type: "string" },
    /** When it was last told how to link: once a day. */
    told: { type: "string" },
    /** Codes it sent that didn't match, since `since`. */
    tries: { type: "integer" },
    since: { type: "string" },
    at: { type: "string" },
  },
  required: ["number", "phone", "at"],
} as const;

export const phone = defineCollection({ schema: phoneSchema, indexes: [["person"]] });

export type WhatsAppPhone = Infer<typeof phoneSchema> & { _id: string };
