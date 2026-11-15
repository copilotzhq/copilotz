/**
 * A checked pattern (runtime/pattern.ts) in PostgreSQL's own syntax, its
 * advanced regular expressions, matching what the reference matches. Every
 * character, class and `.` is written as the code points it stands for, so
 * nothing depends on the database's locale (case folding is in them, as the
 * reference folded it), and groups capture nothing.
 */
import {
  type CodePoints,
  complement,
  merged,
  type Pattern,
  type PatternNode,
} from "../../../runtime/pattern.ts";

/** What PostgreSQL's text never holds: NUL and the surrogates. Matching them or not is the same. */
const UNHELD: CodePoints = [[0, 0], [0xd800, 0xdfff]];

/** Matches nothing PostgreSQL's text holds: only NUL. */
const NOTHING = "[^\\u0001-\\U0010ffff]";

/** The code points of `ranges` that aren't in `other`. */
const without = (ranges: CodePoints, other: CodePoints) =>
  complement(merged([...complement(ranges), ...other]));

/** One code point: a letter or digit as it is, ASCII punctuation escaped, the rest by number. */
function char(cp: number): string {
  if (/[0-9A-Za-z]/.test(String.fromCodePoint(cp))) return String.fromCodePoint(cp);
  if (cp >= 0x20 && cp <= 0x7e) return `\\${String.fromCodePoint(cp)}`;
  const hex = cp.toString(16);
  return cp > 0xffff ? `\\U${hex.padStart(8, "0")}` : `\\u${hex.padStart(4, "0")}`;
}

const listed = (ranges: CodePoints) =>
  ranges.map(([lo, hi]) =>
    lo === hi ? char(lo) : hi === lo + 1 ? char(lo) + char(hi) : `${char(lo)}-${char(hi)}`
  ).join("");

/** A set of code points: one character, a bracket, or the shorter bracket of what it leaves out. */
function set(ranges: CodePoints): string {
  const held = without(ranges, UNHELD);
  if (!held.length) return NOTHING;
  if (held.length === 1 && held[0][0] === held[0][1]) return char(held[0][0]);
  const out = without(complement(held), UNHELD);
  if (!out.length) return ".";
  return out.length < held.length ? `[^${listed(out)}]` : `[${listed(held)}]`;
}

function quantifier(min: number, max: number): string {
  if (max === Infinity) return min === 0 ? "*" : min === 1 ? "+" : `{${min},}`;
  if (min === 0 && max === 1) return "?";
  return min === max ? `{${min}}` : `{${min},${max}}`;
}

function write(node: PatternNode): string {
  switch (node.kind) {
    case "set":
      return set(node.set);
    case "start":
      return "^";
    case "end":
      return "$";
    case "sequence":
      return node.items.length ? node.items.map(write).join("") : "(?:)";
    case "either":
      return `(?:${node.options.map(write).join("|")})`;
    case "repeat": {
      const inner = write(node.node);
      return (node.node.kind === "set" ? inner : `(?:${inner})`) +
        quantifier(node.min, node.max);
    }
  }
}

const written = new WeakMap<Pattern, string>();

/** The pattern as PostgreSQL's `~` reads it (in its default, not newline-sensitive, mode). */
export function postgresPattern(pattern: Pattern): string {
  let text = written.get(pattern);
  if (text === undefined) written.set(pattern, text = write(pattern.node));
  return text;
}
