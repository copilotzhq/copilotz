/** Usage's settings: the `usage` resource, which an app patches. */
import type { Resources } from "../../../../runtime/mod.ts";
import { type Rollups, UNITS } from "./totals.ts";

export type UsageSettings = {
  /**
   * How whole days are rolled up, so totals over many days read each day's
   * groups rather than its records. Totals are the same either way. The
   * `usage.close` schedule (00:10 UTC) closes each day; `schedules:
   * { "usage.close": null }` turns rollups off.
   */
  rollups: Rollups;
  /**
   * Whoever keeps an org's plan: the Action naming its price list among
   * `resources.priceLists` (none: `resources.price`). Answers its name or null.
   */
  priceList?: string;
  /**
   * The Action told what each use was charged (`{ price }`), before it's
   * recorded, so what's left is known without reading the ledger.
   */
  spent?: string;
};

export const DEFAULTS: Pick<UsageSettings, "rollups"> = {
  rollups: { dimensions: ["tags.agent", "tags.purpose", "tags.person"], units: UNITS, recheck: 7 },
};

/** How usage is rolled up, as configured. */
export const rollupsOf = (ctx: { resources: Resources }): Rollups => ({
  ...DEFAULTS.rollups,
  ...(ctx.resources.usage?.rollups as Partial<Rollups> | undefined),
});
