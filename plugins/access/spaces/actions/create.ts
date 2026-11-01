/**
 * `space.create`: a new space (shared by default), managed by whoever makes
 * it, with the app's default agents working there.
 */
import { defineAction, people } from "../../../../runtime/mod.ts";
import { seat } from "../shared/agents.ts";
import { memberKey, orgRoleOf } from "../shared/reach.ts";

export const createAction = defineAction({
  description: "Makes a space (a shared one, an org…); its maker manages it",
  input: {
    type: "object",
    properties: { id: { type: "string" }, name: { type: "string" }, kind: { type: "string" } },
    required: ["name"],
    additionalProperties: false,
  },
  allow: people,
  run: async (ctx, input) => {
    if (await orgRoleOf(ctx.actor!, ctx.as()) === "guest") {
      throw Object.assign(new Error("Guests work in the spaces they're invited to."), {
        code: "forbidden",
      });
    }
    const id = input.id ?? crypto.randomUUID();
    const who = memberKey(ctx.actor!);
    // Nobody reaches a space before it exists: it's made as the system, for them.
    await ctx.as().transaction(async (tx) => {
      await tx.db.collection("member").insertOne({
        _id: `${id}|${who}`,
        member: who,
        space: id,
        role: "manager",
      });
      await tx.db.collection("space").insertOne({
        _id: id,
        name: input.name,
        kind: input.kind ?? "shared",
        ...await seat(tx, ctx, id),
      });
    });
    return { space: id };
  },
});
