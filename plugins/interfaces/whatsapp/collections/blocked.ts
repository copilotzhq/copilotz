/**
 * Phones a number's people blocked (`whatsapp.block`), by the number and a
 * hash of the phone (`<number>:<sha256>`): what they send goes nowhere. Kept
 * apart from the phone's own row, so erasing a contact (`contact.forget`)
 * doesn't let them in again. The phone is kept only as that hash, which is
 * unkeyed: someone holding the database could find it by trying every phone
 * number. No events.
 */
import { defineCollection } from "../../../../runtime/mod.ts";

export const blocked = defineCollection({
  schema: {
    type: "object",
    properties: { number: { type: "string" }, at: { type: "string" } },
    required: ["number", "at"],
  },
  events: false,
});

/** A blocked phone's key: the number, and the phone's hash. */
export async function blockedKey(number: string, phone: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(phone));
  return `${number}:${
    [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("")
  }`;
}
