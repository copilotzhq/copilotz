/**
 * WhatsApp Business numbers connected to the app, each in a space (an
 * org's, a team's): its members see it and link their phones to it; those
 * who manage the space connect and disconnect it. What Meta knows it by (its
 * phone number id) and as (the number shown, the business's name). Its
 * credentials aren't here: they're in `whatsapp_secret`, which nothing
 * outside reads and no event carries.
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
    at: { type: "string" },
  },
  required: ["in", "phoneId", "phone", "at"],
} as const;

export const number = defineCollection({ schema: numberSchema, indexes: [["phoneId"]] });

export type WhatsAppNumber = Infer<typeof numberSchema> & { _id: string };
