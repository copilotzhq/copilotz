/**
 * What the rows editor does to its rows: one added after another or at the ends, one taken out or
 * changed, the bounds on how many, where the focus goes after a row goes, and keys that stay with a
 * row as it's edited.
 */
import { assert, assertEquals, assertNotEquals } from "@std/assert";
import { test } from "../../../testing/mod.ts";
import {
  canAdd,
  canRemove,
  carryKey,
  focusAfterRemoving,
  insertAfter,
  keyOfRow,
  removeAt,
  replaceAt,
} from "../toolkit/rows.ts";

test("a row added after another, at the start, or at the end", () => {
  assertEquals(insertAfter(["a", "b"], 0, "x"), ["a", "x", "b"]);
  assertEquals(insertAfter(["a", "b"], -1, "x"), ["x", "a", "b"]);
  assertEquals(insertAfter(["a", "b"], 1, "x"), ["a", "b", "x"]);
  assertEquals(insertAfter([], -1, "x"), ["x"]);
  assertEquals(insertAfter(["a"], 9, "x"), ["a", "x"]);
});

test("a row taken out, or changed, and the rest as they were", () => {
  const rows = ["a", "b", "c"];
  assertEquals(removeAt(rows, 1), ["a", "c"]);
  assertEquals(replaceAt(rows, 2, "z"), ["a", "b", "z"]);
  assertEquals(rows, ["a", "b", "c"]);
});

test("the bounds: no more than max, no fewer than min", () => {
  assert(canAdd(3));
  assert(canAdd(2, 3));
  assert(!canAdd(3, 3));
  assert(canRemove(1));
  assert(!canRemove(0));
  assert(!canRemove(1, 1));
  assert(canRemove(2, 1));
});

test("after a row goes, the focus goes to the one in its place, the one before it, or the add button", () => {
  assertEquals(focusAfterRemoving(3, 0), 0);
  assertEquals(focusAfterRemoving(3, 1), 1);
  assertEquals(focusAfterRemoving(3, 2), 1);
  assertEquals(focusAfterRemoving(1, 0), -1);
});

test("a row's key: its own, its object's (kept through an edit), or its place", () => {
  assertEquals(keyOfRow({ id: 7 }, 0, (row) => row.id), "7");
  const row = { code: "A" };
  const key = keyOfRow(row, 0);
  assertEquals(keyOfRow(row, 5), key);
  const edited = { ...row, code: "AB" };
  assertNotEquals(keyOfRow({ code: "A" }, 0), key);
  carryKey(row, edited);
  assertEquals(keyOfRow(edited, 0), key);
  assertEquals(keyOfRow("plain", 3), "at-3");
});
