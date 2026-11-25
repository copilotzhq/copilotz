/**
 * What a computer the app keeps costs, as the web says it (`computer.cost`): a new one's hour
 * and how far the plan's credits go; one of theirs' hour; this month so far. Every number is
 * the app's; nothing shows when it isn't priced; and the words are the app's to give.
 */
import { assertEquals } from "@std/assert";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ViewContext } from "../../../runtime/mod.ts";
import { setWords } from "../../../hosts/web/words.ts";
import { englishLeft, pseudoWords } from "../../../testing/words.ts";
import type { ComputerCost } from "../computers/shared/cost.ts";
import { computerCostView, costSaid } from "../computers/views/web/cost.tsx";
import { test } from "../../../testing/mod.ts";

const COST: ComputerCost = {
  hour: 0.16,
  warmMinutes: 10,
  diskMonth: 2,
  covers: { hours: 18, amount: 5, every: "once" },
  month: { seconds: 9600, price: 0.4267 },
};

/** The View, over what `computer.cost` answers, with these hints. */
const drawn = (cost: ComputerCost | null, item: { computer?: string }, mode?: string) =>
  renderToStaticMarkup(
    <>
      {computerCostView(
        item,
        {
          db: { collection: () => ({ query: () => ({ status: "ready", value: cost }) }) },
          hints: mode ? { mode } : {},
        } as unknown as ViewContext<ReactNode>,
      )}
    </>,
  ).replace(/<[^>]+>/g, "").replace(/&#x27;/g, "'");

test("a new one: its hour, and how far the plan's credits go after this month's disk", () => {
  assertEquals(
    drawn(COST, {}),
    "About 16¢ per hour of work, and it sleeps 10 minutes after. " +
      "Your $5 covers about 18 hours of work, after this month's disk.",
  );
  assertEquals(
    costSaid({ ...COST, covers: { hours: 80, amount: 15, every: "month" } }, "price")[1],
    "Your $15 a month covers about 80 hours of work, after the disk.",
  );
  assertEquals(costSaid({ ...COST, covers: undefined }, "price").length, 1);
});

test("one of theirs: its hour; and this month so far, awake, what it came to, and its disk", () => {
  assertEquals(
    drawn(COST, { computer: "c1" }),
    "About 16¢ per hour of work, and it sleeps 10 minutes after.",
  );
  assertEquals(
    drawn(COST, { computer: "c1" }, "month"),
    "This month: 2h 40m awake · $0.43 · disk $2.00",
  );
  assertEquals(
    costSaid(
      { ...COST, hour: 0.41, diskMonth: null, month: { seconds: 720, price: 0.08 } },
      "month",
    ),
    ["This month: 12m awake · $0.08"],
  );
  assertEquals(costSaid({ ...COST, hour: 1.2, warmMinutes: 1 }, "cost"), [
    "About $1.20 per hour of work, and it sleeps 1 minute after.",
  ]);
});

test("not priced (a person's own machine, an app that prices none): nothing", () => {
  assertEquals(drawn(null, { computer: "laptop" }), "");
  assertEquals(drawn({ ...COST, month: undefined }, { computer: "c1" }, "month"), "");
});

test("its words are the app's: nothing English left once they're all given", () => {
  const restore = setWords(pseudoWords("computers"));
  try {
    const read = ["price", "cost", "month"].map((mode) => drawn(COST, { computer: "c" }, mode))
      .join(" ");
    assertEquals(englishLeft(read, "computers"), []);
  } finally {
    restore();
  }
});
