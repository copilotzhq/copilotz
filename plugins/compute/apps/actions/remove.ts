/**
 * `app.remove`: takes an app down: its service at the host goes, and the
 * directory lets its host go. Who published it may, and those who manage
 * its space. What it ran since it was last metered is metered first. The
 * record stays, removed; its own environment goes.
 */
import { defineAction, people } from "../../../../runtime/mod.ts";
import type { AppDoc } from "../collections/app.ts";
import { release } from "../shared/claims.ts";
import { failure } from "../shared/errors.ts";
import { hostOf } from "../shared/host.ts";
import { meterRun } from "../shared/meter.ts";
import { settingsOf } from "../shared/settings.ts";
import { mustOwnOr } from "../../../access/spaces/contract.ts";

export const removeAction = defineAction({
  description: "Takes a published app down",
  input: {
    type: "object",
    properties: { app: { type: "string" } },
    required: ["app"],
    additionalProperties: false,
  },
  allow: people,
  run: async (ctx, input) => {
    // The rules reach only the apps of spaces the person is in.
    const app = await ctx.db.collection<AppDoc>("app").findOne({ _id: input.app });
    if (!app) throw failure("There's no such app here.", "not_found");
    if (app.status === "removed") return { removed: true };
    await mustOwnOr(
      ctx,
      app.by,
      "manage",
      app.space,
      "Only who published it, or those who manage this space, can take it down.",
    );
    const host = hostOf(ctx);
    if (app.target) {
      // Recorded as its publisher's use, whoever takes it down.
      const theirs = ctx.as({ kind: "person", id: app.by });
      await meterRun(theirs, host, app, new Date().toISOString()).catch(() => {});
    }
    await host.remove(app.label);
    await release(ctx, `${app.label}.${settingsOf(ctx).domain}`);
    await ctx.as().db.collection("app").updateOne({ _id: app._id }, {
      $set: { status: "removed" },
      $unset: { target: "" },
    });
    // Its own environment goes with it (published again, it's another app).
    await ctx.as().call("env.unset", { in: app.space, app: app._id }).catch(() => {});
    return { removed: true };
  },
});
