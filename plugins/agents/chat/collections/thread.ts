/** Threads: conversations, which may fork from another at a message. */
import type { Message } from "./message.ts";
import { teamOf } from "../shared/agents.ts";
import { said } from "../shared/summary.ts";
import { defineCollection, type Infer } from "../../../../runtime/mod.ts";

const names = { type: "array", items: { type: "string" } } as const;

const threadSchema = {
  type: "object",
  properties: {
    title: { type: "string" },
    /** Who a message nobody is mentioned in goes to. */
    agents: names,
    /** Where it came from: a thread, and the message there it started at. */
    parent: {
      type: "object",
      properties: { thread: { type: "string" }, message: { type: "string" } },
      required: ["thread", "message"],
    },
    /**
     * Its history starts with the parent's, up to and including that message:
     * a fork (a subthread is one). Without it, it starts empty (a new thread).
     */
    fork: { type: "boolean" },
    /** The space it's in (see the access plugin): its messages are there too. */
    in: { type: "string" },
    /** Its summary, kept as messages come (shared/summary.ts): how many, its first and latest. */
    messages: { type: "integer" },
    opened: { type: "string" },
    latest: { type: "string" },
    at: { type: "string" },
  },
  required: ["at"],
} as const;

export const thread = defineCollection({
  schema: threadSchema,
  queries: {
    /**
     * Who answers in a space's conversations (`here`, `default`; every agent,
     * `open`, without a roster), with what each is, and what any of `names`
     * that's an agent is: for front ends (who `@` offers, how an author shows).
     */
    agents: {
      allow: (actor) => actor.kind === "person",
      run: (_, params: { in?: string; names?: string[] }, ctx) =>
        teamOf(ctx, params.in, params.names ?? []),
    },
    /** Exactly what `agent` would be sent in this thread now: the `llm` View of the thread. */
    prompt: {
      // People, and the agent itself.
      allow: (actor, params: { agent: string }) =>
        actor.kind === "person" || (actor.kind === "agent" && actor.id === params.agent),
      run: async (threads, params: { thread: string; agent: string }, ctx) => {
        const thread = await threads.findOne({ _id: params.thread });
        return thread
          ? await ctx.render("llm", "thread", thread, {
            viewer: { kind: "agent", name: params.agent },
          })
          : null;
      },
    },
    /**
     * The latest conversations (in a space, with `in`), newest first, each
     * with how many messages it has and what its first and latest say, as
     * the asker may read them: two reads in all. Forks (subthreads) show
     * under the message they start at instead.
     */
    recent: {
      allow: (actor) => actor.kind === "person",
      run: async (threads, params: { limit?: number; in?: string } = {}, ctx) => {
        const recent = await threads.find(
          { fork: { $ne: true }, ...(params.in ? { in: params.in } : {}) },
          { sort: { at: -1 }, limit: params.limit ?? 20 },
        );
        // What they open and end with, read as whoever asks: what they may read, nothing more.
        const ids = [...new Set(recent.flatMap((t) => [t.opened, t.latest]))]
          .filter((id): id is string => !!id);
        const read = ids.length
          ? await ctx.db.collection<Message>("message").find({ _id: { $in: ids } })
          : [];
        const by = new Map(read.map((m) => [m._id, m]));
        return recent.map((t) => ({
          ...t,
          first: said(by.get(t.opened ?? "")),
          last: said(by.get(t.latest ?? "")),
        }));
      },
    },
  },
});

export type Thread = Infer<typeof threadSchema> & { _id: string };
