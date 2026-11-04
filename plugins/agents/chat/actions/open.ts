/**
 * `chat.open`: an empty chat in a space, before anything is said in it: a
 * chat to share on its own (a contact's, on a customer line), or one a page
 * opens. With `thread`, that's its id, and opening it again changes nothing
 * (a retry opens the same one). Its messages go to `agents`, who must answer
 * in the space (`not_here` otherwise), else to who answers new chats there.
 */
import { defineAction, failure, people } from "../../../../runtime/mod.ts";
import type { Thread } from "../collections/thread.ts";
import { agentsNamed, now, rosterOf } from "../shared/agents.ts";

export const openAction = defineAction({
  description: "Opens an empty chat in a space",
  input: {
    type: "object",
    properties: {
      thread: { type: "string", minLength: 1, maxLength: 200 },
      in: { type: "string", minLength: 1 },
      agents: { type: "array", items: { type: "string" }, maxItems: 10 },
      title: { type: "string", minLength: 1, maxLength: 120 },
      /** An agent working there may name it, as what it found. */
      renamable: { type: "boolean" },
    },
    required: ["in"],
    additionalProperties: false,
  },
  allow: people,
  run: async (ctx, input) => {
    const threads = ctx.db.collection<Thread>("thread");
    const id = input.thread ?? crypto.randomUUID();
    if (input.thread && await threads.findOne({ _id: id })) return { thread: id };
    const roster = await rosterOf(ctx, input.in);
    const asked = input.agents ?? roster.default;
    const agents = await agentsNamed(ctx, asked);
    const away = asked.filter((name) =>
      !agents[name] || (!roster.open && !roster.here.includes(name))
    );
    if (away.length) {
      throw failure(
        "not_here",
        `${away.join(", ")} ${away.length === 1 ? "doesn't" : "don't"} answer in that space.`,
      );
    }
    await threads.insertOne({
      _id: id,
      agents: asked,
      in: input.in,
      ...(input.title ? { title: input.title } : {}),
      ...(input.renamable ? { renamable: true } : {}),
      messages: 0,
      at: now(),
    });
    return { thread: id };
  },
});
