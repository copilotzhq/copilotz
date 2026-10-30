/**
 * Sign-ins under way: one per person and provider, kept by the hash of its
 * state, with its PKCE verifier and where the provider sends the person
 * back. Live state: in the owner's memory, never stored, and gone if it
 * restarts (the person starts again). Nobody reads it but the plugin's own
 * Actions, and each is used once, within ten minutes.
 */
import { defineCollection, type Infer } from "../../../../runtime/mod.ts";

const flowSchema = {
  type: "object",
  properties: {
    person: { type: "string" },
    provider: { type: "string" },
    verifier: { type: "string" },
    redirect: { type: "string" },
    expires: { type: "string" },
  },
  required: ["person", "provider", "verifier", "redirect", "expires"],
} as const;

export const accountFlow = defineCollection({ schema: flowSchema, durable: false });

export type Flow = Infer<typeof flowSchema> & { _id: string };
