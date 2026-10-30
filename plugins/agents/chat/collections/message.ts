/** Messages: what people and agents said, and agents' private steps (their tool calls). */
import { defineCollection, type Infer } from "../../../../runtime/mod.ts";
import { HISTORY } from "../shared/agents.ts";
import { lineage } from "../shared/lineage.ts";
import type { Step } from "../shared/types.ts";

const names = { type: "array", items: { type: "string" } } as const;

const messageSchema = {
  type: "object",
  properties: {
    thread: { type: "string" },
    /** An agent's name or a person's. */
    from: { type: "string" },
    to: names,
    text: { type: "string" },
    /** An agent's step: the tools it called, with what each returned. */
    toolCalls: { type: "array" },
    /** Seen only by its sender (an agent's steps). */
    private: { type: "boolean" },
    /** The message this one answers. */
    replyTo: { type: "string" },
    /** False when the sender wants no reply. */
    expectReply: { type: "boolean" },
    /** The subthread that hangs from this message. */
    subthread: { type: "string" },
    /** Agent messages since the last person's message. */
    hops: { type: "integer" },
    /** The turn that wrote it. */
    turn: { type: "string" },
    failed: { type: "boolean" },
    /** The space its thread is in. */
    in: { type: "string" },
    /** Files attached to it: what they are, and their id in the `file` collection. */
    files: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          name: { type: "string" },
          type: { type: "string" },
          size: { type: "integer" },
          /** A recording's length (ms) and loudness over time, for its player. */
          voice: {
            type: "object",
            properties: {
              duration: { type: "number" },
              peaks: { type: "array", items: { type: "number" } },
            },
          },
          /** What an audio file says. */
          transcript: { type: "string" },
        },
        required: ["id", "name", "type", "size"],
      },
    },
    /**
     * Spaces it drew on that not everyone where it is can see (the access
     * plugin's labels): only those who reach them all read it, until shared.
     */
    sources: { type: "array", items: { type: "string" } },
    /** Its turn was stopped (`chat.stop`): what it had written so far. */
    stopped: { type: "boolean" },
    /** A step's model state (its thinking), sent back to that model while its turn goes on. */
    state: { type: "object" },
    at: { type: "string" },
  },
  required: ["thread", "from", "to", "at"],
} as const;

export const message = defineCollection({
  schema: messageSchema,
  queries: {
    /**
     * Everything in a thread, oldest first, agents' private steps included.
     * With `lineage`, a fork's history starts with what it inherited.
     */
    history: {
      allow: (actor) => actor.kind === "person",
      run: (messages, params: { thread: string; lineage?: boolean }, ctx) =>
        params.lineage
          ? lineage(ctx.db, params.thread, { limit: 1_000 })
          : messages.find({ thread: params.thread }).sort({ at: 1 }),
    },
    /**
     * A conversation as people read it, oldest first: the thread through its
     * lineage, with the messages of the subthreads hanging from it beside
     * its own, the last `limit` (40) of them.
     */
    conversation: {
      allow: (actor) => actor.kind === "person",
      run: async (messages, params: { thread: string; limit?: number }, ctx) => {
        const limit = params.limit ?? 40;
        const own = await lineage(ctx.db, params.thread, { limit });
        const subthreads = own.flatMap((m) => m.subthread ? [m.subthread] : []);
        const inside = subthreads.length
          ? await messages.find({ thread: { $in: subthreads } }, { sort: { at: -1 }, limit })
          : [];
        return [...own, ...inside].sort((a, b) => a.at < b.at ? -1 : a.at > b.at ? 1 : 0)
          .slice(-limit);
      },
    },
    /**
     * What an agent sees in a thread, oldest first: the thread through its
     * lineage (shared messages and its own steps), and the replies to what it
     * sent elsewhere, in place of the messages it sent (its steps show them).
     */
    visible: async (
      messages,
      params: { thread: string; agent: string; since?: string },
      ctx,
    ) => {
      const recent = await lineage(ctx.db, params.thread, {
        agent: params.agent,
        ...(params.since ? { since: params.since } : {}),
      });
      const sent = new Set(
        recent.flatMap((m) =>
          m.from === params.agent
            ? ((m.toolCalls ?? []) as Step[]).flatMap((c) => c.sent ?? [])
            : []
        ),
      );
      // Replies to this agent, wherever they were written: one cached query per agent.
      const elsewhere = sent.size
        ? (await messages.find({ to: params.agent, replyTo: { $exists: true } })
          .sort({ at: -1 })
          .limit(HISTORY))
          .filter((m) => sent.has(m.replyTo!) && m.thread !== params.thread)
        : [];
      return [...recent, ...elsewhere]
        .filter((m) => !sent.has(m._id))
        .sort((a, b) => a.at < b.at ? -1 : a.at > b.at ? 1 : 0);
    },
    /** Questions to `person` that an agent is still waiting on, newest first. */
    questions: {
      allow: (actor, params: { person: string }) => actor.id === params.person,
      run: async (messages, params: { person: string }, ctx) => {
        const asked = await messages.find(
          { to: params.person, replyTo: { $exists: false }, expectReply: { $ne: false } },
          { sort: { at: -1 }, limit: 20 },
        );
        const waits = ctx.db.collection("wait");
        const open = await Promise.all(asked.map((m) => waits.findOne({ waitingFor: m._id })));
        return asked.filter((_, i) => open[i]);
      },
    },
  },
});

export type Message = Infer<typeof messageSchema> & { _id: string };
