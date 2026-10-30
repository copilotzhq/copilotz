/**
 * `api_key.revoke`: a person revokes one of their keys (by its id, as
 * `api_key.mine` lists it); calls with it fail from then on.
 * `api_key.used`: the API notes when a key was last used (the system's).
 */
import { defineAction } from "../../../../runtime/mod.ts";

export const revokeAction = defineAction({
  description: "Revokes one of your developer keys",
  input: {
    type: "object",
    properties: { key: { type: "string", minLength: 1 } },
    required: ["key"],
    additionalProperties: false,
  },
  allow: (actor) => actor.kind === "person" && !actor.key,
  run: async (ctx, input) => {
    // Their own only: the rules keep a person to their keys.
    const removed = await ctx.db.collection("api_key").deleteOne({ _id: input.key });
    return { revoked: removed.acknowledged ? removed.deletedCount : 0 };
  },
});

export const usedAction = defineAction({
  description: "Notes when a developer key was last used",
  input: {
    type: "object",
    properties: { key: { type: "string" }, at: { type: "string" } },
    required: ["key", "at"],
    additionalProperties: false,
  },
  // Bookkeeping: the key's own change is the record.
  record: false,
  run: async (ctx, input) => {
    await ctx.db.collection("api_key").updateOne({ _id: input.key }, { $set: { used: input.at } });
  },
});
