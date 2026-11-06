/**
 * Usage as the web says it: money, tokens, counts and shares in few
 * characters; a model by its name with its provider apart; a month and its
 * days (empty ones included), and the same point of the month before; what
 * it's grouped by (kind, space, person, agent, model), each a row with its
 * sums, its share, and the filter that keeps to it; the day's columns
 * stacked by those rows; how long what's left lasts at this pace; and how
 * long a computer was awake.
 *
 * Everything is in what people are charged (the price, "spend"). What it
 * cost, and so the margin, is there only for platform staff: the totals
 * they get carry `cost`, and others' don't.
 */
import type { Quantities } from "../../shared/rate.ts";
import type { PriceTotals } from "../../shared/totals.ts";
import { formatDate, formatNumber } from "../../../../../hosts/web/mod.ts";
import { say } from "./words.ts";

/** A total as the page gets it: its price; for platform staff, its cost too. */
export type Total = PriceTotals & {
  cost?: number;
  costs?: Quantities;
  saved: { price: number; cost?: number };
};

const MINUS = "−";

/**
 * US dollars: cents when there are some, fewer digits as it grows, "<$0.01"
 * for crumbs; `fine` keeps two digits of a crumb ("$0.0042"), for a single
 * call. Below zero, a minus sign.
 */
export function usd(n: number, fine = false): string {
  if (n < 0) return `${MINUS}${usd(-n, fine)}`;
  if (!n) return dollars(0, 0, 0);
  if (n < 0.01) {
    if (!fine) return `<${dollars(0.01, 2, 2)}`;
    return n < 0.0001 ? `<${dollars(0.0001, 0, 4)}` : dollars(Number(n.toPrecision(2)), 0, 6);
  }
  if (n < 100) return dollars(n, 2, 2);
  if (n < 10_000) return dollars(Math.round(n), 0, 0);
  return dollars(n, 0, fewDigits(n), true);
}

/** US dollars in the page's language, with this many digits after the point (at least, at most). */
const dollars = (n: number, min: number, max: number, short = false): string =>
  formatNumber(n, {
    style: "currency",
    currency: "USD",
    currencyDisplay: "narrowSymbol",
    minimumFractionDigits: min,
    maximumFractionDigits: max,
    ...(short ? { notation: "compact" as const } : {}),
  });

/** The digits after the point a compact number keeps: one, none once it's past a hundred. */
const fewDigits = (n: number): number => {
  const abs = Math.abs(n);
  return abs / (abs >= 1e9 ? 1e9 : abs >= 1e6 ? 1e6 : 1e3) >= 100 ? 0 : 1;
};

/** A count in few characters: 940, 12.9K, 4.2M. */
export function compact(n: number): string {
  if (Math.abs(n) < 1e3) return formatNumber(Math.round(n));
  return formatNumber(n, { notation: "compact", maximumFractionDigits: fewDigits(n) });
}

/**
 * A share as a whole percentage: "<1%" for a sliver, ">99%" for nearly all
 * (so neither reads as none or all), a minus sign below zero, "—" for none.
 */
export function percent(fraction: number | undefined): string {
  if (fraction === undefined || !Number.isFinite(fraction)) return "—";
  if (fraction < 0) return `${MINUS}${percent(-fraction)}`;
  if (fraction === 0) return formatNumber(0, { style: "percent" });
  if (fraction < 0.01) return `<${formatNumber(0.01, { style: "percent" })}`;
  if (fraction > 0.99 && fraction < 1) return `>${formatNumber(0.99, { style: "percent" })}`;
  return formatNumber(fraction, { style: "percent", maximumFractionDigits: 0 });
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
  if (!n) return say("savedNothing");
  return n > 0 ? say("saved", { amount: usd(n) }) : say("savedNegative", { amount: usd(-n) });
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
 * Totals summed: spend (the price), tokens, uses and what's unpriced; the
 * input's parts (from the cache, written to it) and what caching saved;
 * and, for staff, the cost (none for anyone else).
 */
export type Sum = {
  spend: number;
  tokens: number;
  uses: number;
  unpriced: number;
  input: number;
  output: number;
  /** Input tokens read from a cache, and written to one. */
  cached: number;
  cacheWrite: number;
  /** What caching saved, at the price (below zero: it was charged more). */
  saved: number;
  /** Only for staff. */
  cost?: number;
  savedCost?: number;
};

export const zero = (): Sum => ({
  spend: 0,
  tokens: 0,
  uses: 0,
  unpriced: 0,
  input: 0,
  output: 0,
  cached: 0,
  cacheWrite: 0,
  saved: 0,
});

/** Adds a total into a sum (which it changes, and gives back). */
export function add(into: Sum, t: Total): Sum {
  const q = t.quantities;
  into.spend += t.price;
  into.tokens += tokensOf(t);
  into.uses += t.uses;
  into.unpriced += t.unpriced;
  into.input += q.input ?? 0;
  into.output += q.output ?? 0;
  into.cached += q.cached ?? 0;
  into.cacheWrite += q.cacheWrite ?? 0;
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

/** A month (`2026-11`): its first day and the next month's (`end`), as the ledger's days are UTC. */
export function monthOf(month: string): { start: string; end: string } {
  const [y, m] = month.split("-").map(Number);
  return {
    start: `${month}-01`,
    end: new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 7) + "-01",
  };
}

/** The month a time is in: `2026-11`. */
export const monthAt = (at: string | number): string => new Date(at).toISOString().slice(0, 7);

/** The month before: `2026-10` for `2026-11`. */
export function monthBefore(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 7);
}

/** A month in words: "November 2026"; "November" with `short`. */
export const monthSaid = (month: string, short = false): string =>
  formatDate(new Date(`${month}-15T12:00:00Z`), {
    month: "long",
    ...(short ? {} : { year: "numeric" }),
    timeZone: "UTC",
  });

/**
 * The same point of the month before: as far into it as `now` is into its
 * own month, and no further than its end. For comparing a month so far.
 */
export function samePointBefore(month: string, now: number): string {
  const { start } = monthOf(month);
  const before = monthOf(monthBefore(month));
  const into = now - Date.parse(`${start}T00:00:00Z`);
  const at = Math.min(
    Date.parse(`${before.start}T00:00:00Z`) + into,
    Date.parse(`${before.end}T00:00:00Z`),
  );
  return new Date(at).toISOString();
}

/** How far into a month `now` is, in days (fractional), and how many it has. */
export function monthProgress(month: string, now: number): { elapsed: number; days: number } {
  const { start, end } = monthOf(month);
  const from = Date.parse(`${start}T00:00:00Z`);
  const to = Date.parse(`${end}T00:00:00Z`);
  return {
    elapsed: Math.min(Math.max(0, (now - from) / DAY), (to - from) / DAY),
    days: (to - from) / DAY,
  };
}

/** Each day of a month, oldest first. */
export function daysIn(month: string): string[] {
  const { start, end } = monthOf(month);
  const out: string[] = [];
  for (let at = Date.parse(`${start}T00:00:00Z`); dayOf(at) < end; at += DAY) out.push(dayOf(at));
  return out;
}

/** How much a period changed from the one before: a fraction, or none when there was nothing. */
export const change = (now: number, before: number): number | undefined =>
  before > 0 ? (now - before) / before : undefined;

/** A change, unsigned (an arrow says which way): a percentage, or how many times over once it's ten. */
export const changeSaid = (delta: number): string =>
  delta >= 9
    ? `${formatNumber(Math.round(1 + delta))}×`
    : formatNumber(Math.abs(Math.round(delta * 100)) / 100, {
      style: "percent",
      maximumFractionDigits: 0,
    });

/** A round top for a chart's scale: 1, 2 or 5 times a power of ten, at or over `n`. */
export function niceMax(n: number): number {
  if (n <= 0) return 1;
  const power = 10 ** Math.floor(Math.log10(n));
  const step = [1, 2, 2.5, 5, 10].find((s) => s * power >= n)!;
  return step * power;
}

/** What the page groups by: one switch for the chart and the list. */
export type Dimension = "kind" | "space" | "person" | "agent" | "model";

/** Each dimension, and the fields totals are grouped by for it. */
export const DIMENSIONS: Record<Dimension, { by: string[] }> = {
  kind: { by: ["category"] },
  space: { by: ["tags.space"] },
  person: { by: ["tags.person"] },
  // An agent's, else (a model's without one) what it was for, else the kind.
  agent: { by: ["tags.agent", "category", "tags.purpose"] },
  // A model's, for agents; computers' and apps' as their kind.
  model: { by: ["subject", "category"] },
};

/** A dimension by name ("Kind"), and as it reads in a sentence ("by kind"). */
export const dimensionName = (d: Dimension): string => say(d);
export const dimensionIn = (d: Dimension): string =>
  say(
    ({
      kind: "byKind",
      space: "bySpace",
      person: "byPerson",
      agent: "byAgent",
      model: "byModel",
    } as const)[d],
  );

/** What a conversation pays for without an agent: its summaries, memory notes, voice transcribed. */
export const UPKEEP = ["history", "memory", "transcription"];

/** A model use's purpose, in words. */
export const purposeSaid = (purpose: string): string => {
  const known = {
    history: "purposeHistory",
    memory: "purposeMemory",
    transcription: "purposeTranscription",
    "agent.draft": "purposeDraft",
  } as const;
  return purpose in known
    ? say(known[purpose as keyof typeof known])
    : agentName(purpose.replace(/\./g, " "));
};

const NONE = { $exists: false };

/**
 * A total's row in a dimension: its key, and the filter keeping to it.
 * Agents' kind is `agents`; a key without a value is "" (not recorded).
 */
export function rowOf(dimension: Dimension, key: Record<string, unknown>): {
  key: string;
  filter: Record<string, unknown>;
} {
  const category = String(key.category ?? "");
  switch (dimension) {
    case "kind":
      return { key: category, filter: { category } };
    case "space":
    case "person": {
      const field = DIMENSIONS[dimension].by[0];
      const value = typeof key[field] === "string" ? key[field] as string : "";
      return { key: value, filter: { [field]: value || NONE } };
    }
    case "agent": {
      const agent = key["tags.agent"];
      if (typeof agent === "string" && agent) {
        return { key: `agent:${agent}`, filter: { "tags.agent": agent } };
      }
      if (category !== "agents") return { key: `category:${category}`, filter: { category } };
      const purpose = typeof key["tags.purpose"] === "string" ? key["tags.purpose"] as string : "";
      const base = { "tags.agent": NONE, category: "agents" };
      return UPKEEP.includes(purpose)
        ? { key: "upkeep", filter: { ...base, "tags.purpose": { $in: UPKEEP } } }
        : purpose
        ? { key: `purpose:${purpose}`, filter: { ...base, "tags.purpose": purpose } }
        : { key: "model", filter: { ...base, "tags.purpose": NONE } };
    }
    case "model":
      return category === "agents" && typeof key.subject === "string"
        ? { key: `subject:${key.subject}`, filter: { subject: key.subject } }
        : { key: `category:${category}`, filter: { category } };
  }
}

/** A row: what it stands for, its sums and its share of the whole. */
export type Row = Sum & { key: string; share: number; filter: Record<string, unknown> };

/** Totals as a dimension's rows, the largest first, the unnamed ("") last. */
export function rowsOf(totals: Total[], dimension: Dimension): Row[] {
  const rows = new Map<string, Row>();
  for (const t of totals) {
    const { key, filter } = rowOf(dimension, t.key);
    const row = rows.get(key) ?? { key, filter, share: 0, ...zero() };
    add(row, t);
    rows.set(key, row);
  }
  const all = [...rows.values()];
  const whole = all.reduce((n, r) => n + r.spend, 0);
  return all
    .map((r) => ({ ...r, share: whole > 0 ? r.spend / whole : 0 }))
    .sort((a, b) =>
      Number(!a.key) - Number(!b.key) || b.spend - a.spend || a.key.localeCompare(b.key)
    );
}

/** The series a chart stacks: the largest rows, then the rest as one ("other"). */
export const SERIES = 5;

/** A day's column: what each series spent, in the series' order, and in all. */
export type Column = { day: string; values: number[]; spend: number };

/**
 * Each day of a month, its spend by series: the rows' keys (`series`, at
 * most `SERIES`; past that, the rest as one, last).
 */
export function columnsOf(
  totals: Total[],
  dimension: Dimension,
  days: string[],
  series: string[],
): Column[] {
  const at = new Map(series.map((key, i) => [key, i]));
  const other = series.length;
  const byDay = new Map(days.map((day) => [day, new Array(other + 1).fill(0) as number[]]));
  for (const t of totals) {
    const values = byDay.get(String(t.key.day));
    if (!values) continue;
    values[at.get(rowOf(dimension, t.key).key) ?? other] += t.price;
  }
  return days.map((day) => {
    const values = byDay.get(day)!;
    return { day, values, spend: values.reduce((a, b) => a + b, 0) };
  });
}

/**
 * How long what's left lasts at this pace, in words: "about 6 days",
 * "about 3 weeks"; none without a pace.
 */
export function lastsSaid(left: number, perDay: number): string | undefined {
  if (!(perDay > 0) || left <= 0) return undefined;
  const days = left / perDay;
  if (days < 1) return say("lastsLessThanDay");
  if (days < 1.5) return say("lastsDay");
  if (days < 14) return say("lastsDays", { count: Math.round(days) });
  if (days < 60) return say("lastsWeeks", { count: Math.round(days / 7) });
  if (days < 365) return say("lastsMonths", { count: Math.round(days / 30) });
  return say("lastsYear");
}

/** How long, from seconds: "45 s", "14 min", "2h 10m". */
export function durationSaid(seconds: number): string {
  if (seconds < 60) return say("seconds", { count: Math.max(0, Math.round(seconds)) });
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return say("minutes", { count: minutes });
  const hours = Math.floor(minutes / 60);
  return minutes % 60
    ? say("hoursMinutes", { hours, minutes: minutes % 60 })
    : say("hours", { hours });
}
