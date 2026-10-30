/**
 * Rating: what a use cost and what to charge for it, by the books in force at
 * its time. Cost from `resources.cost` (by subject, `provider/*`), else the
 * catalog (the models plugin's `models.price`, for a model), else `*`. Price
 * from `resources.price` (by subject, `provider/*`, `*`): rates of the app's
 * own, or a gross margin on the cost; with none, a use's price is its cost (a
 * margin of 0). Each is kept by part too (input, cached, cacheWrite, output,
 * reasoning, seconds…), and what caching saved.
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

/**
 * A price: rates of its own, or a gross margin on the cost (the share of the
 * price that isn't cost: 0.9 is ten times the cost, 0.2 a quarter more).
 */
export type PriceRate = Rate | { margin: number; since?: string };

/** USD by part: each unit a use is measured in, `input` and `output` less the parts priced apart. */
export type Parts = Record<string, number>;

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
 * What quantities cost at a rate, by part. Tokens overlap: `input` counts the
 * cached and cache-written ones, `output` the reasoning ones; each part is at
 * its own price, and its own part, when the rate has one, else in its whole at
 * input's or output's. Undefined when a quantity used has no price.
 */
export function partsOf(quantities: Quantities, rate: Rate): Parts | undefined {
  const tier = (rate.tiers ?? []).filter((t) => (quantities.input ?? 0) > t.above)
    .sort((a, b) => a.above - b.above).at(-1);
  const p = { ...rate, ...tier } as Record<string, unknown>;
  const price = (unit: string) => typeof p[unit] === "number" ? p[unit] as number : undefined;
  const q = { ...quantities };
  const apart: [string, number][] = [];
  const within = (whole: string, part: string) => {
    if (!q[part]) return;
    if (price(part) === undefined) return; // Priced with its whole.
    q[whole] = (q[whole] ?? 0) - q[part];
    apart.push([part, q[part]]);
    delete q[part];
  };
  within("input", "cached");
  within("input", "cacheWrite");
  within("output", "reasoning");
  delete q.cached;
  delete q.cacheWrite;
  delete q.reasoning;
  const parts: Parts = {};
  for (const [unit, amount] of [...Object.entries(q), ...apart]) {
    if (!amount) continue;
    const each = price(unit);
    if (each === undefined) return undefined;
    parts[unit] = (parts[unit] ?? 0) + amount * each / (rate.per ?? 1_000_000);
  }
  return parts;
}

/** What quantities cost at a rate, in all (see `partsOf`). */
export function priced(quantities: Quantities, rate: Rate): number | undefined {
  const parts = partsOf(quantities, rate);
  return parts && sum(parts);
}

const sum = (parts: Parts) => Object.values(parts).reduce((a, b) => a + b, 0);
const scaled = (parts: Parts, by: number): Parts =>
  Object.fromEntries(Object.entries(parts).map(([unit, usd]) => [unit, usd * by]));
const rounded = (parts: Parts): Parts =>
  Object.fromEntries(
    Object.entries(parts).map(([unit, usd]) => [unit, round(usd)]).filter(([, usd]) => usd !== 0),
  );

/** A rate with its cache at input's price: what a use would have come to without caching. */
function uncached(rate: Rate): Rate {
  const { cached: _cached, cacheWrite: _written, ...plain } = rate;
  return {
    ...plain,
    ...(rate.tiers
      ? { tiers: rate.tiers.map(({ cached: _c, cacheWrite: _w, ...tier }) => tier) }
      : {}),
  } as Rate;
}

/**
 * A use, rated (USD): its cost and price, in all and by part; what caching
 * saved (less what writing the cache cost more), when it used one; who rated
 * each (`app`, the catalog and its date, or `cost` for a price at cost); and
 * what nothing priced.
 */
export type Rating = {
  cost?: number;
  price?: number;
  costs?: Parts;
  prices?: Parts;
  saved?: { cost?: number; price?: number };
  rated: { cost?: string; price?: string };
  unpriced?: string[];
};

/** Rates a use with the books in force at its time. */
export async function rate(ctx: Books, use: Use & { at: string }): Promise<Rating> {
  const book = ctx.resources.cost as Record<string, unknown> | undefined;
  const charges = ctx.resources.price as Record<string, unknown> | undefined;
  let costRate: Rate | undefined;
  let costBy: string | undefined;
  const own = inForce(named<Rate>(book, use.subject), use.at);
  if (own) [costRate, costBy] = [own, "app"];
  else {
    // What the catalog says, when there's one to ask (the models plugin's).
    const known = use.catalog && ctx.call
      ? await ctx.call<{ cost?: Cost; source: string }>("models.price", { catalog: use.catalog })
      : undefined;
    const fallback = inForce(book?.["*"] as Rate | Rate[] | undefined, use.at);
    if (known?.cost) [costRate, costBy] = [known.cost as Rate, known.source];
    else if (fallback) [costRate, costBy] = [fallback, "app"];
  }
  const costs = costRate && partsOf(use.quantities, costRate);
  const cost = costs && sum(costs);
  // The app's price, or a margin on the cost: none is a margin of 0, the cost itself.
  const charge = inForce(named<PriceRate>(charges, use.subject), use.at) ??
    inForce(charges?.["*"] as PriceRate | PriceRate[] | undefined, use.at);
  const margin = !charge ? 0 : "margin" in charge ? charge.margin as number : undefined;
  const markup = margin !== undefined && margin >= 0 && margin < 1 ? 1 / (1 - margin) : undefined;
  const prices = margin === undefined
    ? partsOf(use.quantities, charge as Rate)
    : costs && markup !== undefined
    ? scaled(costs, markup)
    : undefined;
  const price = prices && sum(prices);
  // What caching saved: the same use with its cache at input's price, less what it came to.
  let saved: Rating["saved"];
  if ((use.quantities.cached ?? 0) + (use.quantities.cacheWrite ?? 0) > 0) {
    const plainCost = costRate && priced(use.quantities, uncached(costRate));
    const savedCost = plainCost !== undefined && cost !== undefined ? plainCost - cost : undefined;
    const plainPrice = margin === undefined
      ? priced(use.quantities, uncached(charge as Rate))
      : undefined;
    const savedPrice = margin === undefined
      ? plainPrice !== undefined && price !== undefined ? plainPrice - price : undefined
      : savedCost !== undefined && markup !== undefined
      ? savedCost * markup
      : undefined;
    saved = {
      ...(savedCost !== undefined ? { cost: round(savedCost) } : {}),
      ...(savedPrice !== undefined ? { price: round(savedPrice) } : {}),
    };
  }
  const unpriced = [
    ...(cost === undefined ? ["cost"] : []),
    ...(price === undefined ? ["price"] : []),
  ];
  return {
    ...(cost !== undefined ? { cost: round(cost), costs: rounded(costs!) } : {}),
    ...(price !== undefined ? { price: round(price), prices: rounded(prices!) } : {}),
    ...(saved && Object.keys(saved).length ? { saved } : {}),
    rated: {
      ...(cost !== undefined ? { cost: costBy } : {}),
      ...(price !== undefined ? { price: charge ? "app" : "cost" } : {}),
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
