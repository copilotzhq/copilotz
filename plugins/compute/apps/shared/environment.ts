/**
 * An app's environment, as it's deployed: its space's (all of it, secrets
 * opened) with its own over it, as the computers plugin keeps them
 * (`env.values`). Without one (no such Action), none.
 */
import type { Context } from "../../../../runtime/mod.ts";
import type { AppDoc } from "../collections/app.ts";

export async function environmentOf(
  ctx: Context,
  app: Pick<AppDoc, "_id" | "space">,
): Promise<Record<string, string>> {
  try {
    return await ctx.as().call<Record<string, string>>("env.values", {
      in: app.space,
      app: app._id,
    });
  } catch (error) {
    // An app without the computers plugin's environment deploys with none.
    if (String((error as Error)?.message ?? "").startsWith('Unknown action "env.values"')) {
      return {};
    }
    throw error;
  }
}
