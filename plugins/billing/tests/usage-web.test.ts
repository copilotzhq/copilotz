/**
 * Usage on the web, its numbers: money, tokens, counts and shares in few
 * characters, a model's name apart from its provider, a month and its days,
 * the same point of the month before, rows by kind, space, person, agent
 * and model (with the filter that keeps to each, and conversations' upkeep
 * never "no agent"), a month's columns stacked by them, how long what's
 * left lasts at this pace, how long a computer was awake, the margin staff
 * see, and a chart's round top. Everything people see is a price (spend);
 * a cost is there only in staff's totals.
 */
import { assertEquals } from "@std/assert";
import {
  agentName,
  change,
  changeSaid,
  columnsOf,
  compact,
  daysIn,
  durationSaid,
  hitRate,
  lastsSaid,
  marginOf,
  modelOf,
  monthAt,
  monthBefore,
  monthOf,
  monthProgress,
  monthSaid,
  niceMax,
  percent,
  purposeSaid,
  rowOf,
  rowsOf,
  samePointBefore,
  savedSaid,
  sumOf,
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
  assertEquals([change(150, 100), change(5, 0)], [0.5, undefined]);
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

test("sums: spend, tokens, cache, uses; a cost only in staff's totals", () => {
  const people = sumOf([
    total({}, 2, 1000, 3, { cached: 600, cacheWrite: 100, saved: 0.5 }),
    total({}, 1, 500, 1, { saved: -0.1 }),
  ]);
  assertEquals([people.spend, people.uses, people.saved], [3, 4, 0.4]);
  assertEquals([people.input, people.output, people.tokens], [1500, 150, 1650]);
  assertEquals([people.cached, people.cacheWrite], [600, 100]);
  assertEquals([people.cost, people.savedCost], [undefined, undefined]);
  const staff = sumOf([
    costed(total({}, 2, 1000, 3), 1.6, 0.3),
    costed(total({}, 1, 500, 1), 0.8, 0.1),
  ]);
  assertEquals([staff.spend, Math.round(staff.cost! * 100) / 100, staff.savedCost], [3, 2.4, 0.4]);
  assertEquals(percent(marginOf(staff.spend, staff.cost)), "20%");
});

test("a month: its days, the month before, and the same point of it", () => {
  assertEquals(monthOf("2026-11"), { start: "2026-11-01", end: "2026-12-01" });
  assertEquals(monthOf("2026-12"), { start: "2026-12-01", end: "2027-01-01" });
  assertEquals([monthBefore("2026-11"), monthBefore("2026-01")], ["2026-10", "2025-12"]);
  assertEquals(monthAt("2026-11-03T15:00:00Z"), "2026-11");
  assertEquals([monthSaid("2026-11"), monthSaid("2026-11", true)], ["November 2026", "November"]);
  assertEquals(daysIn("2026-11").length, 30);
  assertEquals(daysIn("2026-02").at(-1), "2026-02-28");
  // As far into October as Nov 3, 15:00 is into November.
  const now = Date.parse("2026-11-03T15:00:00Z");
  assertEquals(samePointBefore("2026-11", now), "2026-10-03T15:00:00.000Z");
  // Never past the month before's end: March 31 against February.
  assertEquals(
    samePointBefore("2026-03", Date.parse("2026-03-31T12:00:00Z")),
    "2026-03-01T00:00:00.000Z",
  );
  const into = monthProgress("2026-11", now);
  assertEquals([Math.round(into.elapsed * 100) / 100, into.days], [2.63, 30]);
});

test("rows by kind, space, person, agent and model, each with the filter that keeps to it", () => {
  const llm = (key: Record<string, unknown>, price: number) =>
    total({ category: "agents", ...key }, price, 100, 1);
  // Kinds; a meter of an app's own is its own kind.
  assertEquals(rowOf("kind", { category: "computers" }), {
    key: "computers",
    filter: { category: "computers" },
  });
  // Without a space: not recorded, kept to by its absence.
  assertEquals(rowOf("space", {}), { key: "", filter: { "tags.space": { $exists: false } } });
  // A conversation's upkeep is one row, never "no agent"; computers and apps are their kind.
  const agents = rowsOf([
    llm({ "tags.agent": "north" }, 3),
    llm({ "tags.purpose": "history" }, 0.5),
    llm({ "tags.purpose": "memory" }, 0.25),
    llm({ "tags.purpose": "agent.draft" }, 0.1),
    total({ category: "computers" }, 2, 0, 60),
  ], "agent");
  assertEquals(agents.map((r) => r.key), [
    "agent:north",
    "category:computers",
    "upkeep",
    "purpose:agent.draft",
  ]);
  assertEquals(agents[2].spend, 0.75);
  assertEquals(agents[2].filter, {
    "tags.agent": { $exists: false },
    category: "agents",
    "tags.purpose": { $in: ["history", "memory", "transcription"] },
  });
  // Models are agents' only: a computer's size is never a model.
  const models = rowsOf([
    llm({ subject: "anthropic/claude-opus-5-5" }, 4),
    total({ category: "computers", subject: "cloud/small" }, 1, 0, 60),
  ], "model");
  assertEquals(models.map((r) => [r.key, r.filter]), [
    ["subject:anthropic/claude-opus-5-5", { subject: "anthropic/claude-opus-5-5" }],
    ["category:computers", { category: "computers" }],
  ]);
  assertEquals(models.map((r) => Math.round(r.share * 100)), [80, 20]);
  // Nameless last, whatever it spent.
  assertEquals(
    rowsOf(
      [total({ "tags.person": "" }, 9, 1, 1), total({ "tags.person": "ana" }, 1, 1, 1)],
      "person",
    )
      .map((r) => r.key),
    ["ana", ""],
  );
});

test("a month's columns, stacked by its series; the rest as one", () => {
  const days = daysIn("2026-11").slice(0, 3);
  const columns = columnsOf(
    [
      total({ day: "2026-11-01", category: "agents" }, 2, 1, 1),
      total({ day: "2026-11-01", category: "computers" }, 1, 1, 1),
      total({ day: "2026-11-02", category: "tool" }, 0.5, 1, 1),
    ],
    "kind",
    days,
    ["agents", "computers"],
  );
  assertEquals(columns.map((c) => [c.day, c.values, c.spend]), [
    ["2026-11-01", [2, 1, 0], 3],
    ["2026-11-02", [0, 0, 0.5], 0.5],
    ["2026-11-03", [0, 0, 0], 0],
  ]);
});

test("how long what's left lasts at this pace; how long a computer was awake", () => {
  assertEquals(
    [lastsSaid(7.9, 1.3), lastsSaid(0.5, 1), lastsSaid(30, 1), lastsSaid(100, 1), lastsSaid(5, 0)],
    ["about 6 days", "less than a day", "about 4 weeks", "about 3 months", undefined],
  );
  assertEquals(lastsSaid(-1, 1), undefined);
  assertEquals(
    [durationSaid(45), durationSaid(14 * 60), durationSaid(130 * 60), durationSaid(120 * 60)],
    ["45 s", "14 min", "2h 10m", "2h"],
  );
  assertEquals([purposeSaid("history"), purposeSaid("agent.draft"), purposeSaid("x.y")], [
    "Summaries",
    "Drafting agents",
    "X y",
  ]);
});
