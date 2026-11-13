/** Who is in a conversation, which memories they can read, and how memories read. */
import { type Actor, personOf, type ViewContext } from "../../../../runtime/mod.ts";
import {
  type Agent,
  agentsNamed,
  agentsShown,
  type Message,
  type Thread,
  type ToolContext,
} from "../../chat/contract.ts";
import type { Memory } from "../collections/memory.ts";
import {
  idsIn,
  nameOf,
  namesFor,
  namesIn,
  PERSONAL,
  withNames,
} from "../../../access/spaces/contract.ts";

/**
 * Who is in a conversation, for whom memories are read; `in`, the space it's
 * in, keeps what comes up by itself to what was learned there, but in its
 * person's own Personal space (`everywhere`), which only they see: there,
 * memories are read wherever they can read.
 */
export type Scope = {
  agent: string;
  thread: string;
  people: string[];
  in?: string;
  everywhere?: boolean;
  /** The people's names, by id (as agents read and write them). */
  names?: Record<string, string>;
};

export const LIMIT = { core: 40, relevant: 5, recall: 8 };
/** The messages around where a memory was learned that `recall`'s `source` shows, each side. */
export const AROUND = 4;

/** How agents should use their memory: stable, so it stays in the cached system text. */
export const GUIDE =
  "You remember across conversations. Memories that may matter come up on their own as the " +
  "conversation goes, and recall searches the rest. Before you say you don't know something, " +
  "don't have it, or can't go on without it, look for it first: recall it, and look back " +
  "through this conversation; never guess. When you learn something that will matter later " +
  "(who someone is, what they prefer, a decision or commitment), remember it in one " +
  "self-contained sentence; mark it core when it's central to them. Correct or forget memories " +
  "that turn out wrong.";
/** A new memory this similar to an existing one about the same subject updates it. */
export const SAME = 0.9;
/** Below this similarity, a memory isn't relevant enough to show unasked. */
export const RELEVANT = 0.3;

export const now = () => new Date().toISOString();
export const shortId = () =>
  "m" +
  Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => (b % 36).toString(36)).join("");

export const words = (text: string) =>
  new Set((text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((word) => word.length > 2));

/** How many of the query's words the text has, from 0 to 1. */
export function overlap(query: Set<string>, text: string) {
  if (!query.size) return 0;
  const found = words(text);
  let hits = 0;
  for (const word of query) if (found.has(word)) hits++;
  return hits / query.size;
}

/** The memories a scope can read: about its people, its agent, its thread, or everyone. */
export const readable = (scope: Scope) => ({
  forgotten: { $exists: false },
  ...(scope.in && !scope.everywhere ? { in: scope.in } : {}),
  about: {
    $in: [
      "everyone",
      `agent:${scope.agent}`,
      `thread:${scope.thread}`,
      ...scope.people.map((person) => `person:${person}`),
    ],
  },
});

/** Who a memory is about, as a reader would say it (a person by name). */
export function subject(about: string, agent?: string, names: Record<string, string> = {}) {
  if (about === "everyone") return "everyone";
  const [kind, name] = [about.slice(0, about.indexOf(":")), about.slice(about.indexOf(":") + 1)];
  if (kind === "agent") return name === agent ? "you" : name;
  if (kind === "thread") return "this conversation";
  return nameOf(name, names);
}

/** People in a thread (who wrote or was addressed, and isn't an agent), from its latest messages. */
export const peopleIn = (messages: Message[], agents: Record<string, Agent>) => [
  ...new Set(messages.flatMap((m) => [m.from, ...m.to]).filter((name) => !agents[name])),
];

/**
 * The people in a conversation, for memory: those in it, and the person its
 * agents work for, there or not (a chat one agent handed to another, for them).
 */
export const peopleFor = (messages: Message[], agents: Record<string, Agent>, actor?: Actor) => {
  const person = personOf(actor);
  const people = peopleIn(messages, agents);
  return person && !agents[person] && !people.includes(person) ? [...people, person] : people;
};

/** Whether a space is the Personal one of the person an actor works for: memory reads it all. */
const ownPersonal = (space: { kind?: string; owner?: string } | null | undefined, actor?: Actor) =>
  space?.kind === PERSONAL && !!space.owner && space.owner === personOf(actor);

/** Who is in the conversation, for the views: from its latest shared messages. */
export function scopeOf(
  thread: Thread,
  ctx: ViewContext,
): (Scope & { latest?: Message; before?: Message[] }) | undefined {
  const agent = ctx.viewer?.name ?? "";
  const recent = ctx.db.collection<Message>("message").find(
    { thread: thread._id, private: { $ne: true } },
    { sort: { at: -1 }, limit: 50 },
  );
  if (recent.status !== "ready") return undefined;
  const space = thread.in
    ? ctx.db.collection<{ kind?: string; owner?: string }>("space").findOne({ _id: thread.in })
    : undefined;
  if (space && space.status !== "ready") return undefined;
  const agents = agentsShown(ctx, recent.value.flatMap((m) => [m.from, ...m.to]));
  if (!agents) return undefined;
  const people = peopleFor(recent.value, agents, ctx.actor);
  // What was last said to (or around) this agent, not its own words, and what came before it.
  const at = recent.value.findIndex((m) => m.from !== agent);
  return {
    agent,
    thread: thread._id,
    people,
    names: namesIn(ctx, people),
    // What comes up by itself was learned here (in its person's Personal space, anywhere they
    // read); looking elsewhere is asking, as far as the work reaches.
    ...(thread.in ? { in: thread.in } : {}),
    ...(ownPersonal(space?.value, ctx.actor) ? { everywhere: true } : {}),
    ...(at >= 0 ? { latest: recent.value[at], before: recent.value.slice(at + 1, at + 3) } : {}),
  };
}

export const line = (
  m: Memory,
  agent?: string,
  names: Record<string, string> = {},
  learned?: string,
) =>
  `- ${withNames(m.text, names)}${
    m.about.startsWith("person:") ? "" : ` (about ${subject(m.about, agent, names)})`
  } [${m._id}]${learned ? ` (${learned})` : ""}`;

/**
 * When and where a memory was learned, as an agent reads it, in few words: to
 * judge how current it is, and to look there (`recall`'s `source`, by the
 * memory's id). `titles`: the conversations it can read, by id.
 */
export function learnedOf(m: Memory, titles: Record<string, string>, thread?: string) {
  const from = m.source?.thread;
  const title = from ? titles[from] : undefined;
  const where = from && from === thread
    ? " here"
    : title
    ? ` in “${title.length > 40 ? `${title.slice(0, 40).replace(/\s+\S*$/, "")}…` : title}”`
    : "";
  return `learned${where} ${(m.updated ?? m.at).slice(0, 10)}`;
}

/**
 * The people a memory may show: whom it's about, who wrote it, and whom its
 * words name by id (one written before names were known), to name them.
 */
export const peopleOf = (m: Pick<Memory, "about" | "text" | "by"> & { was?: string }) => [
  ...(m.about.startsWith("person:") ? [m.about.slice("person:".length)] : []),
  ...(m.by && m.by !== "memory" ? [m.by] : []),
  ...idsIn(m.text),
  ...(m.was ? idsIn(m.was) : []),
];

/** Who `about` names, from what an agent said: a person here, "me", "thread", "everyone". */
export function aboutOf(given: unknown, scope: Scope, ctx: ToolContext, trigger?: Message | null) {
  const name = typeof given === "string" ? given.trim() : "";
  if (name === "me") return `agent:${ctx.agent}`;
  if (name === "thread") return `thread:${ctx.thread}`;
  if (name === "everyone") return "everyone";
  // A person here by the name agents know them by.
  const known = scope.people.find((p) =>
    p === name || (scope.names?.[p] ?? "").toLowerCase() === name.toLowerCase()
  );
  if (known) return `person:${known}`;
  if (name.includes(":")) return name;
  if (name) return `person:${name}`;
  // By default, the person it's talking with.
  if (trigger && scope.people.includes(trigger.from)) return `person:${trigger.from}`;
  return scope.people.length === 1 ? `person:${scope.people[0]}` : "everyone";
}

/**
 * Who is in the conversation, for a tool: from the thread's latest shared
 * messages; and where it is (`ctx.in`), where what's learned stays.
 */
export async function scopeFor(ctx: ToolContext): Promise<Scope> {
  const [recent, space] = await Promise.all([
    ctx.db.collection<Message>("message").find(
      { thread: ctx.thread, private: { $ne: true } },
      { sort: { at: -1 }, limit: 50 },
    ),
    ctx.in
      ? ctx.db.collection<{ kind?: string; owner?: string }>("space").findOne({ _id: ctx.in })
      : null,
  ]);
  const agents = await agentsNamed(ctx, recent.flatMap((m) => [m.from, ...m.to]));
  const people = peopleFor(recent, agents, ctx.actor);
  return {
    agent: ctx.agent,
    thread: ctx.thread,
    people,
    names: await namesFor(ctx, people),
    ...(ctx.in ? { in: ctx.in } : {}),
    ...(ownPersonal(space, ctx.actor) ? { everywhere: true } : {}),
  };
}
