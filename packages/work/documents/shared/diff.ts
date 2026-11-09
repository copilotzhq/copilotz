/**
 * Texts compared line by line: which lines stayed, which were added and
 * which removed (Myers' algorithm, after the common start and end are set
 * aside), how many of each, and the changes as hunks of the first text.
 * Pure, so the server (versions, merges) and the browser (diffs, the
 * conflict screen) say the same thing.
 */

/** A text's lines: split where it breaks, so joining them with "\n" gives it back exactly. */
export const linesOf = (text: string): string[] => text.split("\n");

/** One line of a comparison: in both, only in the second (`added`), or only in the first. */
export type Edit = { kind: "same" | "added" | "removed"; text: string };

/** A change to the first text: its lines `start` to `end` (not included) became `lines`. */
export type Hunk = { start: number; end: number; lines: string[] };

/** Past this many differences, the middle counts as replaced whole: a diff stays fast and small. */
const MOST = 2000;

/**
 * The shortest way from `a` to `b`, line by line: the lines both keep, in
 * order, and what goes and comes between them.
 */
export function diffLines(a: string[], b: string[]): Edit[] {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const same = (from: string[], i: number, j: number) =>
    from.slice(i, j).map((text): Edit => ({ kind: "same", text }));
  return [
    ...same(a, 0, start),
    ...middle(a.slice(start, endA), b.slice(start, endB)),
    ...same(a, endA, a.length),
  ];
}

/** Myers' greedy diff of what differs, its lines compared as numbers. */
function middle(a: string[], b: string[]): Edit[] {
  const n = a.length;
  const m = b.length;
  if (!n) return b.map((text) => ({ kind: "added", text }));
  if (!m) return a.map((text) => ({ kind: "removed", text }));
  const ids = new Map<string, number>();
  const id = (line: string) => {
    let known = ids.get(line);
    if (known === undefined) ids.set(line, known = ids.size);
    return known;
  };
  const x = Int32Array.from(a, id);
  const y = Int32Array.from(b, id);
  const max = Math.min(n + m, MOST);
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  // Each round's furthest points, kept to walk back from the end.
  const trace: Int32Array[] = [];
  let found = -1;
  for (let d = 0; d <= max && found < 0; d++) {
    trace.push(v.slice(offset - d - 1, offset + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let i = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])
        ? v[offset + k + 1]
        : v[offset + k - 1] + 1;
      let j = i - k;
      while (i < n && j < m && x[i] === y[j]) {
        i++;
        j++;
      }
      v[offset + k] = i;
      if (i >= n && j >= m) {
        found = d;
        break;
      }
    }
  }
  if (found < 0) {
    return [
      ...a.map((text): Edit => ({ kind: "removed", text })),
      ...b.map((text): Edit => ({ kind: "added", text })),
    ];
  }
  // Walk back through the rounds, from the end to the start.
  const out: Edit[] = [];
  let i = n;
  let j = m;
  for (let d = found; d > 0; d--) {
    const before = trace[d];
    // `before` holds round d's starting points: diagonals -d-1 … d+1 of the round before.
    const at = (k: number) => before[k + d + 1];
    const k = i - j;
    const down = k === -d || (k !== d && at(k - 1) < at(k + 1));
    const prevK = down ? k + 1 : k - 1;
    const prevI = at(prevK);
    const prevJ = prevI - prevK;
    while (i > prevI + (down ? 0 : 1) && j > prevJ + (down ? 1 : 0)) {
      out.push({ kind: "same", text: a[--i] });
      j--;
    }
    if (down) out.push({ kind: "added", text: b[--j] });
    else out.push({ kind: "removed", text: a[--i] });
  }
  while (i > 0 && j > 0) {
    out.push({ kind: "same", text: a[--i] });
    j--;
  }
  return out.reverse();
}

/** How many lines a change added and removed. */
export function counted(edits: Edit[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const e of edits) {
    if (e.kind === "added") added++;
    else if (e.kind === "removed") removed++;
  }
  return { added, removed };
}

/** How many lines `after` adds to `before`, and how many it takes away (an empty text has none). */
export const changes = (before: string, after: string) =>
  before === after
    ? { added: 0, removed: 0 }
    : counted(diffLines(before ? linesOf(before) : [], after ? linesOf(after) : []));

/** The changes from `a` to `b` as hunks of `a`, in order, none touching another. */
export function hunksOf(a: string[], b: string[]): Hunk[] {
  const hunks: Hunk[] = [];
  let at = 0;
  let open: Hunk | undefined;
  for (const e of diffLines(a, b)) {
    if (e.kind === "same") {
      if (open) hunks.push(open);
      open = undefined;
      at++;
      continue;
    }
    open ??= { start: at, end: at, lines: [] };
    if (e.kind === "removed") {
      at++;
      open.end = at;
    } else open.lines.push(e.text);
  }
  if (open) hunks.push(open);
  return hunks;
}
