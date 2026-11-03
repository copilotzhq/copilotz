/** Usage's settings: the `usage` resource, which an app patches. */
import type { Resources } from "../../../../runtime/mod.ts";
import { CATEGORIES, type Categories } from "./categories.ts";
import { type Rollups, UNITS } from "./totals.ts";

export type UsageSettings = {
  /**
   * How whole days are rolled up, so totals over many days read each day's
   * groups rather than its records. Totals are the same either way. The
   * `usage.close` schedule (00:10 UTC) closes each day; `schedules:
   * { "usage.close": null }` turns rollups off.
   */
  rollups: Rollups;
  /** What each category holds (see shared/categories.ts). */
  categories: Categories;
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

export const DEFAULTS: Pick<UsageSettings, "rollups" | "categories"> = {
  rollups: {
    dimensions: ["tags.agent", "tags.purpose", "tags.person", "tags.space"],
    units: UNITS,
    recheck: 7,
  },
  categories: CATEGORIES,
};

const usageOf = (ctx: { resources: Resources }) =>
  ctx.resources.usage as Partial<UsageSettings> | undefined;

/** How usage is rolled up, as configured. */
export const rollupsOf = (ctx: { resources: Resources }): Rollups => ({
  ...DEFAULTS.rollups,
  ...usageOf(ctx)?.rollups,
});

/** The categories, as configured. */
export const categoriesOf = (ctx: { resources: Resources }): Categories =>
  usageOf(ctx)?.categories ?? DEFAULTS.categories;
