/**
 * `app.configure` `{ app, env? }`: an app's own environment, and its
 * deploy again with it: `env`, its changes (`{ name, value?, secret?,
 * remove? }` each, over its space's: see the computers plugin's
 * environment), then, when it's live, its image deployed again with its
 * space's environment and its own over it (a new revision, no build).
 * Without changes, that's all it does: a change to its space's environment
 * reaches it so. Its publisher may, and those who manage its space. Answers
 * its status (and its revision, deployed).
 */
import { defineAction, personOf } from "../../../../runtime/mod.ts";
import type { AppDoc } from "../collections/app.ts";
import { environmentOf } from "../shared/environment.ts";
import { failure } from "../shared/errors.ts";
import { hostOf } from "../shared/host.ts";
import { can } from "../shared/publish.ts";

type Change = { name: string; value?: string; secret?: boolean; remove?: boolean };

export const configureAction = defineAction({
  description: "Changes a published app's environment, and deploys it again with it",
  input: {
    type: "object",
    properties: {
      app: { type: "string" },
      env: {
        type: "array",
        maxItems: 100,
        items: {
          type: "object",
          properties: {
            name: { type: "string", pattern: "^[A-Z_][A-Z0-9_]*$", maxLength: 128 },
            value: { type: "string", maxLength: 32768 },
            secret: { type: "boolean" },
            remove: { type: "boolean" },
          },
          required: ["name"],
          additionalProperties: false,
        },
      },
    },
    required: ["app"],
    additionalProperties: false,
  },
  allow: (actor) => actor.kind === "person",
  run: async (ctx, input) => {
    // The rules reach only the apps of spaces the person is in.
    const app = await ctx.db.collection<AppDoc>("app").findOne({ _id: input.app });
    if (!app || app.status === "removed") throw failure("There's no such app here.", "not_found");
    if (app.by !== personOf(ctx.actor) && !await can(ctx, app.space, "manage")) {
      throw failure("Only who published it, or those who manage its space, can.", "forbidden");
    }
    for (const change of (input.env ?? []) as Change[]) {
      const at = { in: app.space, app: app._id, name: change.name };
      await (change.remove ? ctx.as().call("env.unset", at) : ctx.as().call("env.set", {
        ...at,
        ...(change.value !== undefined ? { value: change.value } : {}),
        ...(change.secret !== undefined ? { secret: change.secret } : {}),
      }));
    }
    if (app.status !== "live" || !app.image) return { status: app.status };
    const deployed = await hostOf(ctx).deploy({
      app: app.label,
      image: app.image,
      port: app.served ?? app.source.port,
      env: await environmentOf(ctx, app),
    });
    const at = new Date().toISOString();
    await ctx.as().db.collection("app").updateOne({ _id: app._id }, {
      $set: { service: deployed.service, target: deployed.target, revision: deployed.revision },
      $unset: { error: "" },
      $push: { revisions: { revision: deployed.revision, image: app.image, at } },
    });
    return { status: "live", revision: deployed.revision };
  },
});
