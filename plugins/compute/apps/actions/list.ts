/** `app.list`: the apps of a space (`in`), or of every space the caller reaches, newest first. */
import { defineAction } from "../../../../runtime/mod.ts";
import type { AppDoc } from "../collections/app.ts";

export const listAction = defineAction({
  description: "The apps published from a space, or from every space you reach",
  input: {
    type: "object",
    properties: { in: { type: "string" } },
    additionalProperties: false,
  },
  allow: (actor) => actor.kind === "person" || actor.kind === "agent",
  // The rules keep to the spaces the caller reaches.
  run: (ctx, input) =>
    ctx.db.collection<AppDoc>("app").find(
      { status: { $ne: "removed" }, ...(input.in ? { space: input.in } : {}) },
      { sort: { at: -1 } },
    ),
});
