/**
 * `api_key.revoke`: its person, or a manager of its space, revokes a key (by
 * its id, as `api_key.mine` and the space's members list it): its secret
 * proves nobody from then on, its membership goes, and its connections
 * close. `api_key.used`: the API notes when a key was last used (the
 * system's).
 */
import { defineAction, forbidden, inPerson } from "../../../../runtime/mod.ts";
import { may } from "../../../access/spaces/contract.ts";
import type { ApiKey } from "../collections/key.ts";
import { endKey } from "../shared/end.ts";

export const revokeAction = defineAction({
  description: "Revokes a developer key: one of yours, or one in a space you manage",
  input: {
    type: "object",
    properties: { key: { type: "string", minLength: 1 } },
    required: ["key"],
    additionalProperties: false,
  },
  allow: inPerson,
  run: async (ctx, input) => {
    // Read as them: only a key in a space they read is one they know of.
    const found = await ctx.db.collection<ApiKey>("api_key").findOne({ _id: input.key });
    if (!found) return { revoked: 0 };
    if (found.person !== ctx.actor!.id && !await may(ctx, "manage", found.in)) {
      throw forbidden("Only whoever made a key, or a manager of its space, revokes it.");
    }
    await endKey(ctx, found);
    return { revoked: 1 };
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
