/**
 * Markdown's blocks, as agents write them: paragraphs, headings, fenced code,
 * math (`$$ … $$`, `\[ … \]`), lists (nested by indentation), quotes, rules
 * and tables. A safe subset, parsed from lines into data that `Markdown`
 * draws as React elements; a code block or formula still being written
 * (`open`) runs to the end.
 */
export type Block =
  | { type: "paragraph"; text: string }
  | { type: "heading"; level: number; text: string }
  | { type: "code"; lang: string; text: string; open: boolean }
  | { type: "math"; tex: string; open: boolean }
  | { type: "list"; ordered: boolean; start: number; items: Item[] }
  | { type: "quote"; blocks: Block[] }
  | { type: "rule" }
  | { type: "table"; head: string[]; align: Align[]; rows: string[][] };

export type Align = "left" | "center" | "right" | undefined;

/** A list item: its blocks, and for a task (\`[ ]\`, \`[x]\`), whether it's done. */
export type Item = { blocks: Block[]; done?: boolean };

const FENCE = /^ {0,3}(`{3,}|~{3,})[ \t]*([^`\s]*)/;
/** Display math opens a line: `$$` or `\[`; it closes with `$$` or `\]`. */
const MATH = /^ {0,3}(\$\$|\\\[)/;
const HEADING = /^ {0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/;
const RULE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const QUOTE = /^ {0,3}>[ ]?(.*)$/;
const ITEM = /^([ \t]*)([-*+]|\d{1,9}[.)])(?:[ \t]+(.*))?$/;
const DIVIDER = /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;

const indent = (line: string) => line.length - line.trimStart().length;
const blank = (line: string | undefined) => line === undefined || !line.trim();

/** A table starts here: a row of cells, then the line under it divides them. */
const table = (lines: string[], i: number) =>
  lines[i].includes("|") && i + 1 < lines.length && lines[i + 1].includes("|") &&
  DIVIDER.test(lines[i + 1]);

/** Whether line `i` begins a block other than a paragraph (which it then ends). */
const starts = (lines: string[], i: number) =>
  FENCE.test(lines[i]) || MATH.test(lines[i]) || HEADING.test(lines[i]) || RULE.test(lines[i]) ||
  QUOTE.test(lines[i]) || ITEM.test(lines[i]) || table(lines, i);

/** A table row's cells; `\|` is a pipe inside one. */
const cells = (line: string) => {
  let row = line.trim();
  if (row.startsWith("|")) row = row.slice(1);
  if (row.endsWith("|") && !row.endsWith("\\|")) row = row.slice(0, -1);
  return row.split(/(?<!\\)\|/).map((cell) => cell.trim().replaceAll("\\|", "|"));
};

export function blocks(text: string): Block[] {
  return parse(text.replace(/\r\n?/g, "\n").split("\n"));
}

function parse(lines: string[]): Block[] {
  const out: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (blank(line)) {
      i++;
      continue;
    }
    const fence = FENCE.exec(line);
    if (fence) {
      const [, mark, lang] = fence;
      const close = new RegExp(`^ {0,3}${mark[0] === "`" ? "`" : "~"}{${mark.length},}[ \\t]*$`);
      const body: string[] = [];
      let open = true;
      for (i++; i < lines.length; i++) {
        if (close.test(lines[i])) {
          open = false;
          i++;
          break;
        }
        body.push(lines[i]);
      }
      const shift = Math.min(indent(line), 3);
      out.push({
        type: "code",
        lang,
        text: body.map((l) => l.slice(Math.min(shift, indent(l)))).join("\n"),
        open,
      });
      continue;
    }
    const math = MATH.exec(line);
    if (math) {
      const end = math[1] === "$$" ? "$$" : "\\]";
      const first = line.trim().slice(2);
      const closes = first.indexOf(end);
      // On one line, with nothing after it; or over lines, its own: else it's in a paragraph.
      if (closes < 0 || !first.slice(closes + 2).trim()) {
        const body = [closes < 0 ? first : first.slice(0, closes)];
        let open = closes < 0;
        for (i++; open && i < lines.length; i++) {
          const at = lines[i].indexOf(end);
          body.push(at < 0 ? lines[i] : lines[i].slice(0, at));
          if (at >= 0) open = false;
        }
        out.push({ type: "math", tex: body.join("\n").trim(), open });
        continue;
      }
    }
    const heading = HEADING.exec(line);
    if (heading) {
      out.push({ type: "heading", level: heading[1].length, text: heading[2] });
      i++;
      continue;
    }
    if (RULE.test(line)) {
      out.push({ type: "rule" });
      i++;
      continue;
    }
    if (QUOTE.test(line)) {
      const inner: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i])) inner.push(QUOTE.exec(lines[i++])![1]);
      out.push({ type: "quote", blocks: parse(inner) });
      continue;
    }
    if (ITEM.test(line)) {
      i = list(lines, i, out);
      continue;
    }
    if (table(lines, i)) {
      const head = cells(line);
      const align = cells(lines[i + 1]).map((c): Align =>
        c.startsWith(":") && c.endsWith(":")
          ? "center"
          : c.endsWith(":")
          ? "right"
          : c.startsWith(":")
          ? "left"
          : undefined
      );
      const rows: string[][] = [];
      for (i += 2; i < lines.length && !blank(lines[i]) && lines[i].includes("|"); i++) {
        rows.push(cells(lines[i]));
      }
      out.push({ type: "table", head, align, rows });
      continue;
    }
    const paragraph = [line.trim()];
    for (i++; i < lines.length && !blank(lines[i]) && !starts(lines, i); i++) {
      paragraph.push(lines[i].trim());
    }
    out.push({ type: "paragraph", text: paragraph.join("\n") });
  }
  return out;
}

/** A list from line `i`: its items' lines, each parsed as blocks of its own. Returns where it ends. */
function list(lines: string[], i: number, out: Block[]): number {
  const first = ITEM.exec(lines[i])!;
  const base = first[1].length;
  const ordered = /\d/.test(first[2]);
  const items: { lines: string[]; inside: number }[] = [];
  while (i < lines.length) {
    const line = lines[i];
    const item = ITEM.exec(line);
    if (item && item[1].length <= base + 1 && /\d/.test(item[2]) === ordered) {
      items.push({ lines: [item[3] ?? ""], inside: item[1].length + item[2].length + 1 });
      i++;
      continue;
    }
    if (item && item[1].length <= base + 1) break; // A list of the other kind.
    const current = items[items.length - 1];
    if (blank(line)) {
      // A blank line ends the list unless what follows is still in it.
      let next = i + 1;
      while (next < lines.length && blank(lines[next])) next++;
      const after = lines[next];
      const sibling = after !== undefined && ITEM.exec(after);
      if (
        after === undefined ||
        !(indent(after) > base + 1 ||
          (sibling && sibling[1].length <= base + 1 && /\d/.test(sibling[2]) === ordered))
      ) break;
      current.lines.push("");
      i++;
      continue;
    }
    if (indent(line) > base + 1) {
      current.lines.push(line.slice(Math.min(indent(line), current.inside)));
      i++;
      continue;
    }
    // A line that carries on the item's text, unindented.
    if (!starts(lines, i) && !blank(current.lines[current.lines.length - 1])) {
      current.lines.push(line.trim());
      i++;
      continue;
    }
    break;
  }
  out.push({
    type: "list",
    ordered,
    start: ordered ? parseInt(first[2]) : 1,
    items: items.map((item): Item => {
      const task = /^\[([ xX])\][ \t]+/.exec(item.lines[0]);
      if (!task) return { blocks: parse(item.lines) };
      const lines = [item.lines[0].slice(task[0].length), ...item.lines.slice(1)];
      return { blocks: parse(lines), done: task[1] !== " " };
    }),
  });
  return i;
}
