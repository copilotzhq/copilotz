/**
 * What changed between two texts, line by line, as an edit shows it: the
 * lines both have, the lines that went (`removed`) and those that came
 * (`added`), in order, by the longest run of lines they share. Lines the
 * two share at either end are cut down to `context` of them around the
 * change (a `skipped` count says how many went unshown). Texts too big to
 * compare line by line show as all of one, then all of the other.
 */

export type DiffLine =
  | { text: string; tone?: "added" | "removed" }
  | { skipped: number };

/** As many line pairs as are compared; beyond that, it doesn't look for what they share. */
const MOST = 250_000;

const linesOf = (text: string) => text === "" ? [] : text.replace(/\n$/, "").split("\n");

export function lineDiff(before: string, after: string, context = 3): DiffLine[] {
  const a = linesOf(before);
  const b = linesOf(after);
  // What they share at the start and the end is set aside first.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let end = 0;
  while (
    end < a.length - start && end < b.length - start &&
    a[a.length - 1 - end] === b[b.length - 1 - end]
  ) end++;
  const x = a.slice(start, a.length - end);
  const y = b.slice(start, b.length - end);

  const middle: DiffLine[] = [];
  if (x.length * y.length > MOST) {
    middle.push(...x.map((text) => ({ text, tone: "removed" as const })));
    middle.push(...y.map((text) => ({ text, tone: "added" as const })));
  } else {
    // The longest run they share, from the end: lcs[i][j] for x[i..] and y[j..].
    const lcs = Array.from({ length: x.length + 1 }, () => new Array<number>(y.length + 1).fill(0));
    for (let i = x.length - 1; i >= 0; i--) {
      for (let j = y.length - 1; j >= 0; j--) {
        lcs[i][j] = x[i] === y[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < x.length || j < y.length) {
      if (i < x.length && j < y.length && x[i] === y[j]) {
        middle.push({ text: x[i++] });
        j++;
      } else if (j >= y.length || (i < x.length && lcs[i + 1][j] >= lcs[i][j + 1])) {
        // On a tie, what went comes before what came, as a change reads.
        middle.push({ text: x[i++], tone: "removed" });
      } else {
        middle.push({ text: y[j++], tone: "added" });
      }
    }
  }

  const head = a.slice(0, start);
  const tail = a.slice(a.length - end);
  const kept = (lines: string[], from: "start" | "end"): DiffLine[] => {
    if (lines.length <= context) return lines.map((text) => ({ text }));
    const shown = from === "start" ? lines.slice(-context) : lines.slice(0, context);
    const skipped: DiffLine = { skipped: lines.length - context };
    return from === "start"
      ? [skipped, ...shown.map((text) => ({ text }))]
      : [...shown.map((text) => ({ text })), skipped];
  };
  return [...kept(head, "start"), ...middle, ...kept(tail, "end")];
}
