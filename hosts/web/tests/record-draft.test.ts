/**
 * A record dialog's draft, as data (toolkit/record-draft.ts): only edits, over the record as it
 * is now. An untouched field is never sent, an edit is sent when it changes something, and a
 * cleared field is an `unset` (a list emptied is `[]`). A new record is its defaults with the
 * edits. A refusal goes under the field that holds it, in people's words.
 */
import assert from "node:assert/strict";
import { test } from "../../../testing/mod.ts";
import {
  createOf,
  type Edits,
  holds,
  refusalWords,
  related,
  same,
  savedOf,
  shownAs,
  updateOf,
  valueAt,
  withValue,
} from "../toolkit/record-draft.ts";
import { refusedField } from "../toolkit/refusal.ts";

const customer = {
  _id: "c1",
  name: "Ana",
  email: "a@example.com",
  nickname: null,
  price: 24,
  createdAt: "2026-11-01 09:00",
  address: { city: "Recife", street: "Rua A" },
  tags: ["vip"],
  active: true,
};

test("paths: read and write through objects, a copy each time; undefined deletes", () => {
  assert.equal(valueAt(customer, "address.city"), "Recife");
  assert.equal(valueAt(customer, "address.zip"), undefined);
  assert.equal(valueAt({ lines: [{ qty: 2 }] }, "lines.0.qty"), 2);
  const moved = withValue(customer, "address.city", "Olinda");
  assert.equal(moved.address.city, "Olinda");
  assert.equal(customer.address.city, "Recife");
  assert.deepEqual(withValue({}, "a.b", 1), { a: { b: 1 } });
  assert.deepEqual(withValue({ a: { b: 1, c: 2 } }, "a.b", undefined), { a: { c: 2 } });
  assert.ok(same({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] }));
  assert.ok(!same([1, 2], [2, 1]));
});

test("each kind shows the stored value its way, and saves it as a record keeps it", () => {
  assert.equal(shownAs("text", null), "");
  assert.equal(shownAs("text", 12), "12");
  assert.equal(shownAs("number", 24), "24");
  assert.equal(shownAs("number", undefined), "");
  assert.equal(shownAs("checked", "yes"), false);
  assert.equal(shownAs("checked", true), true);
  assert.equal(shownAs("value", null), undefined);
  assert.deepEqual(shownAs("list", undefined), []);
  assert.equal(savedOf({ kind: "text", raw: "" }), undefined);
  assert.equal(savedOf({ kind: "text", raw: " Bo " }), " Bo ");
  assert.equal(savedOf({ kind: "number", raw: "" }), undefined);
  assert.equal(savedOf({ kind: "number", raw: "1e3" }), 1000);
  assert.equal(savedOf({ kind: "number", raw: "abc" }), "abc"); // for the schema to refuse
  assert.equal(savedOf({ kind: "value", raw: "" }), undefined);
  assert.equal(savedOf({ kind: "set", raw: null }), null);
  assert.equal(savedOf({ kind: "set", raw: "" }), "");
  assert.deepEqual(savedOf({ kind: "list", raw: [] }), []);
});

test("R1: an untouched field is never in a change; nor is a field with no control", () => {
  const edits: Edits = { name: { kind: "text", raw: "Ana S" } };
  assert.deepEqual(updateOf(customer, edits, {}), {
    set: { name: "Ana S" },
    unset: [],
    update: { $set: { name: "Ana S" } },
  });
  // Typing into the null nickname and emptying it again leaves it null.
  assert.equal(updateOf(customer, { nickname: { kind: "text", raw: "" } }, {}), undefined);
});

test("R2: edits are compared with the record as it is now, not as it was", () => {
  const edits: Edits = {
    name: { kind: "text", raw: "Ana S" },
    email: { kind: "text", raw: "b@example.com" },
  };
  const fresh = { ...customer, email: "b@example.com" };
  assert.deepEqual(updateOf(fresh, edits, {})?.set, { name: "Ana S" });
});

test("R3: a cleared text, number or choice is an unset; over an empty one, nothing", () => {
  const cleared = updateOf(customer, { price: { kind: "number", raw: "" } }, {});
  assert.deepEqual(cleared, { set: {}, unset: ["price"], update: { $unset: { price: "" } } });
  const zero = updateOf({ ...customer, price: 0 }, { price: { kind: "number", raw: "" } }, {});
  assert.deepEqual(zero?.unset, ["price"]);
  const absent = { ...customer, price: undefined };
  assert.equal(updateOf(absent, { price: { kind: "number", raw: "" } }, {}), undefined);
  const choice = updateOf(customer, { "address.city": { kind: "value", raw: undefined } }, {});
  assert.deepEqual(choice?.update, { $unset: { "address.city": "" } });
});

test("R4: an edit back to the record's value isn't sent; numbers, checkboxes, lists, paths", () => {
  assert.equal(updateOf(customer, { price: { kind: "number", raw: "24" } }, {}), undefined);
  assert.deepEqual(updateOf(customer, { price: { kind: "number", raw: "24.5" } }, {})?.set, {
    price: 24.5,
  });
  // A checkbox is sent when it's checked or not, as the record wasn't.
  assert.equal(updateOf({ _id: "x" }, { paid: { kind: "checked", raw: false } }, {}), undefined);
  assert.deepEqual(updateOf({ _id: "x" }, { paid: { kind: "checked", raw: true } }, {})?.set, {
    paid: true,
  });
  assert.deepEqual(updateOf(customer, { active: { kind: "checked", raw: false } }, {})?.set, {
    active: false,
  });
  // A list emptied is the empty list, a value: sent unless the record holds `[]` already.
  assert.deepEqual(updateOf(customer, { tags: { kind: "list", raw: [] } }, {})?.update, {
    $set: { tags: [] },
  });
  assert.deepEqual(updateOf({ _id: "x" }, { tags: { kind: "list", raw: [] } }, {})?.set, {
    tags: [],
  });
  assert.equal(
    updateOf({ _id: "x", tags: [] }, { tags: { kind: "list", raw: [] } }, {}),
    undefined,
  );
  assert.deepEqual(
    updateOf(customer, { "address.city": { kind: "text", raw: "Olinda" } }, {})?.update,
    { $set: { "address.city": "Olinda" } },
  );
  // `set` can give null, a value of its own.
  assert.deepEqual(updateOf(customer, { email: { kind: "set", raw: null } }, {})?.set, {
    email: null,
  });
});

test("parts' values are set, over an edit of the same field, never _id", () => {
  const change = updateOf(
    customer,
    { email: { kind: "text", raw: "" }, name: { kind: "text", raw: "Ana S" } },
    { email: "ana@example.com", file: "A.pdf", _id: "other", skipped: undefined },
  );
  assert.deepEqual(change, {
    set: { name: "Ana S", email: "ana@example.com", file: "A.pdf" },
    unset: [],
    update: { $set: { name: "Ana S", email: "ana@example.com", file: "A.pdf" } },
  });
});

test("R5: a new record is its defaults with the edits; a cleared default is left out", () => {
  const defaults = { since: "2026-11-25", city: "Recife", note: null, tags: [] as string[] };
  const values = createOf(defaults, {
    name: { kind: "text", raw: "Bo" },
    city: { kind: "value", raw: undefined },
    "address.city": { kind: "text", raw: "Olinda" },
    note: { kind: "text", raw: "" },
  }, { file: "A.pdf" });
  assert.deepEqual(values, {
    since: "2026-11-25",
    note: null,
    tags: [],
    name: "Bo",
    address: { city: "Olinda" },
    file: "A.pdf",
  });
  assert.deepEqual(defaults.city, "Recife");
});

test("a refusal: its field, the fields that hold it, and its words", () => {
  const refusal = Object.assign(new Error("customer: must be number (#/lines/0/qty)"), {
    detail: { field: "lines.0.qty" },
  });
  assert.equal(refusedField(refusal), "lines.0.qty");
  assert.equal(refusedField(new Error("no")), undefined);
  assert.equal(refusedField({ detail: { field: "" } }), undefined);
  assert.equal(refusedField({ detail: { field: 3 } }), undefined);
  assert.equal(refusedField(null), undefined);
  assert.ok(holds("lines", "lines.0.qty"));
  assert.ok(holds("lines.0.qty", "lines.0.qty"));
  assert.ok(!holds("line", "lines.0.qty"));
  assert.ok(related("lines.0.qty", "lines") && related("lines", "lines.0.qty"));
  assert.equal(
    refusalWords("lines.0.qty", refusal, { "lines.0.qty": "Give a quantity." }),
    "Give a quantity.",
  );
  assert.equal(
    refusalWords("lines.0.qty", refusal, { lines: "Check the lines." }),
    "Check the lines.",
  );
  assert.equal(refusalWords("lines.0.qty", refusal, {}), refusal.message);
  assert.equal(refusalWords(undefined, {}, {}), undefined);
});
