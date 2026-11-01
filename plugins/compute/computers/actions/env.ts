/**
 * A space's environment, changed by its managers (see collections/env-var.ts):
 *
 * - `env.set` `{ in, name, value?, secret?, computers?, app? }`: makes or
 *   changes a variable (or, with `app`, an app's own). Without `value`, a
 *   change keeps the one it has (a secret is never sent back to be kept).
 *   A secret is sealed, and shows only its `hint`. `computers` (true unless
 *   said): its computers' jobs and shells get it too; apps always do.
 * - `env.unset` `{ in, name, app? }`: takes it away; `{ in, app }`, all of
 *   an app's own (it was taken down).
 * - `env.values` `{ in, app?, computers? }`: names to values, secrets
 *   opened: the system's only (an app's deploy).
 *
 * People change it when they manage the space; the system (another
 * plugin's Action, an app's publisher's) always may.
 */
import { type Context, defineAction, personOf } from "../../../../runtime/mod.ts";
import type { EnvVar } from "../collections/env-var.ts";
import { may } from "../shared/desks.ts";
import { ENV_NAME, envId, envOf } from "../shared/env.ts";
import { seal } from "../shared/seal.ts";
import { settingsOf } from "../shared/settings.ts";

const invalid = (message: string) => Object.assign(new Error(message), { code: "invalid" });

/** Whether whoever asks may change the space's environment: its managers, or the system. */
async function mustManage(ctx: Context, space: string) {
  if (ctx.actor?.kind === "person" && !await may(ctx, space, "manage")) {
    throw Object.assign(new Error("Only those who manage this space can change its environment."), {
      code: "forbidden",
    });
  }
}

/** A long secret's last characters, to tell it apart; a short one shows nothing of itself. */
const hintOf = (value: string) => value.length >= 16 ? `••••${value.slice(-4)}` : undefined;

const target = {
  in: { type: "string" },
  name: { type: "string", pattern: ENV_NAME.source, maxLength: 128 },
  app: { type: "string" },
} as const;

export const envSetAction = defineAction({
  description: "Sets a variable or secret of a space's environment (or an app's own)",
  input: {
    type: "object",
    properties: {
      ...target,
      value: { type: "string", maxLength: 32768 },
      secret: { type: "boolean" },
      computers: { type: "boolean" },
    },
    required: ["in", "name"],
    additionalProperties: false,
  },
  allow: (actor) => actor.kind === "person",
  run: async (ctx, input) => {
    await mustManage(ctx, input.in);
    const vars = ctx.as().db.collection<EnvVar>("envVar");
    const _id = envId(input.in, input.name, input.app);
    const had = await vars.findOne({ _id });
    const secret = input.secret ?? had?.secret ?? false;
    if (input.value === undefined && (!had || secret !== had.secret)) {
      throw invalid(`${input.name} needs a value`);
    }
    const value = input.value;
    const now = new Date().toISOString();
    const set: Record<string, unknown> = {
      space: input.in,
      ...(input.app ? { app: input.app } : {}),
      name: input.name,
      secret,
      computers: input.computers ?? had?.computers ?? true,
      by: personOf(ctx.actor) ?? had?.by ?? "system",
      at: now,
    };
    const unset: Record<string, ""> = {};
    if (value !== undefined) {
      if (secret) {
        set.sealed = await seal(settingsOf(ctx).key, _id, value);
        const hint = hintOf(value);
        if (hint) set.hint = hint;
        else unset.hint = "";
        unset.value = "";
      } else {
        set.value = value;
        unset.sealed = "";
        unset.hint = "";
      }
    }
    await vars.updateOne({ _id }, {
      $set: set,
      ...(Object.keys(unset).length ? { $unset: unset } : {}),
    }, { upsert: true });
    const kept = (await vars.findOne({ _id }))!;
    const { sealed: _sealed, ...shown } = kept;
    return shown;
  },
});

export const envUnsetAction = defineAction({
  description: "Takes a variable or secret away from a space's environment (or an app's own)",
  input: {
    type: "object",
    properties: target,
    required: ["in"],
    additionalProperties: false,
  },
  allow: (actor) => actor.kind === "person",
  run: async (ctx, input) => {
    await mustManage(ctx, input.in);
    const vars = ctx.as().db.collection("envVar");
    if (input.name === undefined) {
      if (!input.app) throw invalid("Say which variable, or whose (an app's)");
      const { deletedCount } = await vars.deleteMany({ space: input.in, app: input.app });
      return { removed: deletedCount > 0 };
    }
    const { deletedCount } = await vars.deleteOne({ _id: envId(input.in, input.name, input.app) });
    return { removed: deletedCount > 0 };
  },
});

export const envValuesAction = defineAction({
  record: false,
  input: {
    type: "object",
    properties: { in: { type: "string" }, app: { type: "string" }, computers: { type: "boolean" } },
    required: ["in"],
    additionalProperties: false,
  },
  // No `allow`: only the system (an app's deploy) reads values, secrets opened.
  run: (ctx, input) =>
    envOf(ctx, input.in, {
      ...(input.app ? { app: input.app } : {}),
      ...(input.computers ? { computers: true } : {}),
    }),
});
