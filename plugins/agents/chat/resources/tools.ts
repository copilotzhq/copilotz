/**
 * Conversations, for agents: `list_conversations` (the latest in this space,
 * or another its work reaches) and `read_conversation` (what was said in one,
 * page by page). They read as the agent, for its person, where it works: from
 * the person's Personal space, every space they reach; from any other, only
 * that space and what it draws on (design/work.md). What's said is read
 * without agents' private steps (their tools' calls), people by name, never
 * by the ids they signed in with. To say something in one, send_message's
 * `thread`. An agent has them when its `tools` list them: chat is in every
 * app, and an agent with no tools only answers (a visitor reads its words as
 * they come).
 */
import type { Message } from "../collections/message.ts";
import type { Thread } from "../collections/thread.ts";
import { type Tool, tool } from "../shared/types.ts";
import { workIn } from "../shared/where.ts";
import { idsIn, nameOf, namesFor, withNames } from "../../../access/spaces/contract.ts";

/** A conversation as `thread.recent` answers: with what it opens and ends with. */
type Recent = Thread & { first?: string; last?: string };

/** At most `most` characters of `text`, on one line. */
const gist = (text: string | undefined, most = 140) => {
  const flat = (text ?? "").replace(/\s+/g, " ").trim();
  return flat.length > most ? `${flat.slice(0, most - 1).trimEnd()}…` : flat;
};

/** "2026-10-29 21:04" from an ISO time. */
const when = (at: string | undefined) => at ? at.slice(0, 16).replace("T", " ") : "";

/** Whom messages name, for `namesFor`: who wrote them, to whom, and ids in what they say. */
const namedIn = (messages: Message[]): string[] =>
  messages.flatMap((m) => [m.from, ...(m.to ?? []), ...idsIn(m.text ?? "")]);

/**
 * A message as a line of a transcript: when, who to whom, what it says and
 * carries; people by `names` (in what it says too).
 */
function line(m: Message, names: Record<string, string> = {}): string {
  const to = m.to?.length ? ` → ${m.to.map((who) => nameOf(who, names)).join(", ")}` : "";
  const files = m.files?.length
    ? ` [${
      m.files.map((f) => f.transcript ? `voice: ${gist(f.transcript, 400)}` : f.name).join("; ")
    }]`
    : "";
  const text = withNames((m.text ?? "").trim(), names);
  return `[${when(m.at)}] ${nameOf(m.from, names)}${to}: ${text}${files}`;
}

const IN = {
  type: "string",
  description: "Another space, by its id (your context lists them).",
} as const;

const listConversations = tool({
  title: "List conversations",
  annotations: { readOnly: true },
  description: "List the other conversations in this space, latest first: each one's id, how " +
    "it opened, where it is now, and how many messages it has. Read one with read_conversation " +
    "before asking people to repeat what they said there; say something in one with " +
    "send_message's thread. In another space you can read, give in (its id).",
  input: {
    type: "object",
    properties: {
      limit: { type: "integer", minimum: 1, maximum: 50, description: "How many (default 20)." },
      in: IN,
    },
  },
  run: async ({ limit, in: there }, ctx) => {
    const where = await workIn(ctx, there);
    if (typeof where === "string") return where;
    const recent = await ctx.db.collection("thread").query<Recent[]>("recent", {
      in: where.in,
      limit: (limit ?? 20) + 1,
    });
    const others = recent.filter((t) => t._id !== ctx.thread).slice(0, limit ?? 20);
    if (!others.length) {
      return `No other conversations in ${where.in === ctx.in ? "this" : "that"} space yet.`;
    }
    // What they open and end with, people by name (an id an agent wrote, too).
    const names = await namesFor(
      ctx,
      others.flatMap((t) => [...idsIn(t.first ?? ""), ...idsIn(t.last ?? "")]),
    );
    const said = (text?: string) => gist(text && withNames(text, names));
    return others.map((t) =>
      [
        `- ${t._id}${t.title ? ` “${gist(t.title, 80)}”` : ""} · ${t.messages ?? 0} messages · ` +
        `last ${when(t.at)}`,
        `  opened: ${said(t.first) || "(nothing to read)"}`,
        ...(t.last && t.latest !== t.opened ? [`  latest: ${said(t.last)}`] : []),
      ].join("\n")
    ).join("\n");
  },
});

const readConversation = tool({
  title: "Read a conversation",
  annotations: { readOnly: true },
  description: "Read what was said in another conversation (by its id, from " +
    "list_conversations): its messages, oldest first, the latest `limit` of them, or those " +
    "before `before` (a time from a previous read) to go further back. In this space, or " +
    "another you can read.",
  input: {
    type: "object",
    properties: {
      conversation: { type: "string", description: "Its id." },
      limit: { type: "integer", minimum: 1, maximum: 100, description: "How many (default 30)." },
      before: { type: "string", description: "Only messages before this time (ISO)." },
    },
    required: ["conversation"],
  },
  run: async ({ conversation, limit, before }, ctx) => {
    const thread = await ctx.db.collection<Thread>("thread").findOne({ _id: conversation });
    // Here, or in a space its work reaches (and says so when it doesn't).
    const where = thread?.in ? await workIn(ctx, thread.in) : undefined;
    if (!thread || !where) return `No conversation "${conversation}" that you can read.`;
    if (typeof where === "string") return where;
    const most = limit ?? 30;
    const found = await ctx.db.collection<Message>("message").find(
      {
        thread: conversation,
        private: { $ne: true },
        ...(before ? { at: { $lt: before } } : {}),
      },
      { sort: { at: -1 }, limit: most + 1 },
    );
    const shown = found.slice(0, most).reverse();
    if (!shown.length) return before ? "Nothing before that." : "Nothing said there yet.";
    const more = found.length > most
      ? `\n(earlier messages: read again with before: "${shown[0].at}")`
      : "";
    const title = thread.title ? ` “${gist(thread.title, 80)}”` : "";
    const elsewhere = where.in === ctx.in ? "" : ` (in space ${where.in})`;
    const names = await namesFor(ctx, namedIn(shown));
    return `Conversation ${conversation}${title}${elsewhere}:\n${
      shown.map((m) => line(m, names)).join("\n")
    }${more}`;
  },
});

/** Chat's own tools for agents, by name. */
export const chatTools: Record<string, Tool> = {
  list_conversations: listConversations,
  read_conversation: readConversation,
};
