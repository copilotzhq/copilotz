/** The balance, walked: what's spent first, what lapses, debt, corrections, and periods. */
import { assertEquals } from "@std/assert";
import { monthOf, periodOf, walk } from "../credits/shared/walk.ts";
import { test } from "../../../testing/mod.ts";

const grant = (_id: string, kind: string, amount: number, day: string, expires?: string) => ({
  _id,
  kind,
  amount,
  at: `${day}T12:00:00.000Z`,
  ...(expires ? { expires } : {}),
});

test("spends what expires soonest first, then plan, trial and gifts, and what was bought last", () => {
  const { balance, buckets } = walk(
    [
      grant("bought", "purchase", 10, "2026-11-01"),
      grant("gift", "gift", 2, "2026-11-01"),
      grant("soon", "gift", 1, "2026-11-01", "2026-11-20"),
      grant("plan", "plan", 3, "2026-11-01", "2026-12-01"),
    ],
    { "2026-11-02": 4.5 },
    "2026-11-03",
  );
  assertEquals(balance, 11.5);
  // "soon" (1) and then "plan" (3) are gone, and half of the undated gift.
  assertEquals(buckets.map((b) => [b.id, b.left]), [["gift", 1.5], ["bought", 10]]);
});

test("credits lapse unspent on their day, and don't pay what's spent after", () => {
  const walked = walk([grant("plan", "plan", 10, "2026-10-01", "2026-11-01")], {
    "2026-10-15": 4,
    "2026-11-01": 1,
  }, "2026-11-02");
  assertEquals([walked.expired, walked.debt, walked.balance], [6, 1, -1]);
});

test("spending past the credits is debt, and the next grant pays it first", () => {
  const owing = walk([grant("trial", "trial", 5, "2026-11-01")], { "2026-11-02": 7 }, "2026-11-03");
  assertEquals([owing.balance, owing.debt, owing.buckets], [-2, 2, []]);
  const paid = walk(
    [
      grant("trial", "trial", 5, "2026-11-01"),
      grant("gift", "gift", 10, "2026-11-04"),
    ],
    { "2026-11-02": 7 },
    "2026-11-05",
  );
  assertEquals([paid.balance, paid.debt], [8, 0]);
  assertEquals(paid.buckets.map((b) => [b.id, b.left, b.amount]), [["gift", 8, 10]]);
});

test("a grant on a day pays that day's spending, wherever in the day each fell", () => {
  const { balance, debt } = walk([grant("gift", "gift", 10, "2026-11-02")], {
    "2026-11-02": 3,
  }, "2026-11-02");
  assertEquals([balance, debt], [7, 0]);
});

test("a negative grant takes credits away; a correction gives them back", () => {
  assertEquals(
    walk(
      [
        grant("gift", "gift", 10, "2026-11-01"),
        grant("oops", "adjustment", -4, "2026-11-02"),
      ],
      {},
      "2026-11-03",
    ).balance,
    6,
  );
  const back = walk([grant("gift", "gift", 10, "2026-11-01")], {
    "2026-11-01": 3,
    "2026-11-02": -1,
  }, "2026-11-03");
  assertEquals(back.balance, 8);
});

test("nothing granted, nothing spent: nothing; days ahead don't count", () => {
  assertEquals(walk([], {}, "2026-11-01"), { balance: 0, buckets: [], debt: 0, expired: 0 });
  assertEquals(
    walk([grant("later", "gift", 5, "2026-12-01")], { "2026-12-02": 1 }, "2026-11-01").balance,
    0,
  );
});

test("periods run from the anchor's day, or a shorter month's last", () => {
  assertEquals(periodOf("2026-01-15T10:00:00Z", "2026-03-20T00:00:00Z"), {
    start: "2026-03-15",
    end: "2026-04-15",
  });
  assertEquals(periodOf("2026-01-15T10:00:00Z", "2026-03-14T23:00:00Z"), {
    start: "2026-02-15",
    end: "2026-03-15",
  });
  assertEquals(periodOf("2026-01-31T10:00:00Z", "2026-02-28T12:00:00Z"), {
    start: "2026-02-28",
    end: "2026-03-31",
  });
  assertEquals(periodOf("2026-01-31T10:00:00Z", "2026-02-10T12:00:00Z"), {
    start: "2026-01-31",
    end: "2026-02-28",
  });
  assertEquals(monthOf("2026-12-31T23:59:00Z"), { start: "2026-12-01", end: "2027-01-01" });
});
