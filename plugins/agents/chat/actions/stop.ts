/**
 * `chat.stop`: stops agents' turns in a conversation, and in the
 * subthreads hanging from it; every agent's, or one's. A running turn stops
 * where it is and answers with what it had written; a waiting one stops
 * waiting and answers so. Neither starts a new turn; whoever waited on them
 * resumes.
 */
import { type Context, defineAction } from "../../../../runtime/mod.ts";
import type { Live } from "../collections/live.ts";
import type { Message } from "../collections/message.ts";
import type { Thread } from "../collections/thread.ts";
import type { Wait } from "../collections/wait.ts";
import { agentsOf, rosterOf } from "../shared/agents.ts";
import { answer } from "../shared/delivery.ts";

export const stopAction = defineAction({
  description: "Stops agents' turns in a conversation (and its subthreads)",
  input: {
    type: "object",
    properties: { thread: { type: "string" }, agent: { type: "string" } },
    required: ["thread"],
    additionalProperties: false,
  },
  allow: (actor) => actor.kind === "person",
  run: async (ctx, input) => {
    // Someone stops only the conversations they reach (with the access plugin).
    if (ctx.actor && !await ctx.db.collection("thread").findOne({ _id: input.thread })) {
      throw Object.assign(new Error(`No conversation "${input.thread}" to stop.`), {
        code: "forbidden",
      });
    }
    return { stopped: await stop(ctx.as(), input.thread, input.agent) };
  },
});

/** Stops turns in `thread` and its subthreads: how many stopped. */
async function stop(
  ctx: Context,
  thread: string,
  agent: string | undefined,
  seen = new Set<string>(),
): Promise<number> {
  if (seen.has(thread)) return 0;
  seen.add(thread);
  let stopped = 0;
  // Waiting turns first: once they answer, no reply from below resumes them.
  const waits = await ctx.db.collection<Wait>("wait").find({
    thread,
    ...(agent ? { agent } : {}),
    "waitingFor.0": { $exists: true },
  });
  for (const w of waits) {
    const run = w._id.slice(0, -":wait".length);
    await answer(ctx, w, run, "(stopped)", { stopped: true });
    stopped++;
  }
  for (const name of agent ? [agent] : await workingIn(ctx, thread)) {
    if (await ctx.cancel({ processor: "chat.turn", key: `${thread}:${name}` })) stopped++;
  }
  // What it asked in subthreads stops too.
  const asked = await ctx.db.collection<Message>("message").find({
    thread,
    subthread: { $exists: true },
  });
  for (const m of asked) stopped += await stop(ctx, m.subthread!, undefined, seen);
  return stopped;
}

/** Agents that may have a turn running in `thread`: its own, its space's, the app's, any writing. */
async function workingIn(ctx: Context, thread: string): Promise<string[]> {
  const [doc, live] = await Promise.all([
    ctx.db.collection<Thread>("thread").findOne({ _id: thread }),
    ctx.db.collection<Live>("live").find({ thread }),
  ]);
  return [
    ...new Set([
      ...Object.keys(agentsOf(ctx)),
      ...doc?.agents ?? [],
      ...(await rosterOf(ctx, doc?.in)).here,
      ...live.map((l) => l.agent),
    ]),
  ];
}
