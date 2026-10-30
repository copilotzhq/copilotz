/**
 * `app.redeploy`: publishes an app's folder again, as it is now on its
 * computer: a new revision, built in the background as a publish is. Those
 * who may publish from its space may.
 */
import { defineAction } from "../../../../runtime/mod.ts";
import type { AppDoc } from "../collections/app.ts";
import { failure } from "../shared/errors.ts";
import { can, rebuild } from "../shared/publish.ts";

export const redeployAction = defineAction({
  description: "Publishes an app's folder again: a new revision",
  input: {
    type: "object",
    properties: { app: { type: "string" } },
    required: ["app"],
    additionalProperties: false,
  },
  allow: (actor) => actor.kind === "person",
  run: async (ctx, input) => {
    const app = await ctx.db.collection<AppDoc>("app").findOne({ _id: input.app });
    if (!app) throw failure("There's no such app here.", "not_found");
    if (!await can(ctx, app.space, "write")) {
      throw failure("You can't publish from this space.", "forbidden");
    }
    return await rebuild(ctx, app);
  },
});
