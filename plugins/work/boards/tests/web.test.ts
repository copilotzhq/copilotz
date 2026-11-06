/**
 * Boards on the web, their logic: a label's hue (the same everywhere), a due
 * date as a card shows it (overdue says so, unless it's done), who someone
 * is (people by their email's name, you marked; agents as chat shows them),
 * the space's people in order, what a filter keeps, the board's labels by
 * use, and cards by column with moves on their way shown where they go.
 */
import assert from "node:assert/strict";
import { test } from "../../../../testing/mod.ts";
import type { Board, Card } from "../contract.ts";
import {
  byColumn,
  dueShown,
  filtering,
  hueOf,
  HUES,
  kept,
  labelsOn,
  NO_FILTERS,
  peopleOf,
  someoneOf,
  type Team,
} from "../views/web/shown.ts";

const card = (over: Partial<Card>): Card => ({
  _id: "c",
  in: "s",
  board: "b",
  column: "todo",
  order: 1024,
  title: "A card",
  at: "2026-10-29T10:00:00Z",
  ...over,
});

test("a label's hue is the same wherever it shows, in any case", () => {
  assert.equal(hueOf("Web"), hueOf("web"));
  assert.equal(hueOf(" web "), hueOf("web"));
  const hues = new Set(
    ["web", "launch", "legal", "design", "ops", "growth", "bug", "q4"].map(hueOf),
  );
  assert.ok(hues.size > 3, "labels spread over the hues");
  for (const h of hues) assert.ok(h >= 0 && h < HUES);
});

test("a due date against today: overdue says so, unless it's done", () => {
  const today = "2026-10-29";
  assert.deepEqual(dueShown("2026-10-28", today), {
    text: "Overdue · yesterday",
    tone: "overdue",
    title: "1 day overdue",
  });
  assert.equal(dueShown("2026-10-20", today).text, "Overdue · Oct 20");
  assert.equal(dueShown("2026-10-29", today).text, "Today");
  assert.equal(dueShown("2026-10-30", today).tone, "soon");
  assert.equal(dueShown("2026-11-01", today).tone, "soon");
  assert.deepEqual(dueShown("2026-11-12", today), {
    text: "Nov 12",
    tone: "later",
    title: "Due in 14 days",
  });
  assert.equal(dueShown("2027-01-05", today).text, "Jan 5, 2027");
  assert.deepEqual(dueShown("2026-10-20", today, true), {
    text: "Oct 20",
    tone: "done",
    title: "Was due Oct 20",
  });
});

test("who someone is, and the space's people in order: you, people, then agents", () => {
  const team: Team = {
    here: ["north"],
    default: ["north"],
    agents: { north: { name: "North", icon: "🧭" }, maya: { name: "Maya" } },
  };
  assert.deepEqual(someoneOf("agent:north", team), {
    key: "agent:north",
    kind: "agent",
    name: "North",
    icon: "🧭",
  });
  assert.deepEqual(someoneOf("agent:gone"), { key: "agent:gone", kind: "agent", name: "gone" });
  assert.deepEqual(someoneOf("person:bob@example.com", team), {
    key: "person:bob@example.com",
    kind: "person",
    name: "bob",
    note: "bob@example.com",
  });
  assert.equal(someoneOf("person:ana@example.com", team, "ana@example.com").name, "ana (you)");
  const people = peopleOf(
    [
      { member: "agent:north" },
      { member: "person:zoe@example.com" },
      { member: "person:ana@example.com" },
      { member: "space:other" },
      { member: "person:bob@example.com" },
    ],
    team,
    "ana@example.com",
    ["agent:maya"],
  );
  assert.deepEqual(people.map((p) => p.name), ["ana (you)", "bob", "zoe", "Maya", "North"]);
});

test("people by their profiles' names; the id someone signed in with never shows", () => {
  const names = { "google:1139": "Dee Ray" };
  assert.deepEqual(someoneOf("person:google:1139", undefined, undefined, names), {
    key: "person:google:1139",
    kind: "person",
    name: "Dee Ray",
  });
  assert.equal(someoneOf("person:google:1139").name, "someone");
  assert.equal(
    someoneOf("person:google:1139", undefined, "google:1139", names).name,
    "Dee Ray (you)",
  );
  const people = peopleOf(
    [{ member: "person:google:1139" }, { member: "person:ana" }],
    undefined,
    undefined,
    [],
    names,
  );
  assert.deepEqual(people.map((p) => p.name), ["ana", "Dee Ray"]);
});

test("filters keep cards with every word, one of the owners, one of the labels", () => {
  const cards = [
    card({ _id: "1", title: "Ship the pricing page", labels: ["web"], assignee: "agent:north" }),
    card({ _id: "2", title: "Book the venue", description: "Near the station" }),
    card({ _id: "3", title: "Pricing FAQ", labels: ["Web", "docs"], assignee: "person:ana" }),
  ];
  const names = (k: string) => k === "agent:north" ? "North" : k;
  const ids = (f: typeof NO_FILTERS) => cards.filter((c) => kept(c, f, names)).map((c) => c._id);
  assert.equal(filtering(NO_FILTERS), false);
  assert.deepEqual(ids(NO_FILTERS), ["1", "2", "3"]);
  assert.deepEqual(ids({ ...NO_FILTERS, search: "pricing" }), ["1", "3"]);
  assert.deepEqual(ids({ ...NO_FILTERS, search: "station" }), ["2"]);
  assert.deepEqual(ids({ ...NO_FILTERS, search: "north ship" }), ["1"]);
  assert.deepEqual(ids({ ...NO_FILTERS, assignees: ["none"] }), ["2"]);
  assert.deepEqual(ids({ ...NO_FILTERS, assignees: ["agent:north", "person:ana"] }), ["1", "3"]);
  assert.deepEqual(ids({ ...NO_FILTERS, labels: ["WEB"] }), ["1", "3"]);
  assert.deepEqual(ids({ search: "faq", assignees: [], labels: ["web"] }), ["3"]);
  assert.deepEqual(labelsOn(cards), [{ label: "web", count: 2 }, { label: "docs", count: 1 }]);
});

test("cards by column, in order, with a move on its way shown where it goes", () => {
  const board: Board = {
    _id: "b",
    in: "s",
    name: "Plan",
    columns: [{ id: "todo", name: "To do" }, { id: "done", name: "Done" }],
    at: "2026-10-29T10:00:00Z",
  };
  const cards = [
    card({ _id: "a", order: 2048 }),
    card({ _id: "b", order: 1024 }),
    card({ _id: "c", column: "done" }),
    card({ _id: "d", column: "removed" }),
  ];
  const ids = (m: Map<string, Card[]>) =>
    Object.fromEntries([...m].map(([k, v]) => [k, v.map((c) => c._id)]));
  // A card of a column the board no longer has shows in its first, by its order.
  assert.deepEqual(ids(byColumn(board, cards)), { todo: ["b", "d", "a"], done: ["c"] });
  assert.deepEqual(ids(byColumn(board, cards, { a: { column: "done", order: 0 } })), {
    todo: ["b", "d"],
    done: ["a", "c"],
  });
});
