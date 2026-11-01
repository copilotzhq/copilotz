/**
 * `routine.origin`: a routine as what sets work going (chat's `Origin`), with
 * who it runs as and where, for what scopes a yes to it (computers). Plugin code
 * calls it, through the `origins` resource: nobody from outside.
 */
import { defineAction } from "../../../../runtime/mod.ts";
import type { Routine } from "../collections/routine.ts";
import { routinePath } from "../shared/routines.ts";

export const originAction = defineAction({
  description: "A routine, as what sets work going",
  input: {
    type: "object",
    properties: { id: { type: "string", minLength: 1 } },
    required: ["id"],
    additionalProperties: false,
  },
  run: async (ctx, { id }) => {
    const found = await ctx.as().db.collection<Routine>("routine").findOne({ _id: id });
    return found
      ? {
        origin: {
          kind: "routine",
          id,
          name: found.name,
          rev: found.rev ?? 0,
          path: routinePath(id),
        },
        by: found.by,
        in: found.in,
      }
      : null;
  },
});
