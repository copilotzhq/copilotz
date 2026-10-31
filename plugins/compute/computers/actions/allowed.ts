/**
 * `computer.allowed`: whether an agent may do something with its
 * conversation's computer that another plugin does for it (publishing what
 * it serves, for the apps plugin): `true`, or what the agent is told
 * instead, as the computer tools tell it. Its person (or the computer's
 * owner) is asked, and answers as they do for commands (see shared/ask.ts).
 * Nobody calls it from outside: plugin code does, for the agent's turn.
 */
import { defineAction } from "../../../../runtime/mod.ts";
import { allowed } from "../shared/ask.ts";
import { whereFor } from "../shared/where.ts";

export const allowedAction = defineAction({
  description: "Whether an agent may do something with its conversation's computer",
  input: {
    type: "object",
    properties: {
      thread: { type: "string" },
      agent: { type: "string" },
      kind: { enum: ["terminal", "jobs", "writes", "publish"] },
      /** The computer it's for (its name), when not the space's default. */
      computer: { type: "string" },
      /** What exactly, as its person reads it (and a yes this once covers). */
      detail: { type: "string" },
      preview: { type: "string" },
    },
    required: ["thread", "agent", "kind", "detail"],
    additionalProperties: false,
  },
  run: async (ctx, input): Promise<true | string> => {
    const where = await whereFor(ctx, input.thread, `agent:${input.agent}`, input.computer);
    if ("missing" in where) return where.missing;
    return await allowed(ctx, {
      owner: where.answerer,
      for: where.person,
      desk: where.desk._id,
      computer: where.desk.computer,
      ...(where.desk.name ? { name: where.desk.name } : {}),
      ...(where.desk.approve ? { approve: where.desk.approve } : {}),
      agent: input.agent,
      thread: input.thread,
      in: where.scope.space,
      work: input.kind,
      detail: input.detail,
      ...(input.preview ? { preview: input.preview } : {}),
    });
  },
});
