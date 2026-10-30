/**
 * Apps' use, in the ledger (meter `app`): a build's minutes (`app/build`)
 * and, daily, what each live app ran (`app/run`: vCPU and GiB seconds, and
 * requests), tagged with the app, its space and who published it. Without
 * the billing plugin (no `usage` resource) there's no ledger, and nothing
 * is recorded.
 */
import type { Context } from "../../../../runtime/mod.ts";
import type { AppDoc } from "../collections/app.ts";
import type { AppHost } from "../contract.ts";
import { APP_SUBJECTS } from "../contract.ts";

export async function meter(
  ctx: Context,
  app: Pick<AppDoc, "_id" | "space" | "by">,
  subject: string,
  quantities: Record<string, number>,
): Promise<void> {
  if (!ctx.resources.usage) return;
  await ctx.call("usage.record", {
    meter: "app",
    subject,
    quantities,
    tags: { app: app._id, space: app.space, person: app.by },
  });
}

/**
 * What a live app ran since it was last metered, up to `to`, when its host
 * can say (`usage`): recorded, and the app marked metered to then. The
 * record goes with that write, so it's kept once.
 */
export async function meterRun(
  ctx: Context,
  host: AppHost,
  app: AppDoc,
  to: string,
): Promise<boolean> {
  if (!host.usage) return false;
  const from = app.metered ?? app.live ?? app.at;
  if (from >= to) return false;
  const used = await host.usage(app.label, from, to);
  if (used.vcpuSeconds || used.gibSeconds || used.requests) {
    await meter(ctx, app, APP_SUBJECTS.run, used);
  }
  await ctx.as().db.collection("app").updateOne({ _id: app._id }, { $set: { metered: to } });
  return true;
}
