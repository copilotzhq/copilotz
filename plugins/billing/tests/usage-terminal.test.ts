/**
 * `/usage` in the terminal: each model's uses and what they were charged
 * (the price, never the cost), the sum, and how much input came from a
 * cache and what caching saved.
 */
import { assert, assertEquals } from "@std/assert";
import { cacheLine, totalsView, usd } from "../usage/views/terminal/totals.ts";
import type { PriceTotals } from "../usage/shared/totals.ts";
import { test } from "../../../testing/mod.ts";

// deno-lint-ignore no-control-regex
const plain = (s: string) => s.replace(/\x1b\[\d+m/g, "");

const row = (
  subject: string,
  price: number,
  quantities: Record<string, number>,
  more: Partial<PriceTotals> = {},
): PriceTotals => ({
  key: { meter: "llm", subject },
  quantities,
  price,
  prices: {},
  saved: { price: 0 },
  uses: 2,
  unpriced: 0,
  ...more,
});

test("each model at its price, the sum, and the cache's hit rate and savings", () => {
  const out = plain(totalsView({
    totals: [
      row("anthropic/big", 0.25, { input: 4000, cached: 3000, cacheWrite: 500, output: 200 }, {
        saved: { price: 0.05 },
      }),
      row("openai/small", 0.0042, { input: 1000, output: 100 }),
    ],
    scope: "everything",
  }));
  assertEquals(out.split("\n"), [
    "anthropic/big llm · 2 uses · input 4,000 · cached 3,000 · cacheWrite 500 · output 200 · $0.2500",
    "openai/small llm · 2 uses · input 1,000 · output 100 · $0.0042",
    "total $0.2542 · cache 60% of input · saved $0.0500 (everything)",
  ]);
});

test("what nothing priced says so; no cache, no cache line", () => {
  const out = plain(totalsView({
    totals: [
      row("acme/unknown", 0, { input: 100, output: 10 }, { unpriced: 2 }),
      row("openai/small", 0.5, { input: 100, output: 10 }, { unpriced: 1 }),
    ],
  }));
  const lines = out.split("\n");
  assert(lines[0].endsWith("· unpriced"), lines[0]);
  assert(lines[1].endsWith("· $0.5000 (1 unpriced)"), lines[1]);
  assertEquals(lines[2], "total $0.5000");
  assertEquals(plain(totalsView({ totals: [] })), "Nothing used yet.");
});

test("the cache line: none without input or caching; charged more, said so", () => {
  assertEquals(cacheLine([]), undefined);
  assertEquals(cacheLine([row("a", 1, { input: 100 })]), undefined);
  assertEquals(cacheLine([row("a", 1, { seconds: 30 })]), undefined);
  assertEquals(
    cacheLine([row("a", 1, { input: 1000, cacheWrite: 900 }, { saved: { price: -0.02 } })]),
    "cache 0% of input · $0.0200 more than without it",
  );
  assertEquals(
    cacheLine([row("a", 1, { input: 10_000, cached: 40 }, { saved: { price: 0.001 } })]),
    "cache <1% of input · saved $0.0010",
  );
  assertEquals([usd(0), usd(0.0042), usd(1.5), usd(-0.02)], [
    "$0.0000",
    "$0.0042",
    "$1.5000",
    "-$0.0200",
  ]);
});
