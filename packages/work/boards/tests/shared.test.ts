/**
 * Boards' pure parts: where a card goes in a column (midpoints, the ends,
 * numbering again when there's no room), columns (ids from names, found as
 * people name them, their stage of work, changed as a whole list), due
 * dates against today, who a typed name is, and answers read back.
 */
import assert from "node:assert/strict";
import { test } from "copilotz/testing";
import { changeColumns, columnId, columnOf, DEFAULT_COLUMNS, stageOf } from "../shared/columns.ts";
import { daysUntil, dueSaid } from "../shared/dates.ts";
import { between, byOrder, indexOf, orderAt, STEP } from "../shared/order.ts";
import { type Someone, whoIs } from "../shared/people.ts";
import { heard, onBoard } from "../shared/said.ts";

const cards = (...orders: number[]) => orders.map((order, i) => ({ _id: `c${i}`, order }));

test("a card's place: midpoints between neighbours, a step past the ends, renumbered when full", () => {
  assert.equal(between(), STEP);
  assert.equal(between(undefined, 100), 100 - STEP);
  assert.equal(between(100, undefined), 100 + STEP);
  assert.equal(between(1, 2), 1.5);
  assert.equal(between(1, 1 + 1e-9), undefined);
  assert.equal(between(5, 5), undefined);

  const column = cards(1024, 2048, 3072);
  assert.equal(indexOf(column), 3);
  assert.equal(indexOf(column, { at: "top" }), 0);
  assert.equal(indexOf(column, { at: "bottom" }), 3);
  assert.equal(indexOf(column, { before: "c1" }), 1);
  assert.equal(indexOf(column, { after: "c1" }), 2);
  assert.equal(indexOf(column, { after: "gone" }), 3);
  assert.deepEqual(orderAt(column, 1), { order: 1536, renumbered: {} });
  assert.deepEqual(orderAt(column, 0), { order: 0, renumbered: {} });
  assert.deepEqual(orderAt([], 0), { order: STEP, renumbered: {} });

  // No room between the first two: the column is numbered again from the top.
  const full = cards(1, 1 + 1e-9, 7);
  const { order, renumbered } = orderAt(full, 1);
  assert.equal(order, 2 * STEP);
  assert.deepEqual(renumbered, { c0: STEP, c1: 3 * STEP, c2: 4 * STEP });
  // Ties show in the order they were made.
  assert.deepEqual(
    byOrder([
      { _id: "b", order: 1, at: "2026-01-02" },
      { _id: "a", order: 1, at: "2026-01-01" },
      { _id: "c", order: 0 },
    ]).map((c) => c._id),
    ["c", "a", "b"],
  );
});

test("columns: ids from names, found as people name them, and their stage of work", () => {
  assert.equal(columnId("In review", []), "in-review");
  assert.equal(columnId("QA", ["qa"]), "qa-2");
  assert.equal(columnId("✨", []), "column");
  assert.equal(columnId("Não começado", []), "nao-comecado");
  assert.equal(columnOf(DEFAULT_COLUMNS, "todo")?.name, "To do");
  assert.equal(columnOf(DEFAULT_COLUMNS, "TO DO")?.id, "todo");
  assert.equal(columnOf(DEFAULT_COLUMNS, "to-do")?.id, "todo");
  assert.equal(columnOf(DEFAULT_COLUMNS, "in review")?.id, "review");
  assert.equal(columnOf(DEFAULT_COLUMNS, "Later"), undefined);
  assert.deepEqual(DEFAULT_COLUMNS.map(stageOf), [
    "backlog",
    "todo",
    "doing",
    "blocked",
    "review",
    "done",
  ]);
  assert.equal(stageOf({ id: "x", name: "In progress" }), "doing");
  assert.equal(stageOf({ id: "x", name: "Shipped" }), "done");
  assert.equal(stageOf({ id: "x", name: "Waiting on legal" }), "blocked");
  assert.equal(stageOf({ id: "x", name: "Ideas" }), "backlog");
  assert.equal(stageOf({ id: "x", name: "This week" }), "todo");

  const was = [{ id: "a", name: "A" }, { id: "b", name: "B" }, { id: "c", name: "C" }];
  const change = changeColumns(was, [{ id: "c", name: "C!" }, { name: "New" }, {
    id: "a",
    name: "A",
  }]);
  assert.deepEqual(change.columns, [
    { id: "c", name: "C!" },
    { id: "new", name: "New" },
    { id: "a", name: "A" },
  ]);
  assert.deepEqual(change.added, [{ id: "new", name: "New" }]);
  assert.deepEqual(change.removed, [{ id: "b", name: "B" }]);
  // An id given twice is a new column the second time; an unknown id too.
  assert.deepEqual(
    changeColumns(was, [{ id: "a", name: "A" }, { id: "a", name: "A2" }, { id: "zz", name: "Z" }])
      .columns.map((c) => c.id),
    ["a", "a2", "z"],
  );
  assert.throws(() => changeColumns(was, []), /at least one column/);
  assert.throws(() => changeColumns(was, [{ name: "Same" }, { name: "same" }]), /already a column/);
  assert.throws(() => changeColumns(was, [{ name: "  " }]), /needs a name/);
});

test("due dates against today", () => {
  assert.equal(daysUntil("2026-11-02", "2026-10-29"), 4);
  assert.equal(daysUntil("2026-10-27", "2026-10-29"), -2);
  assert.equal(daysUntil("2027-01-01", "2026-12-31"), 1);
  assert.equal(dueSaid("2026-11-02", "2026-10-29"), "due 2026-11-02 (in 4 days)");
  assert.equal(dueSaid("2026-10-29", "2026-10-29"), "due today (2026-10-29)");
  assert.equal(dueSaid("2026-10-30", "2026-10-29"), "due tomorrow (2026-10-30)");
  assert.equal(dueSaid("2026-10-28", "2026-10-29"), "overdue: was due 2026-10-28 (1 day ago)");
  assert.equal(dueSaid("2026-10-20", "2026-10-29", true), "was due 2026-10-20");
});

test("who a typed name is, among a space's people and agents", () => {
  const people: Someone[] = [
    {
      key: "person:ana",
      kind: "person",
      name: "Ana Lima",
      also: ["ana", "ana@example.com", "ana"],
    },
    {
      key: "person:google:1",
      kind: "person",
      name: "Bob",
      also: ["google:1", "bob@corp.com", "bob"],
    },
    { key: "agent:north", kind: "agent", name: "North", also: ["north", "@north", "North"] },
    { key: "agent:maya-2", kind: "agent", name: "Maya", also: ["maya-2", "@maya-2", "Maya"] },
  ];
  const key = (typed: string) => {
    const found = whoIs(typed, people, "north");
    return "found" in found ? found.found.key : "none" in found ? "none" : "several";
  };
  assert.equal(key("me"), "agent:north");
  assert.equal(key("North"), "agent:north");
  assert.equal(key("@north"), "agent:north");
  assert.equal(key("maya"), "agent:maya-2");
  assert.equal(key("bob@corp.com"), "person:google:1");
  assert.equal(key("BOB"), "person:google:1");
  assert.equal(key("ana lima"), "person:ana");
  assert.equal(key("lima"), "person:ana");
  assert.equal(key("West"), "none");
  assert.ok("none" in whoIs("me", people.slice(0, 2), "north"));
});

test("answers read back: what happened, the boards named, the card", () => {
  const board = { _id: "b1", name: "Launch — v2" };
  assert.deepEqual(heard(onBoard("Moved “Pay — the bill” [c9] from To do to Doing", board)), {
    ok: true,
    head: "Moved “Pay — the bill” from To do to Doing",
    boards: [{ name: "Launch — v2", id: "b1" }],
    card: "c9",
  });
  assert.deepEqual(heard("No card “x” here."), { ok: false, head: "No card “x” here", boards: [] });
  assert.deepEqual(
    heard("2 boards in this space:\n- “A” (/board/a): no cards yet\n- “B” (/board/b): 1 card")
      .boards,
    [{ name: "A", id: "a" }, { name: "B", id: "b" }],
  );
  assert.deepEqual(heard(undefined), { ok: false, head: "", boards: [] });
});
