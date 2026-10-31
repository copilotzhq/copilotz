/** remember, recall and forget: offered to the agents with memory. */
import type { Resources } from "../../../../runtime/mod.ts";
import { tool } from "../../chat/contract.ts";
import type { Message } from "../../chat/contract.ts";
import type { Memory } from "../collections/memory.ts";
import { aboutOf, LIMIT, line, now, peopleOf, readable, scopeFor } from "../shared/scope.ts";
import { namesFor } from "../../../access/spaces/contract.ts";
import { keep, search } from "../shared/search.ts";
import { applies } from "../shared/settings.ts";

/** Offered to the agents with memory. */
const offer = (agent: string, _thread: unknown, ctx: { resources: Resources }) =>
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
    "this conversation and everyone. Recall before answering about anything from earlier " +
    "conversations, instead of guessing. It searches what was learned where this " +
    "conversation is; when what you need isn't there (something the person keeps to " +
    "themselves, another space), give `in`, a space you can read: what you find there " +
    "marks your answer, so look only when you need to.",
  input: {
    type: "object",
    properties: {
      query: { type: "string", minLength: 1 },
      in: { type: "string", description: "Another space to search, by its id." },
      limit: { type: "integer" },
    },
    required: ["query"],
  },
  run: async (input, ctx) => {
    const here = await scopeFor(ctx);
    const scope = input.in ? { ...here, in: input.in } : here;
    const found = await search(ctx, scope, input.query, input.limit ?? LIMIT.recall, {
      core: true,
    });
    if (!found.length) return "Nothing remembered about that.";
    // People by name (notes from before names were known say ids).
    const names = { ...here.names, ...await namesFor(ctx, found.flatMap(peopleOf)) };
    return found.map((m) => line(m, ctx.agent, names)).join("\n");
  },
});

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
