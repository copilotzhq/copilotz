/**
 * Usage as the web says it: money, tokens, counts and shares in few
 * characters; a model by its name with its provider apart; a period's days
 * (each with its sums, empty days included) and the period before it;
 * groups (by person, agent, model) largest first, with their share; and
 * caching: how much input came from a cache, what it was charged and what
 * it saved.
 *
 * Everything is in what people are charged (the price, "spend"). What it
 * cost, and so the margin, is there only for platform staff: the totals
 * they get carry `cost`, and others' don't.
 */
import type { Quantities } from "../../shared/rate.ts";
import type { PriceTotals } from "../../shared/totals.ts";

/** A total as the page gets it: its price; for platform staff, its cost too. */
export type Total = PriceTotals & {
  cost?: number;
  costs?: Quantities;
  saved: { price: number; cost?: number };
};

/** What a chart and the groups measure. */
export type Measure = "spend" | "tokens" | "calls";

const MINUS = "−";

/**
 * US dollars: cents when there are some, fewer digits as it grows, "<$0.01"
 * for crumbs; `fine` keeps two digits of a crumb ("$0.0042"), for a single
 * call. Below zero, a minus sign.
 */
export function usd(n: number, fine = false): string {
  if (n < 0) return `${MINUS}${usd(-n, fine)}`;
  if (!n) return "$0";
  if (n < 0.01) {
    if (!fine) return "<$0.01";
    return n < 0.0001 ? "<$0.0001" : `$${Number(n.toPrecision(2))}`;
  }
  if (n < 100) return `$${n.toFixed(2)}`;
  if (n < 10_000) return `$${Math.round(n).toLocaleString("en-US")}`;
  return `$${compact(n)}`;
}

/** A count in few characters: 940, 12.9K, 4.2M. */
export function compact(n: number): string {
  const abs = Math.abs(n);
  const [d, unit] = abs >= 1e9 ? [1e9, "B"] : abs >= 1e6 ? [1e6, "M"] : abs >= 1e3 ? [1e3, "K"] : [
    1,
    "",
  ];
  if (!unit) return Math.round(n).toLocaleString("en-US");
  const scaled = n / d;
  return `${scaled >= 100 ? Math.round(scaled) : Number(scaled.toFixed(1))}${unit}`;
}

/**
 * A share as a whole percentage: "<1%" for a sliver, ">99%" for nearly all
 * (so neither reads as none or all), a minus sign below zero, "—" for none.
 */
export function percent(fraction: number | undefined): string {
  if (fraction === undefined || !Number.isFinite(fraction)) return "—";
  if (fraction < 0) return `${MINUS}${percent(-fraction)}`;
  if (fraction === 0) return "0%";
  if (fraction < 0.01) return "<1%";
  if (fraction > 0.99 && fraction < 1) return ">99%";
  return `${Math.round(fraction * 100)}%`;
}

/** The tokens a total counts: what went in and what came out. */
export const tokensOf = (t: Pick<Total, "quantities">): number =>
  (t.quantities.input ?? 0) + (t.quantities.output ?? 0);

/**
 * How much of the input came from a cache: cache reads over input tokens
 * (which count them). None when nothing went in.
 */
export const hitRate = (cached: number, input: number): number | undefined =>
  input > 0 ? Math.min(1, Math.max(0, cached) / input) : undefined;

/**
 * The gross margin: the share of the price that isn't cost. None without a
 * cost, or without a price to take a share of.
 */
export const marginOf = (price: number, cost: number | undefined): number | undefined =>
  cost === undefined || !(price > 0) ? undefined : (price - cost) / price;

/**
 * What caching saved, in words: "$1.23 saved"; or, below zero (writing to
 * the cache was charged more than reading from it saved), how much more.
 */
export function savedSaid(n: number | undefined): string {
  if (!n) return "Nothing saved yet";
  return n > 0 ? `${usd(n)} saved` : `${usd(-n)} more than without it`;
}

/** A model as people read it: its name, and its provider apart (`openai/gpt-6.1-sol`). */
export function modelOf(subject: string): { name: string; provider?: string } {
  const at = subject.indexOf("/");
  return at < 0
    ? { name: subject }
    : { provider: subject.slice(0, at), name: subject.slice(at + 1) };
}

/** An agent's key as a name: `researcher` is "Researcher". */
export const agentName = (key: string): string =>
  key ? key[0].toUpperCase() + key.slice(1).replace(/[-_]+/g, " ") : "";

/**
 * Totals summed: spend (the price), tokens, calls and what's unpriced; the
 * input's parts (from the cache, written to it, neither) with their spend
 * and what caching saved; and, for staff, the cost (none for anyone else).
 */
export type Sum = {
  spend: number;
  tokens: number;
  calls: number;
  unpriced: number;
  input: number;
  output: number;
  /** Input tokens read from a cache, and written to one. */
  cached: number;
  cacheWrite: number;
  /** Spend on input read from a cache, written to one, and neither. */
  cachedSpend: number;
  cacheWriteSpend: number;
  inputSpend: number;
  /** What caching saved, at the price (below zero: it was charged more). */
  saved: number;
  /** Only for staff. */
  cost?: number;
  savedCost?: number;
};

export const zero = (): Sum => ({
  spend: 0,
  tokens: 0,
  calls: 0,
  unpriced: 0,
  input: 0,
  output: 0,
  cached: 0,
  cacheWrite: 0,
  cachedSpend: 0,
  cacheWriteSpend: 0,
  inputSpend: 0,
  saved: 0,
});

/** Adds a total into a sum (which it changes, and gives back). */
export function add(into: Sum, t: Total): Sum {
  const q = t.quantities;
  into.spend += t.price;
  into.tokens += tokensOf(t);
  into.calls += t.uses;
  into.unpriced += t.unpriced;
  into.input += q.input ?? 0;
  into.output += q.output ?? 0;
  into.cached += q.cached ?? 0;
  into.cacheWrite += q.cacheWrite ?? 0;
  into.cachedSpend += t.prices.cached ?? 0;
  into.cacheWriteSpend += t.prices.cacheWrite ?? 0;
  into.inputSpend += t.prices.input ?? 0;
  into.saved += t.saved.price ?? 0;
  if (t.cost !== undefined) into.cost = (into.cost ?? 0) + t.cost;
  if (t.saved.cost !== undefined) into.savedCost = (into.savedCost ?? 0) + t.saved.cost;
  return into;
}

/** Totals summed into one. */
export const sumOf = (totals: Total[]): Sum => totals.reduce(add, zero());

const DAY = 86_400_000;

/** A UTC day, `2026-10-29`. */
export const dayOf = (at: Date | number): string => new Date(at).toISOString().slice(0, 10);

/** Where a period of `days` days, ending today, starts; and the one before it. */
export function periodOf(days: number, now = Date.now()): { since: string; before: string } {
  const today = Date.parse(`${dayOf(now)}T00:00:00Z`);
  return {
    since: new Date(today - (days - 1) * DAY).toISOString(),
    before: new Date(today - (2 * days - 1) * DAY).toISOString(),
  };
}

/** A day's sums, for the chart. */
export type Day = Sum & { day: string };

/** Each day of the period, oldest first, with its sums (none: zeros). */
export function daysOf(totals: Total[], days: number, now = Date.now()): Day[] {
  const byDay = new Map(totals.map((t) => [String(t.key.day), t]));
  const today = Date.parse(`${dayOf(now)}T00:00:00Z`);
  return Array.from({ length: days }, (_, i) => {
    const day = dayOf(today - (days - 1 - i) * DAY);
    const t = byDay.get(day);
    return { day, ...(t ? add(zero(), t) : zero()) };
  });
}

/** The days' sums, split into the period and the one before it (by `since`). */
export function sums(totals: Total[], since: string): { now: Sum; before: Sum } {
  const now = zero();
  const before = zero();
  const first = since.slice(0, 10);
  for (const t of totals) add(String(t.key.day) >= first ? now : before, t);
  return { now, before };
}

/** How much a period changed from the one before: a fraction, or none when there was nothing. */
export const change = (now: number, before: number): number | undefined =>
  before > 0 ? (now - before) / before : undefined;

/** A change, unsigned (an arrow says which way): a percentage, or how many times over once it's ten. */
export const changeSaid = (delta: number): string =>
  delta >= 9 ? `${Math.round(1 + delta)}×` : `${Math.abs(Math.round(delta * 100))}%`;

/** A change in a share, unsigned, in percentage points: "4 pts". */
export const pointsSaid = (delta: number): string => `${Math.abs(Math.round(delta * 100))} pts`;

/** A group (a person, an agent, a model), with its sums and its share of the period's. */
export type Group = Sum & { key: string; share: number };

/** Totals grouped by `field`, largest first by `measure`, each with its share; nameless last. */
export function groupsOf(totals: Total[], field: string, measure: Measure): Group[] {
  const rows = totals.map((t) => ({ key: String(t.key[field] ?? ""), ...add(zero(), t) }));
  const sum = rows.reduce((n, r) => n + r[measure], 0);
  return rows
    .map((r) => ({ ...r, share: sum > 0 ? r[measure] / sum : 0 }))
    .sort((a, b) => Number(!a.key) - Number(!b.key) || b[measure] - a[measure]);
}

/**
 * The input's parts, in tokens and as shares of it: read from a cache,
 * written to one, and neither (charged in full).
 */
export function inputParts(s: Pick<Sum, "input" | "cached" | "cacheWrite">): {
  cached: number;
  written: number;
  fresh: number;
  shares: { cached: number; written: number; fresh: number };
} {
  const cached = Math.max(0, s.cached);
  const written = Math.max(0, s.cacheWrite);
  const fresh = Math.max(0, s.input - cached - written);
  const whole = cached + written + fresh;
  const share = (n: number) => whole > 0 ? n / whole : 0;
  return {
    cached,
    written,
    fresh,
    shares: { cached: share(cached), written: share(written), fresh: share(fresh) },
  };
}

/** Models that took input, most input first: how caching went for each. */
export const cacheByModel = (models: Total[]): Group[] =>
  groupsOf(models, "subject", "tokens")
    .filter((g) => g.input > 0)
    .sort((a, b) => b.input - a.input);

/** A round top for a chart's scale: 1, 2 or 5 times a power of ten, at or over `n`. */
export function niceMax(n: number): number {
  if (n <= 0) return 1;
  const power = 10 ** Math.floor(Math.log10(n));
  const step = [1, 2, 2.5, 5, 10].find((s) => s * power >= n)!;
  return step * power;
}

/** A measure's value, as the page says it. */
export const said = (n: number, m: Measure): string => m === "spend" ? usd(n) : compact(n);
