/**
 * `space.leave`: leaving a shared space you're in. Not your Personal space,
 * which is yours; and not as its only manager: make someone else one first.
 * What you added there stays, the space's.
 */
import { defineAction } from "../../../../runtime/mod.ts";
import { keepsAManager } from "../shared/managers.ts";
import { PERSONAL } from "../shared/personal.ts";
import { memberKey } from "../shared/reach.ts";

export const leaveAction = defineAction({
  description: "Leaves a shared space you're in",
  input: {
    type: "object",
    properties: { space: { type: "string" } },
    required: ["space"],
    additionalProperties: false,
  },
  allow: (actor) => actor.kind === "person",
  run: async (ctx, input) => {
    const db = ctx.as().db;
    const found = await db.collection<{ kind?: string }>("space").findOne({ _id: input.space });
    if (!found) return { left: false };
    if (found.kind === PERSONAL) {
      throw Object.assign(new Error("Your Personal space is yours: it can't be left."), {
        code: "forbidden",
      });
    }
    const key = memberKey(ctx.actor!);
    const mine = await db.collection("member").findOne({ _id: `${input.space}|${key}` });
    if (!mine) return { left: false };
    await keepsAManager(ctx, input.space, key);
    await db.collection("member").deleteOne({ _id: `${input.space}|${key}` });
    return { left: true };
  },
});
