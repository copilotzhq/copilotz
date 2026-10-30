/**
 * `app.meter`, daily: what each app running a revision (live, or building
 * its next) ran since it was last metered
 * (vCPU and GiB seconds, requests), as its host tells it, in the ledger.
 * A host that can't tell (no `usage`) meters nothing; an app whose use
 * couldn't be read is metered from where it was the next time.
 */
import { defineAction } from "../../../../runtime/mod.ts";
import type { AppDoc } from "../collections/app.ts";
import type { AppHost } from "../contract.ts";
import { hostOf } from "../shared/host.ts";
import { meterRun } from "../shared/meter.ts";

export const meterAction = defineAction({
  description: "Meters what live apps ran",
  input: { type: "object", additionalProperties: false },
  run: async (ctx) => {
    let host: AppHost;
    try {
      host = hostOf(ctx);
    } catch {
      return { metered: 0 };
    }
    if (!host.usage) return { metered: 0 };
    // Up to when this run was due, so a retry meters the same span.
    const to = ctx.scheduled?.at ?? new Date().toISOString();
    // Those running a revision: live, or building a new one.
    const live = await ctx.as().db.collection<AppDoc>("app").find({
      target: { $exists: true },
      status: { $ne: "removed" },
    });
    let metered = 0;
    for (const app of live) {
      try {
        if (await meterRun(ctx, host, app, to)) metered++;
      } catch {
        // Tried again next time, from where it was.
      }
    }
    return { metered };
  },
});
