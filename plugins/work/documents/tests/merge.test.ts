/**
 * Comparing and merging texts line by line: what a version says changed,
 * and the three-way merge two saves at once go through.
 */
import assert from "node:assert/strict";
import { test } from "../../../../testing/mod.ts";
import { changes, diffLines, hunksOf, linesOf } from "../shared/diff.ts";
import { merge, mergeField, textOf } from "../shared/merge.ts";
import { excerptOf } from "../shared/text.ts";

const lines = (...l: string[]) => l.join("\n");

/** Applies a diff's edits to `a`: it must give `b`. */
function replay(a: string[], b: string[]) {
  const edits = diffLines(a, b);
  const back = edits.filter((e) => e.kind !== "added").map((e) => e.text);
  const forth = edits.filter((e) => e.kind !== "removed").map((e) => e.text);
  assert.deepEqual(back, a);
  assert.deepEqual(forth, b);
  return edits;
}

test("a diff keeps what both have and is as short as it can be", () => {
  const a = linesOf(lines("a", "b", "c", "d", "e"));
  const b = linesOf(lines("a", "x", "c", "d", "e", "f"));
  const edits = replay(a, b);
  assert.equal(edits.filter((e) => e.kind !== "same").length, 3);
  assert.deepEqual(changes(a.join("\n"), b.join("\n")), { added: 2, removed: 1 });
  // Random texts both ways, so the walk back is right wherever the changes are.
  const alphabet = ["a", "b", "c", "d", ""];
  let seed = 7;
  const next = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (let round = 0; round < 300; round++) {
    const x = Array.from(
      { length: Math.floor(next() * 14) },
      () => alphabet[Math.floor(next() * 5)],
    );
    const y = Array.from(
      { length: Math.floor(next() * 14) },
      () => alphabet[Math.floor(next() * 5)],
    );
    replay(x, y);
  }
  assert.deepEqual(changes("", "one\ntwo"), { added: 2, removed: 0 });
  assert.deepEqual(changes("one\ntwo", ""), { added: 0, removed: 2 });
  assert.deepEqual(changes("same", "same"), { added: 0, removed: 0 });
});

test("hunks say which lines of the first text became what", () => {
  const hunks = hunksOf(
    linesOf(lines("a", "b", "c", "d")),
    linesOf(lines("a", "B", "c", "d", "e")),
  );
  assert.deepEqual(hunks, [{ start: 1, end: 2, lines: ["B"] }, { start: 4, end: 4, lines: ["e"] }]);
});

test("changes to different lines merge, both kept", () => {
  const base = lines("# Plan", "", "Goal: ship", "", "Risks: none", "", "Owner: ana");
  const mine = lines("# Plan", "", "Goal: ship the beta", "", "Risks: none", "", "Owner: ana");
  const theirs = lines(
    "# Plan",
    "",
    "Goal: ship",
    "",
    "Risks: none",
    "",
    "Owner: bob",
    "Due: Friday",
  );
  const merged = merge(base, mine, theirs);
  assert.equal(merged.conflicts, 0);
  assert.equal(
    merged.text,
    lines("# Plan", "", "Goal: ship the beta", "", "Risks: none", "", "Owner: bob", "Due: Friday"),
  );
});

test("changes to lines next to each other merge; to the same line, they conflict", () => {
  const base = lines("one", "two", "three");
  const next = merge(base, lines("ONE", "two", "three"), lines("one", "TWO", "three"));
  assert.equal(next.text, lines("ONE", "TWO", "three"));
  const same = merge(base, lines("one", "2", "three"), lines("one", "deux", "three"));
  assert.equal(same.conflicts, 1);
  assert.equal(same.text, undefined);
  assert.deepEqual(same.chunks, [
    { kind: "same", lines: ["one"] },
    { kind: "conflict", base: ["two"], mine: ["2"], theirs: ["deux"] },
    { kind: "same", lines: ["three"] },
  ]);
  // Settled by hand: each conflict one way.
  assert.equal(textOf(same.chunks, ["theirs"]), lines("one", "deux", "three"));
  assert.equal(textOf(same.chunks, ["both"]), lines("one", "deux", "2", "three"));
  assert.equal(textOf(same.chunks, [{ lines: ["two (2)"] }]), lines("one", "two (2)", "three"));
});

test("the same change on both sides is made once", () => {
  const base = lines("a", "b", "c");
  const both = lines("a", "B", "c", "d");
  assert.equal(merge(base, both, both).text, both);
  const partly = merge(base, lines("a", "B", "c"), lines("a", "B", "c", "d"));
  assert.equal(partly.text, lines("a", "B", "c", "d"));
});

test("lines added at the same place by both conflict; at different places, they merge", () => {
  const base = lines("a", "b");
  const clash = merge(base, lines("a", "mine", "b"), lines("a", "theirs", "b"));
  assert.equal(clash.conflicts, 1);
  const apart = merge(base, lines("first", "a", "b"), lines("a", "b", "last"));
  assert.equal(apart.text, lines("first", "a", "b", "last"));
  // Added just before a line the other changed: both, in order.
  const before = merge(base, lines("a", "new", "b"), lines("a", "B"));
  assert.equal(before.text, lines("a", "new", "B"));
});

test("a line one side took out and the other changed conflicts", () => {
  const base = lines("a", "b", "c");
  const merged = merge(base, lines("a", "c"), lines("a", "b!", "c"));
  assert.equal(merged.conflicts, 1);
  const chunk = merged.chunks.find((c) => c.kind === "conflict");
  assert.deepEqual(chunk, { kind: "conflict", base: ["b"], mine: [], theirs: ["b!"] });
});

test("one side unchanged, or both the same: the other side whole", () => {
  assert.equal(merge("x", "x", "y").text, "y");
  assert.equal(merge("x", "y", "x").text, "y");
  assert.equal(merge("x", "z", "z").text, "z");
  assert.equal(merge("", "mine", "").text, "mine");
  assert.equal(merge("", "", "theirs").text, "theirs");
  assert.equal(merge("", "mine", "theirs").conflicts, 1);
});

test("a title merges whole", () => {
  assert.equal(mergeField("Plan", "Plan v2", "Plan"), "Plan v2");
  assert.equal(mergeField("Plan", "Plan", "The plan"), "The plan");
  assert.equal(mergeField("Plan", "Same", "Same"), "Same");
  assert.equal(mergeField("Plan", "A", "B"), undefined);
});

test("a long document merges fast", () => {
  const base = Array.from({ length: 3000 }, (_, i) => `Line ${i}: ${"words ".repeat(5)}`);
  const mine = [...base];
  const theirs = [...base];
  for (let i = 0; i < 3000; i += 100) mine[i] = `${mine[i]} (mine)`;
  for (let i = 50; i < 3000; i += 100) theirs[i] = `${theirs[i]} (theirs)`;
  const started = performance.now();
  const merged = merge(base.join("\n"), mine.join("\n"), theirs.join("\n"));
  assert.equal(merged.conflicts, 0);
  assert.match(merged.text!, /Line 0: .* \(mine\)\nLine 1:/);
  assert.match(merged.text!, /Line 50: .* \(theirs\)/);
  assert.ok(performance.now() - started < 1000, "merging 3,000 lines took over a second");
  // Two texts with nothing in common: one change, replacing it all.
  const other = Array.from({ length: 3000 }, (_, i) => `Other ${i}`).join("\n");
  assert.deepEqual(changes(base.join("\n"), other), { added: 3000, removed: 3000 });
});

test("how a document opens, as plain words", () => {
  const text = lines(
    "# Launch plan",
    "",
    "**Goal:** ship the [beta](https://example.com) by *Friday*.",
    "",
    "- [ ] Write the `README`",
    "```ts",
    "const hidden = true;",
    "```",
    "> A quote",
  );
  assert.equal(
    excerptOf(text, "Launch plan"),
    "Goal: ship the beta by Friday. Write the README · A quote",
  );
  assert.equal(
    excerptOf("## Goal\n\nShip it.\n\n## Owners\n\n- Ana: the plan\n- Bob: the site", "Plan"),
    "Ship it. Ana: the plan · Bob: the site",
  );
  assert.equal(excerptOf("# Plan\n\n## Goal\n\n## Steps", "Plan"), "Goal · Steps");
  assert.equal(excerptOf("", "x"), "");
  assert.ok(excerptOf("word ".repeat(200)).length <= 220);
});
