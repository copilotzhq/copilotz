/**
 * What an agent working in a chat's notes is told (the `notes` context, each
 * turn it says something new): whose chat they're about, that whoever it's
 * shared with outside the space never sees them, and the chat's latest
 * shared messages, so it answers its people about what was said there
 * without asking them to repeat it. Read as the agent, as it reaches it.
 */
import type { ViewContext } from "../../../../runtime/mod.ts";
import type { Message } from "../collections/message.ts";
import type { Thread } from "../collections/thread.ts";
import { said } from "../shared/summary.ts";
import { nameOf, namesIn } from "../../../access/spaces/contract.ts";

/** How many of the chat's latest messages it's told. */
const LATEST = 8;

/** At most `most` characters, on one line. */
const gist = (text: string, most = 300) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > most ? `${flat.slice(0, most - 1).trimEnd()}…` : flat;
};

export const notesContextView = (thread: Thread, ctx: ViewContext<string>) => {
  if (!thread.about) return undefined;
  const chat = ctx.db.collection<Thread>("thread").findOne({ _id: thread.about }).value;
  if (!chat) return undefined;
  const latest = (ctx.db.collection<Message>("message").find(
    { thread: chat._id, private: { $ne: true } },
    { sort: { at: -1 }, limit: LATEST },
  ).value ?? []).reverse();
  const outside = ctx.db.collection<{ member: string }>("member")
    .find({ space: `thread:${chat._id}` }).value ?? [];
  const names = namesIn(ctx, [
    ...outside.map((m) => m.member),
    ...latest.flatMap((m) => [m.from, ...m.to]),
  ]);
  const whom = outside.length
    ? outside.map((m) => nameOf(m.member, names)).join(", ")
    : "whoever it's shared with outside this space";
  const title = chat.title ? ` (“${gist(chat.title, 80)}”)` : "";
  const lines = latest.map((m) =>
    `[${m.at.slice(0, 16).replace("T", " ")}] ${nameOf(m.from, names)}: ${gist(said(m) ?? "")}`
  );
  return `These are your team's notes about conversation ${chat._id}${title}, with ${whom}. ` +
    `Only this space's people read what's said here; ${whom} never see${
      outside.length === 1 ? "s" : ""
    } it. ` +
    (lines.length
      ? `Its latest messages:\n${lines.join("\n")}\nread_conversation reads more of it.`
      : "Nothing's been said there yet.");
};
