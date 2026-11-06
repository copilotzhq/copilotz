/**
 * Two people's changes to the same version, merged line by line (a
 * three-way merge): what each changed since the version both started from
 * (`base`), applied together where they don't touch the same lines. Where
 * they do (both changed a line, or added lines in the same place, or one
 * changed what the other took out), that part is a conflict: the base's
 * lines and each side's, for a person to choose between. Changes next to
 * each other, not over each other, merge. Pure, so the server merges a save
 * and the browser shows the same conflicts.
 */
import { type Hunk, hunksOf, linesOf } from "./diff.ts";

/** A part of the merge: lines both agree on, or a conflict between them. */
export type Chunk =
  | { kind: "same"; lines: string[] }
  | { kind: "conflict"; base: string[]; mine: string[]; theirs: string[] };

/** What merging came to: its parts, and, when nothing conflicts, the merged text. */
export type Merged = { chunks: Chunk[]; conflicts: number; text?: string };

type Sided = Hunk & { side: "mine" | "theirs" };

/** `base`'s lines `start` to `end`, with one side's hunks there applied. */
function applied(base: string[], start: number, end: number, hunks: Hunk[]): string[] {
  const out: string[] = [];
  let at = start;
  for (const h of hunks) {
    out.push(...base.slice(at, h.start), ...h.lines);
    at = h.end;
  }
  out.push(...base.slice(at, end));
  return out;
}

const equal = (a: string[], b: string[]) => a.length === b.length && a.every((l, i) => l === b[i]);

/** Merges `mine` and `theirs`, both changed from `base`. */
export function merge(base: string, mine: string, theirs: string): Merged {
  if (mine === theirs || theirs === base) return whole(mine);
  if (mine === base) return whole(theirs);
  const lines = linesOf(base);
  const all: Sided[] = [
    ...hunksOf(lines, linesOf(mine)).map((h): Sided => ({ ...h, side: "mine" })),
    ...hunksOf(lines, linesOf(theirs)).map((h): Sided => ({ ...h, side: "theirs" })),
  ].sort((a, b) => a.start - b.start || (a.end - a.start) - (b.end - b.start));
  // Changes that overlap go together: each group is a stretch of the base both may have changed.
  const groups: { start: number; end: number; hunks: Sided[] }[] = [];
  for (const h of all) {
    const last = groups.at(-1);
    const insertion = h.start === h.end;
    const over = last && (
      h.start < last.end ||
      // Two sides adding lines at the same place: which goes first is a choice.
      (insertion && last.start === last.end && h.start === last.start)
    );
    if (over) {
      last.end = Math.max(last.end, h.end);
      last.hunks.push(h);
    } else groups.push({ start: h.start, end: h.end, hunks: [h] });
  }
  const chunks: Chunk[] = [];
  const same = (more: string[]) => {
    if (!more.length) return;
    const last = chunks.at(-1);
    if (last?.kind === "same") last.lines.push(...more);
    else chunks.push({ kind: "same", lines: [...more] });
  };
  let at = 0;
  let conflicts = 0;
  for (const g of groups) {
    same(lines.slice(at, g.start));
    const of = (side: Sided["side"]) => g.hunks.filter((h) => h.side === side);
    const ours = applied(lines, g.start, g.end, of("mine"));
    const others = applied(lines, g.start, g.end, of("theirs"));
    const was = lines.slice(g.start, g.end);
    if (!of("theirs").length || equal(ours, others)) same(ours);
    else if (!of("mine").length) same(others);
    else {
      chunks.push({ kind: "conflict", base: was, mine: ours, theirs: others });
      conflicts++;
    }
    at = g.end;
  }
  same(lines.slice(at));
  return {
    chunks,
    conflicts,
    ...(conflicts ? {} : { text: textOf(chunks) }),
  };
}

const whole = (text: string): Merged => ({
  chunks: [{ kind: "same", lines: linesOf(text) }],
  conflicts: 0,
  text,
});

/** How a conflict is settled: one side, both (theirs first, then mine), or lines of one's own. */
export type Pick = "mine" | "theirs" | "both" | { lines: string[] };

/** The merged text, with each conflict settled as `picks` says (by its place among them). */
export function textOf(chunks: Chunk[], picks: Pick[] = []): string {
  const out: string[] = [];
  let n = 0;
  for (const c of chunks) {
    if (c.kind === "same") {
      out.push(...c.lines);
      continue;
    }
    const pick = picks[n++] ?? "mine";
    out.push(
      ...(pick === "mine"
        ? c.mine
        : pick === "theirs"
        ? c.theirs
        : pick === "both"
        ? [...c.theirs, ...c.mine]
        : pick.lines),
    );
  }
  return out.join("\n");
}

/**
 * A field merged the same way, whole: whichever side changed it wins; both,
 * to the same value, that value; both, differently, a conflict (undefined).
 */
export function mergeField<T>(base: T, mine: T, theirs: T): T | undefined {
  if (mine === theirs || theirs === base) return mine;
  if (mine === base) return theirs;
  return undefined;
}
