/**
 * `space.create`: a new space (shared by default), managed by whoever makes
 * it, with the app's default agents working there. Not one the app declares
 * (see shared/declared.ts): those are the app's, made by `space.keep`.
 */
import { defineAction, people } from "../../../../runtime/mod.ts";
import { seat } from "../shared/agents.ts";
import { declaredOf } from "../shared/declared.ts";
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
    // A guest's, through a key of theirs too: the person's role says.
    const person = { kind: ctx.actor!.kind, id: ctx.actor!.id };
    if (await orgRoleOf(person, ctx.as()) === "guest") {
      throw Object.assign(new Error("Guests work in the spaces they're invited to."), {
        code: "forbidden",
      });
    }
    // A space the app declares is the app's (`space.keep` makes it): made first by a person,
    // they would manage it, and the app's customers with it.
    if (input.id !== undefined && declaredOf(ctx, input.id)) {
      throw Object.assign(new Error(`Space "${input.id}" is the app's own.`), {
        code: "forbidden",
      });
    }
    const id = input.id ?? crypto.randomUUID();
    // Its maker manages it: a person, even through a key of theirs (which stays in its own space).
    const who = memberKey(person);
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
