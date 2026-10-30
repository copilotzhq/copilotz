/**
 * The terminal's line, as you edit it (typing, moving, deleting, history,
 * Enter, Ctrl+C, a paste), how much room output takes on a line, a code
 * block's lines and tones, and sizes in words.
 */
import { assertEquals } from "@std/assert";
import { cells, edit, emptyLine, type Line, remember } from "../toolkit/line-editor.ts";
import { linesOf } from "../toolkit/code-lines.ts";
import { bytes } from "../toolkit/bytes.ts";
import { test } from "../../../testing/mod.ts";

/** The line after keys, one by one; what each came to, if it wasn't just typing. */
const keys = (line: Line, ...data: string[]) => {
  const happened: string[] = [];
  for (const key of data) {
    const edited = edit(line, key);
    line = edited.line;
    if (edited.happened) {
      happened.push(edited.entered ? `enter:${edited.entered}` : edited.happened);
    }
  }
  return { line, happened };
};

const LEFT = "\x1b[D";
const RIGHT = "\x1b[C";
const UP = "\x1b[A";
const DOWN = "\x1b[B";

test("typing, moving and deleting edit the line at the cursor", () => {
  let { line } = keys(emptyLine(), ..."echo hi");
  assertEquals([line.text, line.at], ["echo hi", 7]);
  ({ line } = keys(line, LEFT, LEFT, "\x7f", "X"));
  assertEquals([line.text, line.at], ["echoXhi", 5]);
  ({ line } = keys(line, "\x01", "\x1b[3~"));
  assertEquals([line.text, line.at], ["choXhi", 0]);
  ({ line } = keys(line, "\x05", "\x17"));
  assertEquals([line.text, line.at], ["", 0]);
  ({ line } = keys(emptyLine(), ..."git commit -m", "\x1bb", "\x1bb"));
  assertEquals(line.at, 4);
  ({ line } = keys(line, "\x0b"));
  assertEquals(line.text, "git ");
  ({ line } = keys(line, "\x15"));
  assertEquals([line.text, line.at], ["", 0]);
  // Nothing to delete, nowhere to go, nothing to complete: a beep, the line as it was.
  assertEquals(keys(emptyLine(), "\x7f", LEFT, RIGHT, "\t").happened, [
    "beep",
    "beep",
    "beep",
    "beep",
  ]);
  // Keys it doesn't know change nothing.
  assertEquals(keys(emptyLine(), "\x1b[15~", "\x00").line.text, "");
});

test("Enter enters the line and remembers it; ↑ and ↓ go through what was entered", () => {
  const first = keys(emptyLine(), ..."ls", "\r", ..."pwd", "\r", "\r");
  assertEquals(first.happened, ["enter:ls", "enter:pwd", "enter"]);
  assertEquals(first.line.history, ["ls", "pwd"]);
  // Back, and back again; past the oldest, a beep; the draft comes back at the end.
  const looked = keys(first.line, ..."ec", UP);
  assertEquals(looked.line.text, "pwd");
  const older = keys(looked.line, UP, UP);
  assertEquals([older.line.text, older.happened], ["ls", ["beep"]]);
  const again = keys(older.line, DOWN, DOWN);
  assertEquals([again.line.text, again.line.at], ["ec", 2]);
  assertEquals(keys(again.line, DOWN).happened, ["beep"]);
  // Not the same line twice in a row, nor a blank one.
  assertEquals(remember(remember(["ls"], "ls"), "  "), ["ls"]);
});

test("Ctrl+C drops the line, Ctrl+L clears, and a paste with line breaks is entered whole", () => {
  const stopped = keys(emptyLine(["ls"]), ..."sleep 9", "\x03");
  assertEquals([stopped.line.text, stopped.happened, stopped.line.history], ["", ["interrupt"], [
    "ls",
  ]]);
  assertEquals(keys(emptyLine(), "\x0c").happened, ["clear"]);
  const pasted = keys(emptyLine(), ..."cd x && ", "echo a\recho b\r");
  assertEquals(pasted.happened, ["enter:cd x && echo a\necho b"]);
  // On one line, it's typed (tabs as spaces).
  assertEquals(keys(emptyLine(), "a\tb").line.text, "a b");
});

test("output's room on a line: after its last carriage return, without colours", () => {
  assertEquals(cells("\x1b[1;34mpersonal\x1b[0m \x1b[90m$\x1b[39m "), 11);
  assertEquals(cells("50%\r60%"), 3);
  assertEquals(cells("Name: "), 6);
  assertEquals(cells("héllo ✓"), 7);
});

test("a code block's lines: parts split where lines break, a change's tone on its whole line", () => {
  assertEquals(linesOf(""), []);
  assertEquals(linesOf("a\nb\n"), [{ parts: [{ text: "a" }] }, { parts: [{ text: "b" }] }]);
  assertEquals(
    linesOf([{ text: "ok\npart" }, { text: "ial\nbad\n", tone: "error" }]),
    [
      { parts: [{ text: "ok" }] },
      { parts: [{ text: "part" }, { text: "ial", tone: "error" }] },
      { parts: [{ text: "bad", tone: "error" }], tone: "error" },
    ],
  );
  // A change's last line break ends it: no empty line of it after.
  assertEquals(linesOf([{ text: "a\n", tone: "added" }, { text: "b\n\n", tone: "added" }]), [
    { parts: [{ text: "a", tone: "added" }], tone: "added" },
    { parts: [{ text: "b", tone: "added" }], tone: "added" },
    { parts: [], tone: "added" },
  ]);
  assertEquals(linesOf([{ text: "\n", tone: "added" }, { text: "x", tone: "removed" }]), [
    { parts: [], tone: "added" },
    { parts: [{ text: "x", tone: "removed" }], tone: "removed" },
  ]);
});

test("sizes in words", () => {
  assertEquals([0, 812, 1024, 4300, 38_000, 1_700_000, 2.2e9].map(bytes), [
    "0 B",
    "812 B",
    "1.0 KB",
    "4.2 KB",
    "37 KB",
    "1.6 MB",
    "2.0 GB",
  ]);
});
