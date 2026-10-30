/**
 * Connected numbers' credentials, by the number's id: the access token the
 * app calls Meta with, the Meta app's secret (which signs what its webhook
 * delivers) and the webhook's verify token. No events (they'd carry them in
 * the log), no rule (nothing outside reads them): only this plugin's code,
 * acting as the system where it must.
 */
import { defineCollection, type Infer } from "../../../../runtime/mod.ts";

const secretSchema = {
  type: "object",
  properties: {
    /** The access token the app calls the Graph API with. */
    token: { type: "string" },
    /** The Meta app's secret, which signs what its webhook delivers. */
    secret: { type: "string" },
    /** What Meta shows to check the webhook is ours, when it's set up. */
    verify: { type: "string" },
  },
  required: ["token", "secret", "verify"],
} as const;

export const secret = defineCollection({
  schema: secretSchema,
  events: false,
  private: ["token", "secret", "verify"],
});

export type WhatsAppSecret = Infer<typeof secretSchema> & { _id: string };
