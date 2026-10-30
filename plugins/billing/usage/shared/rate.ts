/**
 * Rating: what a use cost and what to charge for it, by the books in force at
 * its time. Cost from `resources.cost` (by subject, `provider/*`), else the
 * catalog (the models plugin's `models.price`, for a model), else `*`; price
 * from `resources.price` only.
 */
import type { Context, ReadContext } from "../../../../runtime/mod.ts";
import type { Cost, Prices } from "../../../models/contract.ts";
import type { Use } from "./use.ts";

/** What a use is measured in: tokens (`input`, `output`, …), `seconds`, `calls`, or units of your own. */
export type Quantities = Record<string, number | undefined>;

/** Prices per `per` units (1,000,000 by default), from `since` on; any unit of your own too. */
export type Rate = Prices & {
  per?: number;
  since?: string;
  tiers?: Cost["tiers"];
  [unit: string]: number | string | Cost["tiers"] | undefined;
};

/** A price: rates of its own, or a markup on the cost (0.2 is cost plus 20%). */
export type PriceRate = Rate | { markup: number; since?: string };

type Books = Pick<Context, "resources"> & { call?: ReadContext["call"] };

/** The rate in force at `at`: the latest whose `since` has come. */
function inForce<R extends { since?: string }>(entry: R | R[] | undefined, at: string) {
  if (!entry) return undefined;
  const rates = (Array.isArray(entry) ? entry : [entry])
    .filter((rate) => !rate.since || rate.since <= at)
    .sort((a, b) => (a.since ?? "").localeCompare(b.since ?? ""));
  return rates.at(-1);
}

/** A book's entry for a subject: by its name, then its provider's (`provider/*`). */
function named<R>(book: Record<string, unknown> | undefined, subject: string) {
  if (!book) return undefined;
  const slash = subject.indexOf("/");
  return (book[subject] ?? (slash > 0 ? book[`${subject.slice(0, slash)}/*`] : undefined)) as
    | R
    | R[]
    | undefined;
}

/**
 * What quantities cost at a rate. Tokens overlap: `input` counts the cached
 * and cache-written ones, `output` the reasoning ones; each part is at its
 * own price when the rate has one, the rest at input's or output's. Undefined
 * when a quantity used has no price.
 */
export function priced(quantities: Quantities, rate: Rate): number | undefined {
  const tier = (rate.tiers ?? []).filter((t) => (quantities.input ?? 0) > t.above)
    .sort((a, b) => a.above - b.above).at(-1);
  const p = { ...rate, ...tier } as Record<string, unknown>;
  const price = (unit: string) => typeof p[unit] === "number" ? p[unit] as number : undefined;
  const q = { ...quantities };
  const parts: [string, number][] = [];
  const within = (whole: string, part: string) => {
    if (!q[part]) return;
    if (price(part) === undefined) return; // Priced with its whole.
    q[whole] = (q[whole] ?? 0) - q[part];
    parts.push([part, q[part]]);
    delete q[part];
  };
  within("input", "cached");
  within("input", "cacheWrite");
  within("output", "reasoning");
  delete q.cached;
  delete q.cacheWrite;
  delete q.reasoning;
  let total = 0;
  for (const [unit, amount] of [...Object.entries(q), ...parts]) {
    if (!amount) continue;
    const each = price(unit);
    if (each === undefined) return undefined;
    total += amount * each;
  }
  return total / (rate.per ?? 1_000_000);
}

/** A use, rated: its cost and price (USD), who rated each, and what wasn't. */
export type Rating = {
  cost?: number;
  price?: number;
  rated: { cost?: string; price?: string };
  unpriced?: string[];
};

/** Rates a use with the books in force at its time. */
export async function rate(ctx: Books, use: Use & { at: string }): Promise<Rating> {
  const costs = ctx.resources.cost as Record<string, unknown> | undefined;
  const prices = ctx.resources.price as Record<string, unknown> | undefined;
  let cost: number | undefined;
  let costBy: string | undefined;
  const own = inForce(named<Rate>(costs, use.subject), use.at);
  if (own) [cost, costBy] = [priced(use.quantities, own), "app"];
  else {
    // What the catalog says, when there's one to ask (the models plugin's).
    const known = use.catalog && ctx.call
      ? await ctx.call<{ cost?: Cost; source: string }>("models.price", { catalog: use.catalog })
      : undefined;
    const fallback = inForce(costs?.["*"] as Rate | Rate[] | undefined, use.at);
    if (known?.cost) [cost, costBy] = [priced(use.quantities, known.cost), known.source];
    else if (fallback) [cost, costBy] = [priced(use.quantities, fallback), "app"];
  }
  const charge = inForce(named<PriceRate>(prices, use.subject), use.at) ??
    inForce(prices?.["*"] as PriceRate | PriceRate[] | undefined, use.at);
  const price = !charge
    ? undefined
    : "markup" in charge
    ? cost === undefined ? undefined : cost * (1 + (charge.markup as number))
    : priced(use.quantities, charge as Rate);
  const unpriced = [
    ...(cost === undefined ? ["cost"] : []),
    ...(prices && Object.keys(prices).length && price === undefined ? ["price"] : []),
  ];
  return {
    ...(cost !== undefined ? { cost: round(cost) } : {}),
    ...(price !== undefined ? { price: round(price) } : {}),
    rated: {
      ...(cost !== undefined ? { cost: costBy } : {}),
      ...(price !== undefined ? { price: "app" } : {}),
    },
    ...(unpriced.length ? { unpriced } : {}),
  };
}

/** USD to a millionth of a cent: sums stay exact enough, records stay readable. */
export const round = (usd: number) => Math.round(usd * 1e8) / 1e8;

export const nonzero = (quantities: Quantities): Record<string, number> =>
  Object.fromEntries(
    Object.entries(quantities).filter((entry): entry is [string, number] =>
      typeof entry[1] === "number" && Number.isFinite(entry[1]) && entry[1] !== 0
    ),
  );
