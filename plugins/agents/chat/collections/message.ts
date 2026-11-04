/** Messages: what people and agents said, and agents' private steps (their tool calls). */
import { defineCollection, type Infer, people } from "../../../../runtime/mod.ts";
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
    /**
     * What it answers by a tap, not typed: the choice tapped (`id`: what it
     * means, as the app gave it; its text is the `title`, what was read), and
     * the addition it was in (`key`). A choice, not a permission: anyone can
     * send any id, and agents read it as it came (`[tapped: <id>]`), so a
     * tool acting on one checks it against what was shown there (`shown`, or
     * the app's own record of what it offered).
     */
    tap: {
      type: "object",
      properties: { id: { type: "string" }, title: { type: "string" }, key: { type: "string" } },
      required: ["id"],
    },
    /**
     * How a person's message came, when not typed there: sent for them by what
     * they set up (a routine). It's still theirs; people and agents are told.
     */
    via: {
      type: "object",
      properties: {
        /** What sent it: `routine`. */
        kind: { type: "string" },
        /** Which: "Morning news". */
        name: { type: "string" },
        /** Where to see it, on this app. */
        path: { type: "string" },
      },
      required: ["kind", "name"],
    },
    /**
     * Where an answer goes, when this was sent from another space: the chat
     * that handed the work here, which its sender waits in.
     */
    back: {
      type: "object",
      properties: { thread: { type: "string" }, in: { type: "string" }, from: { type: "string" } },
      required: ["thread"],
    },
    /**
     * Its model's state (thinking, signatures) on a step or an answer: sent
     * back to that model in its later calls, this turn's and the next ones'.
     * Only trusted code reads it.
     */
    state: { type: "object" },
    /**
     * What its sender was told before writing it, at the start of its turn
     * (its `turn` contexts that said something new): sent to it again here,
     * in later turns. Only trusted code reads it.
     */
    told: {
      type: "array",
      items: {
        type: "object",
        properties: { name: { type: "string" }, text: { type: "string" } },
        required: ["name", "text"],
      },
    },
    at: { type: "string" },
  },
  required: ["thread", "from", "to", "at"],
} as const;

export const message = defineCollection({
  schema: messageSchema,
  // What it was told and its model's state are the agent's: people's reads and events go without.
  private: ["told", "state"],
  queries: {
    /**
     * Everything in a thread, oldest first, agents' private steps included.
     * With `lineage`, a fork's history starts with what it inherited.
     */
    history: {
      allow: people,
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
      allow: people,
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
      // Summarized (another plugin's), from where it says; else a window that moves in batches.
      const recent = await lineage(ctx.db, params.thread, {
        agent: params.agent,
        ...(params.since !== undefined ? { since: params.since } : { batched: true }),
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
      allow: (actor, params: { person: string }) =>
        actor.kind === "person" && actor.id === params.person,
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

/** Whether a message is an agent's final answer in its turn (`<run>:reply`), one that didn't fail. */
export const isAnswer = (m: Pick<Message, "_id" | "turn" | "failed" | "stopped">): boolean =>
  !!m.turn && m._id === `${m.turn}:reply` && !m.failed && !m.stopped;
