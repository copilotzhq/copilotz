/**
 * Usage: what was used, what it cost, and what to charge for it, as a
 * ledger.
 *
 * - **Uses** reach the ledger, which appends one record each (`ctx.record`:
 *   no round trip of its own, kept even if the job fails). Every model call
 *   does on its own: the ledger plugs into the models plugin's `modelUse`.
 *   An app records its own (a to-do app's API calls) with `usage.record`,
 *   which runs inline in its job.
 * - **Rating** happens as a use is recorded, so a record keeps what applied:
 *   - its **cost** comes from `resources.cost` (the app's rates: negotiated,
 *     a subscription at 0, a terminal's seconds), else from the models.dev
 *     catalog for models it knows;
 *   - its **price** (what the app charges) comes from `resources.price` only:
 *     rates of its own, or a `markup` on the cost. Nothing ships one.
 *   - A use nothing prices is recorded all the same, and flagged `unpriced`.
 * - **Totals** by any field or tag: `runtime.query("usage.totals", { filter, by })`.
 *   Whole closed days come from rollups (`usage.close`, scheduled daily),
 *   the rest from the records, with the same result.
 * - **Re-rating** (`usage.rerate`) never changes a record: it appends
 *   adjustments for what new rates would change, so totals follow.
 * - **Across an org** (where the app serves many): `usage.org` (totals) and
 *   `usage.calls` (the latest uses) give its owners and admins everyone's,
 *   and anyone else their own. Its web front end (web.tsx) is the org
 *   page's Usage section.
 *
 * Rates are keyed by subject (`"openai/gpt-6.1-sol"`), then by provider
 * (`"chatgpt/*"`), then the catalog, then `"*"`. A rate prices units per
 * `per` (1,000,000 by default, as models.dev prices tokens; `per: 1` or `60`
 * for seconds), and a list of rates with `since` dates applies each from its
 * date.
 */
import { definePlugin, type Plugin } from "../../../runtime/mod.ts";
import { closeAction } from "./actions/close.ts";
import { rerateAction } from "./actions/rerate.ts";
import { usageClosed } from "./collections/closed.ts";
import { usageRollup } from "./collections/rollup.ts";
import { usage } from "./collections/usage.ts";
import { DEFAULTS, rollupsOf } from "./shared/settings.ts";
import { recordAction } from "./actions/record.ts";
import { orgUsageAction, usageCallsAction } from "./actions/org.ts";
import { ledger } from "./resources/ledger.ts";

export type { Use } from "./shared/use.ts";
export type { UsageRecord } from "./collections/usage.ts";
export { priced, type PriceRate, type Quantities, type Rate, rate } from "./shared/rate.ts";
export { type Rollups, type Totals, totals, UNITS } from "./shared/totals.ts";

export type { UsageSettings } from "./shared/settings.ts";

/** The usage ledger: records, rating, totals, rollups and re-rating. */
export const usagePlugin: Plugin = definePlugin({
  name: "usage",
  collections: { usage, usageRollup, usageClosed },
  resources: { usage: DEFAULTS, modelUse: { ledger } },
  actions: {
    "usage.record": recordAction,
    "usage.rerate": rerateAction,
    "usage.close": closeAction,
    "usage.org": orgUsageAction,
    "usage.calls": usageCallsAction,
  },
  schedules: { "usage.close": { cron: "10 0 * * *", call: "usage.close", input: {} } },
  check(merged) {
    for (const dimension of rollupsOf(merged).dimensions) {
      if (!/^(tags\.[^.]+|catalog)$/.test(dimension)) {
        throw new Error(`rollup dimension "${dimension}" is not tags.<name> or catalog`);
      }
    }
  },
});

export default usagePlugin;
