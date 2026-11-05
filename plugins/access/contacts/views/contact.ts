/**
 * Who an agent is talking with, when it works for a contact (the chat
 * plugin's `contact` context, in the system text): their name, where they
 * write from, and that the chat is theirs and the line's people's. Nothing
 * for anyone else's turn. Their name is theirs to choose, so it's data.
 */
import { principalOf, type ViewContext } from "../../../../runtime/mod.ts";
import type { Contact } from "../collections/contact.ts";

/** How each medium's contacts talk, as an agent is told it. */
const FROM: Record<string, string> = {
  whatsapp: "writing on WhatsApp",
  voice: "on a phone call: they hear what you write, read aloud. The number they call from " +
    "isn't proof of who they are",
  web: "chatting on the website, with nothing that proves who they are",
};

export const contactView = (_thread: unknown, ctx: ViewContext<string>) => {
  const principal = principalOf(ctx.actor);
  if (principal?.kind !== "contact") return undefined;
  const found = ctx.db.collection<Contact>("contact").findOne({ _id: principal.id }).value;
  if (!found) return undefined;
  const who = found.name ? `${found.name}, a customer` : "a customer (their name isn't known)";
  const from = FROM[found.via] ?? `writing through ${found.via}`;
  return `You're talking with ${who}, ${from}. They see only this conversation; ` +
    `the people of the business running this line can read it too.`;
};
