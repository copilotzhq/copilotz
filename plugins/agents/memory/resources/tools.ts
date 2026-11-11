/** remember, recall and forget: offered to the agents with memory. */
import type { Actor, Resources } from "../../../../runtime/mod.ts";
import { tool } from "../../chat/contract.ts";
import type { Message, Thread, ToolContext } from "../../chat/contract.ts";
import type { Memory } from "../collections/memory.ts";
import {
  aboutOf,
  AROUND,
  learnedOf,
  LIMIT,
  line,
  now,
  peopleOf,
  readable,
  type Scope,
  scopeFor,
} from "../shared/scope.ts";
import { nameOf, namesFor, withNames } from "../../../access/spaces/contract.ts";
import { keep, search } from "../shared/search.ts";
import { applies } from "../shared/settings.ts";

/** Offered to the agents with memory, where they have it. */
const offer = (agent: string, _thread: unknown, ctx: { resources: Resources; actor?: Actor }) =>
  applies(ctx, agent);

const remember = tool({
  offer,
  description:
    "Remember something worth knowing in later conversations: one self-contained statement " +
    "naming who it is about, and why it matters if that isn't obvious. about: the person it " +
    'concerns, by name (by default, the person you\'re talking with), "me" for a note to ' +
    'yourself, "thread" for this conversation only, or "everyone". core: true for what you ' +
    "should always have in mind about them (who they are, strong preferences). Remembering " +
    "something you already know updates it; give the id to correct a specific memory.",
  input: {
    type: "object",
    properties: {
      text: { type: "string", minLength: 1 },
      about: { type: "string" },
      core: { type: "boolean" },
      id: { type: "string", description: "A memory to update, as [id]." },
    },
    required: ["text"],
  },
  run: async (input, ctx) => {
    const [scope, trigger] = await Promise.all([
      scopeFor(ctx),
      ctx.db.collection<Message>("message").findOne({ _id: ctx.trigger }),
    ]);
    return await keep(ctx, {
      ...(scope.in ? { in: scope.in } : {}),
      text: input.text,
      about: aboutOf(input.about, scope, ctx, trigger),
      ...(input.core !== undefined ? { core: input.core } : {}),
      by: ctx.agent,
      source: { thread: ctx.thread, message: ctx.trigger },
    }, input.id);
  },
});

const recall = tool({
  offer,
  description:
    "Search what you remember, by meaning and by words: about the people here, yourself, " +
    "this conversation and everyone. Recall before you answer about anything from before, and " +
    "before you say you don't know or don't have something, instead of guessing. It searches " +
    "what was learned where this conversation is (in someone's own Personal space, everywhere " +
    "they can read); when what you need isn't there (something the person keeps to " +
    "themselves, another space), give `in`, a space you can read: what you find there marks " +
    "your answer, so look only when you need to. Each memory says when and where it was " +
    "learned: when you need more than it says, give `source`, its [id], to read what was said " +
    "there.",
  input: {
    type: "object",
    properties: {
      query: { type: "string", minLength: 1 },
      in: { type: "string", description: "Another space to search, by its id." },
      limit: { type: "integer" },
      source: {
        type: "string",
        description: "A memory's [id]: what was said where it was learned, instead of a search.",
      },
    },
  },
  run: async (input, ctx) => {
    const here = await scopeFor(ctx);
    const scope = input.in ? { ...here, in: input.in, everywhere: false } : here;
    if (input.source) return await sourceOf(ctx, scope, String(input.source));
    if (!input.query) return "Give a query to search, or a memory's [id] as source.";
    const found = await search(ctx, scope, input.query, input.limit ?? LIMIT.recall, {
      core: true,
    });
    if (!found.length) return "Nothing remembered about that.";
    // People by name (notes from before names were known say ids); conversations by title.
    const [names, titles] = await Promise.all([
      namesFor(ctx, found.flatMap(peopleOf)),
      titlesOf(ctx, found),
    ]);
    return found.map((m) =>
      line(m, ctx.agent, { ...here.names, ...names }, learnedOf(m, titles, ctx.thread))
    ).join("\n");
  },
});

/** The titles of the conversations memories were learned in, where the agent can read them. */
async function titlesOf(ctx: ToolContext, memories: Memory[]): Promise<Record<string, string>> {
  const ids = [...new Set(memories.flatMap((m) => m.source?.thread ?? []))];
  if (!ids.length) return {};
  const found = await ctx.db.collection<Thread>("thread").find({ _id: { $in: ids } });
  return Object.fromEntries(found.map((t) => [t._id, t.title ?? ""]));
}

/**
 * What was said where a memory was learned: the message it came from, with
 * a few on each side, as the agent may read them (people's and agents' words,
 * never anyone's private steps).
 */
async function sourceOf(ctx: ToolContext, scope: Scope, id: string): Promise<string> {
  const memory = await ctx.db.collection<Memory>("memory").findOne({
    _id: id.replace(/^\[|\]$/g, ""),
    ...readable({ ...scope, everywhere: true }),
  });
  if (!memory) return `No memory ${id} that you can read.`;
  const from = memory.source;
  const thread = from?.thread
    ? await ctx.db.collection<Thread>("thread").findOne({ _id: from.thread })
    : null;
  if (!from || !thread) return `Where [${memory._id}] was learned isn't something you can read.`;
  const messages = ctx.db.collection<Message>("message");
  const at = from.message ? (await messages.findOne({ _id: from.message }))?.at : undefined;
  const shared = { thread: thread._id, private: { $ne: true } };
  const [before, after] = at
    ? await Promise.all([
      messages.find({ ...shared, at: { $lte: at } }, { sort: { at: -1 }, limit: AROUND + 1 }),
      messages.find({ ...shared, at: { $gt: at } }, { sort: { at: 1 }, limit: AROUND }),
    ])
    : [await messages.find(shared, { sort: { at: -1 }, limit: AROUND * 2 }), []];
  const shown = [...before.reverse(), ...after];
  if (!shown.length) return `Nothing said is left where [${memory._id}] was learned.`;
  const names = await namesFor(ctx, shown.flatMap((m) => [m.from, ...m.to]));
  const title = thread.title ? ` “${thread.title}”` : "";
  return `Where [${memory._id}] was learned, conversation ${thread._id}${title} ` +
    `(read more with read_conversation, if you have it):\n` +
    shown.map((m) =>
      `${m._id === from.message ? "→ " : "- "}${nameOf(m.from, names)}: ${
        withNames(m.text ?? "", names)
      }`
    ).join("\n");
}

const forget = tool({
  offer,
  description: "Forget a memory that is wrong or no longer wanted, by its [id].",
  input: {
    type: "object",
    properties: { id: { type: "string" }, why: { type: "string" } },
    required: ["id"],
  },
  run: async (input, ctx) => {
    const memories = ctx.db.collection<Memory>("memory");
    // Any memory it found, wherever: by its id.
    const { in: _, ...scope } = await scopeFor(ctx);
    const found = await memories.findOne({ _id: input.id, ...readable(scope) });
    if (!found) return `Nothing to forget: no memory ${input.id} here.`;
    await memories.updateOne({ _id: input.id }, {
      $set: {
        forgotten: now(),
        ...(input.why ? { was: `${found.text} (forgotten: ${input.why})` } : {}),
      },
      $unset: { embedding: 1 },
    });
    return `Forgotten [${input.id}].`;
  },
});

export const tools = { remember, recall, forget };
