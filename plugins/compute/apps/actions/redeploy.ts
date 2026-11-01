/**
 * `app.redeploy`: publishes an app's folder again, as it is now on its
 * computer: a new revision, built in the background as a publish is. Those
 * who may publish from its space may.
 */
import { defineAction, people } from "../../../../runtime/mod.ts";
import type { AppDoc } from "../collections/app.ts";
import { failure } from "../shared/errors.ts";
import { rebuild } from "../shared/publish.ts";
import { mustOwnOr } from "../../../access/spaces/contract.ts";

export const redeployAction = defineAction({
  description: "Publishes an app's folder again: a new revision",
  input: {
    type: "object",
    properties: { app: { type: "string" } },
    required: ["app"],
    additionalProperties: false,
  },
  allow: people,
  run: async (ctx, input) => {
    const app = await ctx.db.collection<AppDoc>("app").findOne({ _id: input.app });
    if (!app) throw failure("There's no such app here.", "not_found");
    await mustOwnOr(
      ctx,
      app.by,
      "manage",
      app.space,
      "Only who published it, or those who manage its space, can.",
    );
    return await rebuild(ctx, app);
  },
});
