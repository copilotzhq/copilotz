/**
 * `chat.say`: an agent (`from`) says something in a chat without thinking
 * it, no model call and no turn: a fixed message trusted code decides on (a
 * payment confirmed). It goes to `to` (people by id, contacts as
 * `contact:<id>`), else to whoever last wrote there who isn't an agent, and
 * out through the chat's medium (WhatsApp) like any of its answers. It's
 * said to people, never to agents, so it starts no turn. Its `id` comes from
 * what caused it (a payment's): saying it again sends nothing. Only trusted
 * code calls it.
 */
import { defineAction, failure, invalid } from "../../../../runtime/mod.ts";
import type { Message } from "../collections/message.ts";
import type { Thread } from "../collections/thread.ts";
import { agentsNamed, now } from "../shared/agents.ts";
import { noted } from "../shared/summary.ts";

export const sayAction = defineAction({
  description: "An agent's fixed message in a chat, without a model call",
  input: {
    type: "object",
    properties: {
      /** The message's id, from what caused it: the same id is said once. */
      id: { type: "string", minLength: 1, maxLength: 200 },
      thread: { type: "string" },
      /** The agent saying it. */
      from: { type: "string" },
      text: { type: "string", minLength: 1 },
      to: { type: "array", items: { type: "string" }, maxItems: 20 },
    },
    required: ["id", "thread", "from", "text"],
    additionalProperties: false,
  },
  run: async (ctx, input) => {
    const messages = ctx.db.collection<Message>("message");
    if (await messages.findOne({ _id: input.id })) return { message: input.id };
    const thread = await ctx.db.collection<Thread>("thread").findOne({ _id: input.thread });
    if (!thread) throw failure("not_found", `No chat "${input.thread}".`);
    // Whoever last wrote there who isn't an agent, unless it says whom.
    const latest = input.to ? [] : await messages.find(
      { thread: thread._id, private: { $ne: true } },
      { sort: { at: -1 }, limit: 20 },
    );
    const agents = await agentsNamed(ctx, [
      input.from,
      ...input.to ?? latest.map((m) => m.from),
    ]);
    if (!agents[input.from]) throw invalid(`No agent "${input.from}".`);
    const last = latest.find((m) => !agents[m.from])?.from;
    const to = input.to ?? (last ? [last] : []);
    if (to.some((name) => agents[name])) {
      throw invalid("An agent says this to people: to ask another agent, send it a message.");
    }
    const said = {
      _id: input.id,
      thread: thread._id,
      ...(thread.in ? { in: thread.in } : {}),
      from: input.from,
      to,
      text: input.text,
      // After a person's message, as an agent's answer is.
      hops: 1,
      at: now(),
    };
    try {
      await ctx.transaction(async (tx) => {
        await tx.db.collection("message").insertOne(said);
        await noted(tx, said);
      });
    } catch (error) {
      // Said just now, by the same cause.
      if ((error as { code?: string }).code !== "duplicate_key") throw error;
    }
    return { message: said._id };
  },
});
