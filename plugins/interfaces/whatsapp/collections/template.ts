/**
 * Templates said in WhatsApp chats (`whatsapp.template`), by the chat
 * message that says them: what goes to the phone in that message's place
 * (Meta's name and language for it, and its components, its parameters
 * filled), as it was when it was said. Written before the message, so the
 * message's delivery finds it. No events (the message is what's on the
 * record), and nothing outside reads it; it's erased with its contact.
 */
import { defineCollection, type Infer } from "../../../../runtime/mod.ts";

const templateSchema = {
  type: "object",
  properties: {
    /** Its chat. */
    thread: { type: "string" },
    /** The app's name for it (`whatsappTemplates`). */
    template: { type: "string" },
    /** Meta's name for it, and its language. */
    name: { type: "string" },
    language: { type: "string" },
    /** As the Graph API takes them: its body's parameters, a header's, a button's. */
    components: { type: "array", items: { type: "object" } },
    at: { type: "string" },
  },
  required: ["thread", "template", "name", "language", "at"],
} as const;

export const templated = defineCollection({
  schema: templateSchema,
  events: false,
  indexes: [["thread"]],
});

export type WhatsAppTemplated = Infer<typeof templateSchema> & { _id: string };
