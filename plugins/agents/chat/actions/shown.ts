/**
 * `chat.shown`: an interface says an addition went out after an answer (see
 * `Addition`), once per chat per key. Trusted code only, and unrecorded:
 * called from a job, it runs inline and its record goes with the job's next
 * write. Interfaces don't write chat's collections: they say it here.
 */
import { defineAction } from "../../../../runtime/mod.ts";
import type { Thread } from "../collections/thread.ts";
import { now } from "../shared/agents.ts";

export const shownAction = defineAction({
  description: "Records that an addition went out after an answer",
  input: {
    type: "object",
    properties: {
      thread: { type: "string" },
      key: { type: "string", pattern: "^[\\w:.-]{1,120}$" },
      after: { type: "string" },
      medium: { type: "string", minLength: 1, maxLength: 40 },
      fallback: { type: "boolean" },
      note: { type: "string", maxLength: 500 },
    },
    required: ["thread", "key", "after", "medium"],
    additionalProperties: false,
  },
  record: false,
  run: async (ctx, input) => {
    const thread = await ctx.as().db.collection<Thread>("thread").findOne({ _id: input.thread });
    ctx.record("shown", {
      _id: `${input.thread}:${input.key}`,
      ...input,
      ...(thread?.in ? { in: thread.in } : {}),
      at: now(),
    });
    return { shown: `${input.thread}:${input.key}` };
  },
});
