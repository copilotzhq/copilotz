/**
 * Forks a thread at one of its messages: the new thread sees the
 * conversation up to and including it, and goes on separately. With
 * `again`, the agents that message was for answer it again in the fork
 * (regenerate); to edit a message instead, fork at the one before it and
 * send the new version there.
 */
import { defineAction } from "../../../../runtime/mod.ts";
import type { Message } from "../collections/message.ts";
import type { Thread } from "../collections/thread.ts";
import { agentsNamed, now } from "../shared/agents.ts";

export const forkAction = defineAction({
  input: {
    type: "object",
    properties: {
      thread: { type: "string" },
      message: { type: "string" },
      again: { type: "boolean" },
    },
    required: ["thread", "message"],
    additionalProperties: false,
  },
  allow: (actor) => actor.kind === "person",
  run: async (ctx, input) => {
    const parent = await ctx.db.collection<Thread>("thread").findOne({ _id: input.thread });
    const at = await ctx.db.collection<Message>("message").findOne({ _id: input.message });
    if (!parent || !at || at.thread !== input.thread) {
      throw Object.assign(new Error("No such message in this thread"), { code: "invalid" });
    }
    const fork = crypto.randomUUID();
    const agents = await agentsNamed(ctx, at.to);
    const again = input.again ? at.to.filter((name) => agents[name] && name !== at.from) : [];
    await ctx.transaction(async (tx) => {
      await tx.db.collection("thread").insertOne({
        _id: fork,
        ...(parent.title ? { title: parent.title } : {}),
        parent: { thread: input.thread, message: input.message },
        fork: true,
        agents: parent.agents ?? [],
        ...(parent.in ? { in: parent.in } : {}),
        at: now(),
      });
      for (const agent of again) {
        tx.emit(
          "turn.requested",
          { thread: fork, agent, trigger: at._id, hops: at.hops ?? 0 },
          { id: `${fork}:${agent}` },
        );
      }
    });
    return { thread: fork };
  },
});
