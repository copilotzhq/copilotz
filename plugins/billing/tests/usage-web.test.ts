/**
 * Usage on the web, its numbers: money, tokens and counts in few
 * characters, a model's name apart from its provider, a period's days (empty
 * ones included) and the period before it, groups largest first with their
 * share, and a chart's round top.
 */
import { assertEquals } from "@std/assert";
import {
  agentName,
  change,
  compact,
  daysOf,
  groupsOf,
  modelOf,
  niceMax,
  periodOf,
  sums,
  usd,
} from "../usage/views/web/numbers.ts";
import type { Totals } from "../usage/shared/totals.ts";
import { test } from "../../../testing/mod.ts";

const total = (
  key: Record<string, unknown>,
  cost: number,
  input: number,
  uses: number,
): Totals => ({
  key,
  quantities: { input, output: input / 10 },
  cost,
  price: 0,
  uses,
  unpriced: 0,
});

test("money, tokens and counts in few characters", () => {
  assertEquals([usd(0), usd(0.004), usd(0.5), usd(12.345), usd(1234.5), usd(12_345)], [
    "$0",
    "<$0.01",
    "$0.50",
    "$12.35",
    "$1,235",
    "$12.3K",
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

test("a period's days, oldest first, empty ones as zeros; and the period before it", () => {
  const now = Date.parse("2026-10-29T15:00:00Z");
  assertEquals(periodOf(7, now), {
    since: "2026-10-23T00:00:00.000Z",
    before: "2026-10-16T00:00:00.000Z",
  });
  const days = daysOf([total({ day: "2026-10-28" }, 1.5, 1000, 3)], 3, now);
  assertEquals(days.map((d) => d.day), ["2026-10-27", "2026-10-28", "2026-10-29"]);
  assertEquals(days[1], { day: "2026-10-28", cost: 1.5, tokens: 1100, calls: 3, unpriced: 0 });
  assertEquals(days[0].calls, 0);
  const split = sums([
    total({ day: "2026-10-20" }, 1, 100, 1),
    total({ day: "2026-10-23" }, 2, 200, 2),
    total({ day: "2026-10-29" }, 3, 300, 3),
  ], "2026-10-23T00:00:00.000Z");
  assertEquals(split.now, { cost: 5, tokens: 550, calls: 5, unpriced: 0 });
  assertEquals(split.before, { cost: 1, tokens: 110, calls: 1, unpriced: 0 });
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
    "cost",
  );
  assertEquals(groups.map((g) => g.key), ["researcher", "assistant", ""]);
  assertEquals(groups.map((g) => Math.round(g.share * 100)), [29, 7, 64]);
  assertEquals(groupsOf([total({ subject: "a" }, 0, 0, 0)], "subject", "tokens")[0].share, 0);
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
