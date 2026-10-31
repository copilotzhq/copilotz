/**
 * A space's environment, as work gets it: read as the system, secrets
 * opened (see collections/env-var.ts). Its computers' jobs and shells get
 * those `computers` says; an app gets all of them, its own over the space's.
 */
import type { Context } from "../../../../runtime/mod.ts";
import type { EnvVar } from "../collections/env-var.ts";
import { unseal } from "./seal.ts";
import { settingsOf } from "./settings.ts";

/** What a variable may be named. */
export const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;

/** A variable's id: one per space, app (none: the space's) and name. */
export const envId = (space: string, name: string, app?: string) => `${space}|${app ?? ""}|${name}`;

/** Its value, opened (a secret's). */
async function valueOf(ctx: Pick<Context, "resources">, found: EnvVar): Promise<string> {
  if (!found.secret) return found.value ?? "";
  return found.sealed ? await unseal(settingsOf(ctx).key, found._id, found.sealed) : "";
}

/**
 * A space's environment, names to values: `computers`, only what its
 * computers get; `app`, an app's (all the space's, its own over them).
 */
export async function envOf(
  ctx: Context,
  space: string,
  options: { computers?: boolean; app?: string } = {},
): Promise<Record<string, string>> {
  const vars = ctx.as().db.collection<EnvVar>("envVar");
  const own = await vars.find({ space, app: { $exists: false } });
  const env: Record<string, string> = {};
  for (const found of own) {
    if (options.computers && !found.computers) continue;
    env[found.name] = await valueOf(ctx, found);
  }
  if (options.app) {
    for (const found of await vars.find({ space, app: options.app })) {
      env[found.name] = await valueOf(ctx, found);
    }
  }
  return env;
}

/** Overrides a caller gives (`env`: names to text), checked; and the space's computers' under them. */
export async function jobEnv(
  ctx: Context,
  space: string,
  given: unknown,
): Promise<Record<string, string>> {
  const overrides: Record<string, string> = {};
  if (given !== undefined) {
    if (!given || typeof given !== "object" || Array.isArray(given)) {
      throw Object.assign(new Error("env is an object of names to values"), { code: "invalid" });
    }
    for (const [name, value] of Object.entries(given)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || typeof value !== "string") {
        throw Object.assign(new Error(`"${name}" isn't an environment variable (a name, text)`), {
          code: "invalid",
        });
      }
      overrides[name] = value;
    }
  }
  return { ...await envOf(ctx, space, { computers: true }), ...overrides };
}
