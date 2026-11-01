/**
 * `space.can`: whether the caller may do something in a space: `read` it,
 * `write` in it (add to it, use what's in it), or `manage` it (its members,
 * what's shared there). For other plugins and front ends, which reach spaces
 * only by name: computers check it before someone uses a space's computer.
 */
import { defineAction } from "../../../../runtime/mod.ts";
import { may } from "../shared/can.ts";

export const canAction = defineAction({
  description: "Whether you may read, write in or manage a space",
  input: {
    type: "object",
    properties: {
      space: { type: "string" },
      verb: { enum: ["read", "write", "manage"] },
    },
    required: ["space", "verb"],
    additionalProperties: false,
  },
  allow: (actor) => actor.kind === "person" || actor.kind === "agent",
  run: async (ctx, input) => {
    return { can: await may(ctx, input.verb, input.space) };
  },
});
