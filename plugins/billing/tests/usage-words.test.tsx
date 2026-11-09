/**
 * The Usage page's words are the app's to change: drawn with every word replaced by its key
 * nothing English is left; drawn with none given the English is as it was; and in another
 * language a plural and a blank follow that language.
 */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { test } from "../../../testing/mod.ts";
import { setWords } from "../../../hosts/web/words.ts";
import { englishLeft, pseudoWords } from "../../../testing/words.ts";
import {
  ActivityCard,
  Breakdown,
  Calls,
  Headline,
  paidBy,
  type Sayers,
} from "../usage/views/web/org.tsx";
import { StackedChart } from "../usage/views/web/chart.tsx";
import {
  columnsOf,
  durationSaid,
  lastsSaid,
  monthSaid,
  purposeSaid,
  rowsOf,
  savedSaid,
  type Total,
  usd,
} from "../usage/views/web/numbers.ts";
import type { ActivityItem } from "../usage/actions/activity.ts";
import { say } from "../usage/views/web/words.ts";

const total = (key: Record<string, unknown>, price: number, cost?: number): Total => ({
  key,
  quantities: { input: 1000, output: 100, cached: 400 },
  price,
  prices: {},
  uses: 3,
  unpriced: 0,
  saved: { price: 0.2, ...(cost === undefined ? {} : { cost: 0.1 }) },
  ...(cost === undefined ? {} : { cost, costs: {} }),
} as Total);

const names: Sayers = {
  nameOf: (p) => (p ? "Ana" : say("notTiedToAnyone")),
  faceOf: () => "Ana",
  spaceOf: (s) => (s ? "Acme" : say("spaceNotRecorded")),
  modelName: (m) => m.split("/").pop()!,
  people: new Map(),
  names: { "tags.thread": { t1: { name: "Plans" } }, "tags.computer": { c1: { name: "Box" } } },
};

const item = (over: Partial<ActivityItem>): ActivityItem => ({
  kind: "turn",
  id: "i1",
  first: "2026-11-02T10:00:00Z",
  last: "2026-11-02T10:05:00Z",
  price: 0.5,
  saved: { price: 0 },
  quantities: { input: 2000, output: 300, cached: 1000 },
  uses: 2,
  unpriced: 0,
  tags: { thread: "t1", agent: "researcher", person: "ana", space: "s1" },
  subject: "acme/lyra-1",
  ...over,
});

const items: ActivityItem[] = [
  item({
    calls: [{
      _id: "c1",
      meter: "llm",
      subject: "acme/lyra-1",
      quantities: { input: 100, output: 10, cached: 50 },
      price: 0.1,
      cost: 0.05,
      at: "2026-11-02T10:01:00Z",
    }],
  }),
  item({
    id: "i2",
    kind: "model",
    tags: { thread: "t1" },
    purposes: ["history", "memory"],
    uses: 1,
  }),
  item({ id: "i3", kind: "model", tags: {}, uses: 3 }),
  item({
    id: "i4",
    kind: "session",
    subject: "cloud/small",
    quantities: { seconds: 800 },
    tags: { computer: "c1", session: "2026-11-02T09:00:00Z" },
  }),
  item({
    id: "i5",
    kind: "computer",
    subject: "cloud/disk",
    quantities: { gbHours: 12 },
    tags: { computer: "c1" },
  }),
  item({ id: "i6", kind: "app", quantities: { requests: 1200, minutes: 1 }, tags: { app: "a1" } }),
  item({
    id: "i7",
    kind: "other",
    meter: "search",
    subject: "acme/web",
    uses: 1,
    tags: { paid: "own-key" },
  }),
];

const kinds = [
  total({ day: "2026-11-01", category: "agents" }, 3, 2),
  total({ day: "2026-11-02", category: "computers" }, 1, 0.5),
  total({ day: "2026-11-03", category: "apps" }, 0.5, 0.2),
];
const models = [
  total({ day: "2026-11-01", category: "agents", subject: "acme/lyra-1" }, 3, 2),
];

/** Every part of the page that draws without the browser, with the staff, the empty and the plural cases. */
function everything(): ReactNode[] {
  const parts: ReactNode[] = [];
  for (const dimension of ["kind", "space", "person", "agent", "model"] as const) {
    const totals = dimension === "model" ? models : kinds;
    parts.push(
      <Breakdown
        rows={rowsOf(totals, dimension)}
        totals={totals}
        dimension={dimension}
        setDimension={() => {}}
        month="2026-11"
        today="2026-11-02"
        chosen={undefined}
        choose={() => {}}
        staff
        everyone
        namer={names}
      />,
    );
  }
  const base = {
    spent: {
      spend: 4.5,
      tokens: 1,
      uses: 2,
      unpriced: 0,
      input: 1,
      output: 1,
      cached: 0,
      cacheWrite: 0,
      saved: 0.4,
      cost: 2.7,
    },
    before: 3,
    month: "2026-11",
    now: Date.parse("2026-11-10T12:00:00Z"),
    everyone: true,
    filtered: true,
    whole: 9,
    staff: true,
    manage: true,
  };
  const billing = {
    on: true,
    runs: true,
    balance: 20,
    month: { start: "2026-11-01", end: "2026-12-01", spent: 4.5, limit: 50 },
  };
  parts.push(<Headline {...base} ongoing billing={billing} />);
  parts.push(
    <Headline
      {...base}
      ongoing={false}
      everyone={false}
      filtered={false}
      spent={{ ...base.spent, saved: -0.2 }}
      billing={{ ...billing, balance: 0, month: { ...billing.month, limit: undefined } }}
    />,
  );
  parts.push(
    <Headline
      {...base}
      ongoing
      before={0}
      billing={{ ...billing, balance: 1000, month: { ...billing.month, limit: 5 } }}
    />,
  );
  parts.push(
    <ActivityCard
      activity={{ items, more: true, names: {} }}
      everyone
      staff
      namer={names}
      more={() => {}}
      filtered
    />,
  );
  parts.push(
    <ActivityCard
      activity={{ items: [], more: false, names: {} }}
      everyone={false}
      staff={false}
      namer={names}
      more={() => {}}
      filtered={false}
    />,
  );
  parts.push(<Calls calls={items[0].calls!} staff namer={names} />);
  parts.push(
    <StackedChart
      columns={columnsOf(kinds, "kind", ["2026-11-01", "2026-11-02"], ["agents"])}
      series={[{ key: "agents", name: "Agents", color: "red" }]}
      label="Spend"
    />,
  );
  return parts;
}

/** Only what a person reads or hears: text, and the attributes read aloud or shown on hover. */
const shown = (markup: string) =>
  markup.replace(/<([a-z0-9]+)((?:\s+[\w:-]+(?:="[^"]*")?)*)\s*\/?>/g, (_, tag, attributes) => {
    const kept = [
      ...attributes.matchAll(/\s((?:aria-label|aria-valuetext|title|placeholder|alt)="[^"]*")/g),
    ];
    return `<${tag}${kept.map((k) => ` ${k[1]}`).join("")}>`;
  });

const draw = () => everything().map((p) => renderToStaticMarkup(<>{p}</>)).join("\n");
const sayings = () =>
  [
    savedSaid(1),
    savedSaid(0),
    savedSaid(-1),
    lastsSaid(7, 1),
    lastsSaid(0.5, 1),
    lastsSaid(100, 1),
    durationSaid(30),
    durationSaid(900),
    durationSaid(8000),
    purposeSaid("history"),
    paidBy({ paid: "own-key" })!.title,
    paidBy({ paid: "subscription" })!.label,
  ].join("|");

test("with every word replaced, no English of the Usage page is left", () => {
  const restore = setWords(pseudoWords("usage"));
  try {
    const markup = draw();
    assertEquals(englishLeft(shown(markup), "usage"), []);
    for (
      const key of [
        "spendBy",
        "activity",
        "showOlder",
        "costColumn",
        "showNumbers",
        "turnTitle",
      ]
    ) {
      assertStringIncludes(markup, `«usage.${key}»`);
    }
    assertEquals(englishLeft(sayings(), "usage"), []);
    assertStringIncludes(sayings(), "«usage.saved»");
  } finally {
    restore();
  }
});

test("with none given, the Usage page says what it always did", () => {
  const markup = draw();
  for (
    const phrase of [
      "Spend by",
      "Cost and margin: staff only",
      "Show older",
      "Nothing here matches what&#x27;s chosen.",
      "spent this month",
      "caching saved $0.40",
      "Upkeep of “Plans”",
      "Disk of “Box”",
      "1.2K requests",
      "1 build minute",
      "Show its 1 model call",
    ]
  ) assertStringIncludes(markup, phrase);
  assertEquals(savedSaid(1.234), "$1.23 saved");
  assertEquals(lastsSaid(30, 1), "about 4 weeks");
  assertEquals(durationSaid(8000), "2h 13m");
  assertEquals(usd(12_345), "$12.3K");
  assertEquals(monthSaid("2026-11"), "November 2026");
});

test("in another language a plural and a blank follow that language", () => {
  const restore = setWords({
    "usage.uses": { one: "{count} uso", other: "{count} usos" },
    "usage.saved": "{amount} economizados",
    "usage.spentIn": "gasto em {month}",
  });
  const document = (globalThis as { document?: unknown }).document;
  (globalThis as { document?: unknown }).document = { documentElement: { lang: "pt-BR" } };
  try {
    assertEquals(say("uses", { count: 1 }), "1 uso");
    assertEquals(say("uses", { count: 5 }), "5 usos");
    assertEquals(savedSaid(2), `${usd(2)} economizados`);
    assertStringIncludes(usd(1234.5), "1.235");
    assertStringIncludes(monthSaid("2026-11"), "novembro");
    assert(say("spentIn", { month: "novembro" }).startsWith("gasto em"));
  } finally {
    (globalThis as { document?: unknown }).document = document;
    restore();
  }
});
