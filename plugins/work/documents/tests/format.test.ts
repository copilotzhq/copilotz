/**
 * What the editor's toolbar and shortcuts do to the text: marks on and
 * off, line kinds, links, lists going on with Enter and indenting with
 * Tab. A field is written with `[` and `]` where the selection is (one `|`
 * for a caret).
 */
import assert from "node:assert/strict";
import { test } from "../../../../testing/mod.ts";
import {
  applied,
  enter,
  type Field,
  heading,
  indent,
  lines,
  link,
  mark,
  pasted,
  wordsIn,
} from "../views/web/format.ts";

/** A field from text with its selection marked: "a [b] c", or "a|b". */
function field(marked: string): Field {
  const caret = marked.indexOf("|");
  if (caret >= 0) return { value: marked.replace("|", ""), start: caret, end: caret };
  const start = marked.indexOf("[");
  const end = marked.indexOf("]") - 1;
  return { value: marked.replace("[", "").replace("]", ""), start, end };
}

/** A field as text with its selection marked, the same way. */
function shown(f: Field): string {
  if (f.start === f.end) return f.value.slice(0, f.start) + "|" + f.value.slice(f.start);
  return f.value.slice(0, f.start) + "[" + f.value.slice(f.start, f.end) + "]" +
    f.value.slice(f.end);
}

const run = (marked: string, change: (f: Field) => ReturnType<typeof mark> | undefined) => {
  const f = field(marked);
  const c = change(f);
  return c ? shown(applied(f, c)) : undefined;
};

test("marks go around the selection, or the word at the caret, and come off again", () => {
  assert.equal(run("say [hello] there", (f) => mark(f, "bold")), "say **[hello]** there");
  assert.equal(run("say **[hello]** there", (f) => mark(f, "bold")), "say [hello] there");
  assert.equal(run("say [**hello**] there", (f) => mark(f, "bold")), "say [hello] there");
  assert.equal(run("say hel|lo there", (f) => mark(f, "italic")), "say _[hello]_ there");
  assert.equal(run("say | there", (f) => mark(f, "bold")), "say **|** there");
  assert.equal(run("a [ word ] b", (f) => mark(f, "code")), "a  `[word]`  b");
  assert.equal(run("x\n[one\ntwo]\ny", (f) => mark(f, "code")), "x\n```\n[one\ntwo]\n```\ny");
  assert.equal(run("[gone]", (f) => mark(f, "strike")), "~~[gone]~~");
});

test("line kinds go on every line the selection touches, and off when all have it", () => {
  assert.equal(run("[one\ntwo]", (f) => lines(f, "bullet")), "[- one\n- two]");
  assert.equal(run("[- one\n- two]", (f) => lines(f, "bullet")), "[one\ntwo]");
  assert.equal(run("[a\nb\nc]", (f) => lines(f, "number")), "[1. a\n2. b\n3. c]");
  assert.equal(run("- [a]", (f) => lines(f, "task")), "[- [ ] a]");
  assert.equal(run("Ti|tle", (f) => lines(f, "h2")), "## Ti|tle");
  assert.equal(run("## Ti|tle", (f) => lines(f, "plain")), "Ti|tle");
  assert.equal(run("|## Title", (f) => lines(f, "plain")), "|Title");
  assert.equal(run("[quote]", (f) => lines(f, "quote")), "[> quote]");
  // An empty line takes the mark, to type after.
  assert.equal(run("## Owners\n\n|", (f) => lines(f, "bullet")), "## Owners\n\n- |");
  assert.equal(run("|", (f) => lines(f, "task")), "- [ ] |");
  // A heading goes up a level each time, then back to text.
  let f = field("Ti|tle");
  const levels: string[] = [];
  for (let i = 0; i < 4; i++) {
    f = applied(f, heading(f));
    levels.push(f.value);
  }
  assert.deepEqual(levels, ["# Title", "## Title", "### Title", "Title"]);
});

test("links take the selection as their words, their address ready to type", () => {
  assert.equal(run("see [the docs] now", (f) => link(f)), "see [the docs]([https://]) now");
  assert.equal(run("see | now", (f) => link(f)), "see [[link]](https://) now");
  assert.equal(run("[https://a.b/c]", (f) => link(f)), "[|](https://a.b/c)");
  const f = field("read [this] first");
  assert.equal(
    shown(applied(f, pasted(f, " https://x.y/z ")!)),
    "read [this](https://x.y/z)| first",
  );
  assert.equal(pasted(f, "not a link"), undefined);
  assert.equal(pasted(field("read | first"), "https://x.y"), undefined);
});

test("Enter goes on with a list; on an empty item, the list ends", () => {
  assert.equal(run("- one|", enter), "- one\n- |");
  assert.equal(run("  * one|", enter), "  * one\n  * |");
  assert.equal(run("1. one|", enter), "1. one\n2. |");
  assert.equal(run("9) nine|", enter), "9) nine\n10) |");
  assert.equal(run("- [x] done|", enter), "- [x] done\n- [ ] |");
  assert.equal(run("> said|", enter), "> said\n> |");
  assert.equal(run("- one\n- |", enter), "- one\n|");
  assert.equal(run("  - |", enter), "  |");
  assert.equal(run("plain|", enter), undefined);
  assert.equal(run("- [one]", enter), undefined);
});

test("Tab indents list lines and Shift+Tab outdents them; elsewhere it's left alone", () => {
  assert.equal(run("- one\n- t|wo", (f) => indent(f)), "- one\n  - t|wo");
  assert.equal(run("  - t|wo", (f) => indent(f, true)), "- t|wo");
  assert.equal(run("[- a\n- b]", (f) => indent(f)), "[  - a\n  - b]");
  assert.equal(run("plain| text", (f) => indent(f)), undefined);
  assert.equal(run("- flat|", (f) => indent(f, true)), undefined);
});

test("words are counted as people count them", () => {
  assert.equal(wordsIn("# Launch plan\n\nShip the **beta** by Friday — it's 2026."), 9);
  assert.equal(wordsIn(""), 0);
});
