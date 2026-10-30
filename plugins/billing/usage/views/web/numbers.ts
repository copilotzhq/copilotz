/**
 * Usage as the web says it: money, tokens and counts in few characters, a
 * model by its name with its provider apart, a period's days (each with its
 * totals, empty days included), a period against the one before it, and
 * groups (by person, agent, model) largest first, with their share.
 */
import type { Totals } from "../../shared/totals.ts";

/** What a chart measures. */
export type Measure = "cost" | "tokens" | "calls";

/** US dollars: cents when there are some, fewer digits as it grows, "<$0.01" for crumbs. */
export function usd(n: number): string {
  if (!n) return "$0";
  if (n < 0.01) return "<$0.01";
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

/** The tokens a total counts: what went in and what came out. */
export const tokensOf = (t: Pick<Totals, "quantities">): number =>
  (t.quantities.input ?? 0) + (t.quantities.output ?? 0);

/** A measure of a total. */
export const measureOf = (t: Pick<Totals, "quantities" | "cost" | "uses">, m: Measure): number =>
  m === "cost" ? t.cost : m === "tokens" ? tokensOf(t) : t.uses;

/** A measure's value, as the page says it. */
export const said = (n: number, m: Measure): string => m === "cost" ? usd(n) : compact(n);

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

/** A day's totals, for the chart. */
export type Day = { day: string; cost: number; tokens: number; calls: number; unpriced: number };

/** Each day of the period, oldest first, with its totals (none: zeros). */
export function daysOf(totals: Totals[], days: number, now = Date.now()): Day[] {
  const byDay = new Map(totals.map((t) => [String(t.key.day), t]));
  const today = Date.parse(`${dayOf(now)}T00:00:00Z`);
  return Array.from({ length: days }, (_, i) => {
    const day = dayOf(today - (days - 1 - i) * DAY);
    const t = byDay.get(day);
    return {
      day,
      cost: t?.cost ?? 0,
      tokens: t ? tokensOf(t) : 0,
      calls: t?.uses ?? 0,
      unpriced: t?.unpriced ?? 0,
    };
  });
}

/** A period's sums. */
export type Sum = { cost: number; tokens: number; calls: number; unpriced: number };

/** The days' sums, split into the period and the one before it (by `since`). */
export function sums(totals: Totals[], since: string): { now: Sum; before: Sum } {
  const zero = (): Sum => ({ cost: 0, tokens: 0, calls: 0, unpriced: 0 });
  const now = zero();
  const before = zero();
  const first = since.slice(0, 10);
  for (const t of totals) {
    const into = String(t.key.day) >= first ? now : before;
    into.cost += t.cost;
    into.tokens += tokensOf(t);
    into.calls += t.uses;
    into.unpriced += t.unpriced;
  }
  return { now, before };
}

/** How much a period changed from the one before: a fraction, or none when there was nothing. */
export const change = (now: number, before: number): number | undefined =>
  before > 0 ? (now - before) / before : undefined;

/** A group (a person, an agent, a model), with its measures and its share of the period's. */
export type Group = {
  key: string;
  cost: number;
  tokens: number;
  calls: number;
  unpriced: number;
  share: number;
};

/** Totals grouped by `field`, largest first by `measure`, each with its share; nameless last. */
export function groupsOf(totals: Totals[], field: string, measure: Measure): Group[] {
  const rows = totals.map((t) => ({
    key: String(t.key[field] ?? ""),
    cost: t.cost,
    tokens: tokensOf(t),
    calls: t.uses,
    unpriced: t.unpriced,
  }));
  const sum = rows.reduce((n, r) => n + r[measure], 0);
  return rows
    .map((r) => ({ ...r, share: sum > 0 ? r[measure] / sum : 0 }))
    .sort((a, b) => Number(!a.key) - Number(!b.key) || b[measure] - a[measure]);
}

/** A round top for a chart's scale: 1, 2 or 5 times a power of ten, at or over `n`. */
export function niceMax(n: number): number {
  if (n <= 0) return 1;
  const power = 10 ** Math.floor(Math.log10(n));
  const step = [1, 2, 2.5, 5, 10].find((s) => s * power >= n)!;
  return step * power;
}
