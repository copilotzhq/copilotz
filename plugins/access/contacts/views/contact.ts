/**
 * Who an agent is talking with, when it works for a contact (the chat
 * plugin's `contact` context, in the system text): their name, where they
 * write from, and that the chat is theirs and the line's people's. Nothing
 * for anyone else's turn. Their name is theirs to choose, so it's data.
 */
import { principalOf, type ViewContext } from "../../../../runtime/mod.ts";
import type { Contact } from "../collections/contact.ts";

/** Where each medium's contacts write from, as an agent is told it. */
const FROM: Record<string, string> = { whatsapp: "on WhatsApp" };

export const contactView = (_thread: unknown, ctx: ViewContext<string>) => {
  const principal = principalOf(ctx.actor);
  if (principal?.kind !== "contact") return undefined;
  const found = ctx.db.collection<Contact>("contact").findOne({ _id: principal.id }).value;
  if (!found) return undefined;
  const who = found.name ? `${found.name}, a customer` : "a customer (their name isn't known)";
  const from = FROM[found.via] ?? `through ${found.via}`;
  return `You're talking with ${who}, writing ${from}. They see only this conversation; ` +
    `the people of the business running this line can read it too.`;
};
