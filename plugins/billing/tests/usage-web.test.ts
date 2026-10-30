/**
 * Usage on the web, its numbers: money, tokens, counts and shares in few
 * characters, a model's name apart from its provider, a period's days
 * (empty ones included) and the period before it, groups largest first
 * with their share, caching (hit rate, the input's parts, what it saved),
 * the margin staff see, and a chart's round top. Everything people see is
 * a price (spend); a cost is there only in staff's totals.
 */
import { assertEquals } from "@std/assert";
import {
  agentName,
  cacheByModel,
  change,
  changeSaid,
  compact,
  daysOf,
  groupsOf,
  hitRate,
  inputParts,
  marginOf,
  modelOf,
  niceMax,
  percent,
  periodOf,
  pointsSaid,
  savedSaid,
  sumOf,
  sums,
  type Total,
  usd,
} from "../usage/views/web/numbers.ts";
import { test } from "../../../testing/mod.ts";

/** A total as people get it: at its price, no cost. */
const total = (
  key: Record<string, unknown>,
  price: number,
  input: number,
  uses: number,
  cache: { cached?: number; cacheWrite?: number; saved?: number } = {},
): Total => ({
  key,
  quantities: {
    input,
    output: input / 10,
    ...(cache.cached ? { cached: cache.cached } : {}),
    ...(cache.cacheWrite ? { cacheWrite: cache.cacheWrite } : {}),
  },
  price,
  prices: {
    input: price * 0.5,
    output: price * 0.3,
    ...(cache.cached ? { cached: price * 0.05 } : {}),
    ...(cache.cacheWrite ? { cacheWrite: price * 0.15 } : {}),
  },
  saved: { price: cache.saved ?? 0 },
  uses,
  unpriced: 0,
});

/** The same, as staff get it: its cost too. */
const costed = (t: Total, cost: number, savedCost = 0): Total => ({
  ...t,
  cost,
  costs: { input: cost },
  saved: { ...t.saved, cost: savedCost },
});

/** "−", the minus sign the page uses. */
const MINUS = "−";

test("money, tokens and counts in few characters", () => {
  assertEquals([usd(0), usd(0.004), usd(0.5), usd(12.345), usd(1234.5), usd(12_345)], [
    "$0",
    "<$0.01",
    "$0.50",
    "$12.35",
    "$1,235",
    "$12.3K",
  ]);
  assertEquals(usd(-0.5), `${MINUS}$0.50`);
  assertEquals(usd(-0.004), `${MINUS}<$0.01`);
  // A single call's crumbs keep two digits.
  assertEquals([usd(0.0042, true), usd(0.00009, true), usd(0.12, true), usd(0, true)], [
    "$0.0042",
    "<$0.0001",
    "$0.12",
    "$0",
  ]);
  assertEquals([compact(940), compact(12_900), compact(4_200_000), compact(123_456)], [
    "940",
    "12.9K",
    "4.2M",
    "123K",
  ]);
  assertEquals(modelOf("openai/gpt-6.1-sol"), { provider: "openai", name: "gpt-6.1-sol" });
  assertEquals(modelOf("local"), { name: "local" });
  assertEquals(agentName("research_lead"), "Research lead");
});

test("shares as percentages: slivers and nearly-all never read as none or all", () => {
  assertEquals(
    [percent(0), percent(0.004), percent(0.42), percent(0.996), percent(1), percent(-0.25)],
    ["0%", "<1%", "42%", ">99%", "100%", `${MINUS}25%`],
  );
  assertEquals([percent(undefined), percent(Number.NaN), percent(Infinity)], ["—", "—", "—"]);
  assertEquals([changeSaid(0.5), changeSaid(-0.25), changeSaid(11)], ["50%", "25%", "12×"]);
  assertEquals([pointsSaid(0.04), pointsSaid(-0.123)], ["4 pts", "12 pts"]);
});

test("cache hit rate: cache reads over input, none without input", () => {
  assertEquals(hitRate(600, 1000), 0.6);
  assertEquals(hitRate(0, 1000), 0);
  assertEquals(hitRate(0, 0), undefined);
  assertEquals(hitRate(5, 0), undefined);
  // Never over all of it, nor under none.
  assertEquals(hitRate(1200, 1000), 1);
  assertEquals(hitRate(-3, 1000), 0);
});

test("gross margin: the share of the price that isn't cost; none without both", () => {
  assertEquals(marginOf(1.25, 1), 0.2);
  assertEquals(marginOf(1, 1), 0);
  assertEquals(marginOf(1, 1.5), -0.5);
  assertEquals(marginOf(1, undefined), undefined);
  assertEquals(marginOf(0, 1), undefined);
  assertEquals(marginOf(0, 0), undefined);
  assertEquals(percent(marginOf(1.25, 1)), "20%");
  assertEquals(percent(marginOf(1, 1.5)), `${MINUS}50%`);
});

test("what caching saved, in words: saved, nothing, or charged more", () => {
  assertEquals(savedSaid(1.234), "$1.23 saved");
  assertEquals(savedSaid(0.004), "<$0.01 saved");
  assertEquals(savedSaid(0), "Nothing saved yet");
  assertEquals(savedSaid(undefined), "Nothing saved yet");
  assertEquals(savedSaid(-0.04), "$0.04 more than without it");
});

test("the input's parts: from a cache, written to one, neither", () => {
  const parts = inputParts({ input: 1000, cached: 600, cacheWrite: 100 });
  assertEquals([parts.cached, parts.written, parts.fresh], [600, 100, 300]);
  assertEquals(parts.shares, { cached: 0.6, written: 0.1, fresh: 0.3 });
  // Nothing in: no shares, not a division by zero.
  assertEquals(inputParts({ input: 0, cached: 0, cacheWrite: 0 }).shares, {
    cached: 0,
    written: 0,
    fresh: 0,
  });
  // Counts that disagree never make a part below zero.
  assertEquals(inputParts({ input: 100, cached: 90, cacheWrite: 20 }).fresh, 0);
});

test("sums: spend, tokens, cache and its spend; a cost only in staff's totals", () => {
  const people = sumOf([
    total({}, 2, 1000, 3, { cached: 600, cacheWrite: 100, saved: 0.5 }),
    total({}, 1, 500, 1, { saved: -0.1 }),
  ]);
  assertEquals(people.spend, 3);
  assertEquals([people.input, people.output, people.tokens], [1500, 150, 1650]);
  assertEquals([people.cached, people.cacheWrite], [600, 100]);
  assertEquals([people.cachedSpend, people.cacheWriteSpend], [0.1, 0.3]);
  assertEquals(people.inputSpend, 1.5);
  assertEquals(people.saved, 0.4);
  assertEquals(people.calls, 4);
  assertEquals(people.cost, undefined);
  assertEquals(people.savedCost, undefined);
  const staff = sumOf([
    costed(total({}, 2, 1000, 3), 1.6, 0.3),
    costed(total({}, 1, 500, 1), 0.8, 0.1),
  ]);
  assertEquals([staff.spend, Math.round(staff.cost! * 100) / 100], [3, 2.4]);
  assertEquals(staff.savedCost, 0.4);
  assertEquals(percent(marginOf(staff.spend, staff.cost)), "20%");
});

test("a period's days, oldest first, empty ones as zeros; and the period before it", () => {
  const now = Date.parse("2026-10-29T15:00:00Z");
  assertEquals(periodOf(7, now), {
    since: "2026-10-23T00:00:00.000Z",
    before: "2026-10-16T00:00:00.000Z",
  });
  const days = daysOf([total({ day: "2026-10-28" }, 1.5, 1000, 3, { cached: 400 })], 3, now);
  assertEquals(days.map((d) => d.day), ["2026-10-27", "2026-10-28", "2026-10-29"]);
  assertEquals(
    [days[1].spend, days[1].tokens, days[1].cached, days[1].calls, days[1].unpriced],
    [1.5, 1100, 400, 3, 0],
  );
  assertEquals([days[0].calls, days[0].spend, days[0].cached], [0, 0, 0]);
  const split = sums([
    total({ day: "2026-10-20" }, 1, 100, 1),
    total({ day: "2026-10-23" }, 2, 200, 2),
    total({ day: "2026-10-29" }, 3, 300, 3),
  ], "2026-10-23T00:00:00.000Z");
  assertEquals([split.now.spend, split.now.tokens, split.now.calls], [5, 550, 5]);
  assertEquals([split.before.spend, split.before.tokens, split.before.calls], [1, 110, 1]);
  assertEquals([change(150, 100), change(5, 0)], [0.5, undefined]);
});

test("groups largest first by what's measured, with their share; nameless last", () => {
  const groups = groupsOf(
    [
      total({ "tags.agent": "" }, 9, 10, 1),
      total({ "tags.agent": "assistant" }, 1, 3000, 2),
      total({ "tags.agent": "researcher" }, 4, 1000, 1),
    ],
    "tags.agent",
    "spend",
  );
  assertEquals(groups.map((g) => g.key), ["researcher", "assistant", ""]);
  assertEquals(groups.map((g) => Math.round(g.share * 100)), [29, 7, 64]);
  assertEquals(groupsOf([total({ subject: "a" }, 0, 0, 0)], "subject", "tokens")[0].share, 0);
});

test("caching by model: those that took input, most input first", () => {
  const rows = cacheByModel([
    total({ subject: "openai/small" }, 1, 200, 1, { cached: 50 }),
    total({ subject: "anthropic/big" }, 5, 4000, 2, { cached: 3000, cacheWrite: 500 }),
    { ...total({ subject: "tool/search" }, 0.1, 0, 3), quantities: { calls: 3 } },
  ]);
  assertEquals(rows.map((r) => r.key), ["anthropic/big", "openai/small"]);
  assertEquals(rows.map((r) => hitRate(r.cached, r.input)), [0.75, 0.25]);
  assertEquals(rows[0].cacheWrite, 500);
});

test("a chart's top is a round number at or over the highest", () => {
  assertEquals(
    [niceMax(0), niceMax(0.07), niceMax(0.13), niceMax(7), niceMax(240), niceMax(1000)],
    [
      1,
      0.1,
      0.2,
      10,
      250,
      1000,
    ],
  );
});
