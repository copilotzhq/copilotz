/**
 * Markdown, written: what the editor's toolbar and shortcuts do to the text
 * and its selection. Each takes the field as it is (its text, where the
 * selection starts and ends) and says what to replace (`from` to `to` with
 * `insert`) and what to select after, so the editor applies it as typing
 * would, and undo undoes it. Pure, so tested.
 *
 * - **Marks** around the selection (bold, italic, code, strikethrough),
 *   or around the word at the caret, or, with nothing there, an empty pair
 *   to type in; marked already, they come off.
 * - **Line kinds** on every line the selection touches (headings, lists,
 *   tasks, quotes); all of them that kind already, it comes off.
 * - **Links:** the selection as a link's text, with its address selected.
 * - **Enter** in a list goes on with it (the next number, an open task);
 *   on an empty item, the list ends. **Tab** in a list indents it, and
 *   Shift+Tab outdents.
 */

/** A text field as it is: its text, and the selection's start and end. */
export type Field = { value: string; start: number; end: number };

/** A change to a field: `from` to `to` becomes `insert`, then `select` is selected. */
export type Change = { from: number; to: number; insert: string; select: [number, number] };

/** A mark that goes around text. */
export type Mark = "bold" | "italic" | "code" | "strike";

const MARKS: Record<Mark, string> = { bold: "**", italic: "_", code: "`", strike: "~~" };

/** What a field becomes with a change made. */
export const applied = (field: Field, c: Change): Field => ({
  value: field.value.slice(0, c.from) + c.insert + field.value.slice(c.to),
  start: c.select[0],
  end: c.select[1],
});

const word = /[\p{L}\p{N}_'’-]/u;

/** Marks the selection (or the word at the caret), or takes the mark off what has it. */
export function mark(field: Field, kind: Mark): Change {
  const m = MARKS[kind];
  let { start, end } = field;
  const { value } = field;
  if (start === end) {
    // The word the caret is in.
    while (start > 0 && word.test(value[start - 1])) start--;
    while (end < value.length && word.test(value[end])) end++;
  }
  // Leading and trailing spaces stay outside the marks.
  while (start < end && /\s/.test(value[start])) start++;
  while (end > start && /\s/.test(value[end - 1])) end--;
  const inner = value.slice(start, end);
  const around = value.slice(start - m.length, start) === m &&
    value.slice(end, end + m.length) === m;
  if (around && inner) {
    return {
      from: start - m.length,
      to: end + m.length,
      insert: inner,
      select: [start - m.length, end - m.length],
    };
  }
  if (inner.length >= 2 * m.length && inner.startsWith(m) && inner.endsWith(m)) {
    const bare = inner.slice(m.length, -m.length);
    return { from: start, to: end, insert: bare, select: [start, start + bare.length] };
  }
  if (!inner) {
    const at = field.start;
    return { from: at, to: field.end, insert: m + m, select: [at + m.length, at + m.length] };
  }
  // A selection across lines: code becomes a block.
  if (kind === "code" && inner.includes("\n")) return fence(field);
  return {
    from: start,
    to: end,
    insert: m + inner + m,
    select: [start + m.length, end + m.length],
  };
}

/** The selection as a fenced code block, on lines of its own. */
export function fence(field: Field): Change {
  const { value } = field;
  const [from, to] = lineSpan(value, field.start, field.end);
  const inner = value.slice(from, to);
  const insert = "```\n" + inner + "\n```";
  return { from, to, insert, select: [from + 4, from + 4 + inner.length] };
}

/** Kinds a line may be. */
export type LineKind = "h1" | "h2" | "h3" | "bullet" | "number" | "task" | "quote" | "plain";

const PREFIX = /^(\s*)(#{1,6}\s+|>\s?|[-*+]\s+\[[ xX]\]\s+|[-*+]\s+|\d+[.)]\s+)?/;

/** What a line is, from how it starts. */
export function kindOf(line: string): LineKind {
  const p = line.match(PREFIX)?.[2] ?? "";
  if (/^#\s/.test(p)) return "h1";
  if (/^##\s/.test(p)) return "h2";
  if (/^#{3,6}\s/.test(p)) return "h3";
  if (/^>/.test(p)) return "quote";
  if (/^[-*+]\s+\[/.test(p)) return "task";
  if (/^[-*+]/.test(p)) return "bullet";
  if (/^\d/.test(p)) return "number";
  return "plain";
}

/** Where the lines the selection touches start and end. */
function lineSpan(value: string, start: number, end: number): [number, number] {
  const from = value.lastIndexOf("\n", start - 1) + 1;
  // A selection that ends at a line's start doesn't take that line.
  const last = end > start && value[end - 1] === "\n" ? end - 1 : end;
  const next = value.indexOf("\n", last);
  return [from, next < 0 ? value.length : next];
}

/** Makes every line the selection touches `kind` (numbered in order), or plain if all are. */
export function lines(field: Field, kind: LineKind): Change {
  const { value } = field;
  const [from, to] = lineSpan(value, field.start, field.end);
  const old = value.slice(from, to).split("\n");
  const said = old.filter((l) => l.trim());
  const off = kind !== "plain" && said.length > 0 && said.every((l) => kindOf(l) === kind);
  let n = 0;
  const made = old.map((line) => {
    const [, indent = "", prefix = ""] = line.match(PREFIX) ?? [];
    const rest = line.slice(indent.length + prefix.length);
    if (!line.trim() && old.length > 1) return line;
    if (off || kind === "plain") return indent + rest;
    n++;
    const marker = kind === "h1"
      ? "# "
      : kind === "h2"
      ? "## "
      : kind === "h3"
      ? "### "
      : kind === "quote"
      ? "> "
      : kind === "task"
      ? "- [ ] "
      : kind === "bullet"
      ? "- "
      : `${n}. `;
    return indent + marker + rest;
  });
  const insert = made.join("\n");
  // A caret stays before the same words; a selection takes the lines whole.
  if (field.start === field.end && old.length === 1) {
    const at = Math.max(from, from + insert.length - (to - field.start));
    return { from, to, insert, select: [at, at] };
  }
  return { from, to, insert, select: [from, from + insert.length] };
}

/** A heading that goes up a level each time: none, #, ##, ###, then none again. */
export function heading(field: Field): Change {
  const [from, to] = lineSpan(field.value, field.start, field.start);
  const kind = kindOf(field.value.slice(from, to));
  const next: LineKind = kind === "h1"
    ? "h2"
    : kind === "h2"
    ? "h3"
    : kind === "h3"
    ? "plain"
    : "h1";
  return lines(field, next);
}

/** The selection as a link's text (or a link to type), its address selected to type over. */
export function link(field: Field, href = "https://"): Change {
  const { value, start, end } = field;
  const text = value.slice(start, end);
  if (/^(https?:\/\/|mailto:|\/)\S*$/.test(text)) {
    const insert = `[](${text})`;
    return { from: start, to: end, insert, select: [start + 1, start + 1] };
  }
  const shown = text || "link";
  const insert = `[${shown}](${href})`;
  const at = start + shown.length + 3;
  return {
    from: start,
    to: end,
    insert,
    select: text ? [at, at + href.length] : [start + 1, start + 1 + shown.length],
  };
}

/** Pasting an address over selected words: they become its link. */
export function pasted(field: Field, clip: string): Change | undefined {
  const url = clip.trim();
  const text = field.value.slice(field.start, field.end);
  if (!text || text.includes("\n") || !/^(https?:\/\/|mailto:)\S+$/.test(url)) return undefined;
  const insert = `[${text}](${url})`;
  return {
    from: field.start,
    to: field.end,
    insert,
    select: [field.start + insert.length, field.start + insert.length],
  };
}

/** Enter in a list item: the next item, or the end of the list on an empty one. */
export function enter(field: Field): Change | undefined {
  const { value, start, end } = field;
  if (start !== end) return undefined;
  const from = value.lastIndexOf("\n", start - 1) + 1;
  const line = value.slice(from, start);
  const m = line.match(/^(\s*)(>\s?|[-*+]\s+\[[ xX]\]\s+|[-*+]\s+|(\d+)([.)])\s+)/);
  if (!m) return undefined;
  const [prefix, indent, , number, dot] = m;
  const eol = value.indexOf("\n", start);
  const rest = value.slice(start, eol < 0 ? value.length : eol);
  if (line.length === prefix.length && !rest.trim()) {
    // An empty item ends the list: its marks go.
    return {
      from,
      to: start,
      insert: indent,
      select: [from + indent.length, from + indent.length],
    };
  }
  const next = number !== undefined
    ? `${indent}${Number(number) + 1}${dot} `
    : /\[[ xX]\]/.test(prefix)
    ? `${indent}${prefix.trim()[0]} [ ] `
    : prefix;
  const insert = `\n${next}`;
  return { from: start, to: end, insert, select: [start + insert.length, start + insert.length] };
}

/** Tab in a list: its lines in by two spaces, or (`out`) back out. Elsewhere, nothing. */
export function indent(field: Field, out = false): Change | undefined {
  const { value } = field;
  const [from, to] = lineSpan(value, field.start, field.end);
  const old = value.slice(from, to).split("\n");
  if (!old.every((l) => !l.trim() || /^\s*([-*+]\s|\d+[.)]\s)/.test(l))) return undefined;
  const made = old.map((l) => out ? l.replace(/^ {1,2}/, "") : l.trim() ? `  ${l}` : l);
  const insert = made.join("\n");
  if (insert === old.join("\n")) return undefined;
  const firstShift = made[0].length - old[0].length;
  const caret = field.start === field.end && old.length === 1;
  return {
    from,
    to,
    insert,
    select: caret
      ? [Math.max(from, field.start + firstShift), Math.max(from, field.start + firstShift)]
      : [from, from + insert.length],
  };
}

/** How many words a text has. */
export const wordsIn = (text: string) => text.match(/[\p{L}\p{N}][\p{L}\p{N}'’_-]*/gu)?.length ?? 0;
