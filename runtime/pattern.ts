/**
 * Text patterns, for filters' `$regex`: the part of JavaScript's regular
 * expressions that every store reads alike, matched in time linear in the
 * text, whoever wrote the pattern.
 *
 * A pattern has characters and escapes (`\.`, `\t`, `é`, `\x41`), `.`,
 * classes (`[a-z]`, `[^0-9]`, `\d`, `\w`, `\s` and their negations), `^` and
 * `$` (the start and end of the value), groups (`(…)`, `(?:…)`), `|`, and
 * quantifiers (`*`, `+`, `?`, `{n}`, `{n,}`, `{n,m}`, lazy or not, up to 255).
 * It reads as JavaScript reads it with the `u` flag: by code points. Options
 * (`$options`): `i` ignores case, as JavaScript's `ui` flags fold it; `s` lets
 * `.` match line breaks too. Nothing else: no backreferences, lookarounds,
 * word boundaries or named groups, which one store's engine reads otherwise
 * than another's, or which take more than linear time. Those, a pattern that
 * doesn't parse, and one past the limits are refused, as `invalid`.
 *
 * A pattern is parsed once into sets of code points (a character, a class,
 * `.`), case folded there, and matched by a small automaton that reads each
 * character of the value once, never backtracking. The SQL stores use the
 * same sets: SQLite calls this matcher, and PostgreSQL gets them written in
 * its own syntax (stores/sql/postgres/pattern.ts).
 */
import { failure } from "./errors.ts";

/** Code points, as sorted, disjoint, inclusive ranges. */
export type CodePoints = [number, number][];

/** A pattern, parsed: what it matches, as data. */
export type PatternNode =
  | { kind: "set"; set: CodePoints }
  | { kind: "start" }
  | { kind: "end" }
  | { kind: "sequence"; items: PatternNode[] }
  | { kind: "either"; options: PatternNode[] }
  | { kind: "repeat"; node: PatternNode; min: number; max: number };

/** A checked pattern: its source and options as given, what it parsed to, and its matcher. */
export type Pattern = {
  source: string;
  options: string;
  node: PatternNode;
  /** Whether the pattern matches somewhere in `text`. */
  test(text: string): boolean;
};

/** The longest pattern, in UTF-16 code units. */
export const PATTERN_MOST = 512;
/** The most a quantifier repeats (`{n,m}`), as PostgreSQL's engine allows. */
const REPEAT_MOST = 255;
/** The most states a pattern makes: each may be visited once per character of a value. */
const STATES_MOST = 2_000;
/** The options every store honors. */
const OPTIONS = /^[is]*$/;

const LAST = 0x10ffff;
const ALL: CodePoints = [[0, LAST]];
/** Line breaks: what `.` doesn't match without `s`, as in JavaScript. */
const BREAKS: CodePoints = [[0x0a, 0x0a], [0x0d, 0x0d], [0x2028, 0x2029]];
const DIGITS: CodePoints = [[0x30, 0x39]];
const WORD: CodePoints = [[0x30, 0x39], [0x41, 0x5a], [0x5f, 0x5f], [0x61, 0x7a]];
/** JavaScript's `\s`: white space and line breaks. */
const SPACE: CodePoints = [
  [0x09, 0x0d],
  [0x20, 0x20],
  [0xa0, 0xa0],
  [0x1680, 0x1680],
  [0x2000, 0x200a],
  [0x2028, 0x2029],
  [0x202f, 0x202f],
  [0x205f, 0x205f],
  [0x3000, 0x3000],
  [0xfeff, 0xfeff],
];
const CONTROL: Record<string, number> = { t: 0x09, n: 0x0a, v: 0x0b, f: 0x0c, r: 0x0d };
/** What an escape may make literal: the characters that mean something in a pattern. */
const SYNTAX = new Set("^$\\.*+?()[]{}|/");

/** Ranges sorted and merged: touching or overlapping ones become one. */
export function merged(ranges: CodePoints): CodePoints {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  const out: CodePoints = [];
  for (const [lo, hi] of sorted) {
    const last = out.at(-1);
    if (last && lo <= last[1] + 1) last[1] = Math.max(last[1], hi);
    else out.push([lo, hi]);
  }
  return out;
}

/** Every code point the ranges don't have. */
export function complement(ranges: CodePoints): CodePoints {
  const out: CodePoints = [];
  let next = 0;
  for (const [lo, hi] of ranges) {
    if (lo > next) out.push([next, lo - 1]);
    next = hi + 1;
  }
  if (next <= LAST) out.push([next, LAST]);
  return out;
}

/** Whether the ranges have a code point (a binary search). */
export function holds(ranges: CodePoints, cp: number): boolean {
  let lo = 0, hi = ranges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (cp < ranges[mid][0]) hi = mid - 1;
    else if (cp > ranges[mid][1]) lo = mid + 1;
    else return true;
  }
  return false;
}

/** The last code point with a case: past it, nothing folds. */
const CASED_LAST = 0x1efff;
let folds: Map<number, number[]> | undefined;
let cased: number[] = [];

/**
 * Each cased code point's others: those JavaScript's `ui` flags fold it
 * together with (Unicode's simple case folding). Grouped by their upper
 * case's lower case, each checked with JavaScript's own, once, on first use.
 */
function foldsOf(): Map<number, number[]> {
  if (folds) return folds;
  const one = (s: string) => [...s].length === 1;
  const groups = new Map<string, number[]>();
  for (let cp = 0; cp <= CASED_LAST; cp++) {
    if (cp >= 0xd800 && cp <= 0xdfff) continue;
    const s = String.fromCodePoint(cp);
    const upper = s.toUpperCase();
    if (upper === s && s.toLowerCase() === s) continue;
    const base = one(upper) ? upper : s;
    const lower = base.toLowerCase();
    const key = one(lower) ? lower : base;
    const group = groups.get(key);
    if (group) group.push(cp);
    else groups.set(key, [cp]);
  }
  folds = new Map();
  for (const [key, group] of groups) {
    const first = key.codePointAt(0)!;
    const by = group.includes(first) ? first : group[0];
    const same = new RegExp(`^\\u{${by.toString(16)}}$`, "ui");
    const members = group.filter((cp) => cp === by || same.test(String.fromCodePoint(cp)));
    if (members.length < 2) continue;
    for (const cp of members) folds.set(cp, members.filter((other) => other !== cp));
  }
  cased = [...folds.keys()].sort((a, b) => a - b);
  return folds;
}

/** The ranges with every code point's case others added: what they match ignoring case. */
function fold(ranges: CodePoints): CodePoints {
  const others = foldsOf();
  const added: CodePoints = [];
  for (const [lo, hi] of ranges) {
    // The first cased code point at or after lo.
    let at = 0, end = cased.length;
    while (at < end) {
      const mid = (at + end) >> 1;
      if (cased[mid] < lo) at = mid + 1;
      else end = mid;
    }
    for (; at < cased.length && cased[at] <= hi; at++) {
      for (const cp of others.get(cased[at])!) added.push([cp, cp]);
    }
  }
  return added.length ? merged([...ranges, ...added]) : ranges;
}

const refuse = (source: string, why: string): never => {
  throw failure("invalid", `The pattern ${JSON.stringify(source.slice(0, 80))} ${why}.`, {
    public: true,
  });
};

/** Parses a pattern into code point sets, case folded with `i`; refuses what isn't in the subset. */
function parse(source: string, ignoreCase: boolean, dotAll: boolean): PatternNode {
  let i = 0;
  const fail = (why: string) => refuse(source, why);
  const folded = (ranges: CodePoints) => ignoreCase ? fold(ranges) : ranges;
  const word = () => folded(WORD);

  const hex = (digits: number) => {
    const text = source.slice(i, i + digits);
    if (!new RegExp(`^[0-9a-fA-F]{${digits}}$`).test(text)) fail("has an unfinished \\x or \\u");
    i += digits;
    return parseInt(text, 16);
  };
  /** What follows a backslash: one code point, or a class (`\d`…); in a class, `-` too. */
  const escape = (inClass: boolean): number | CodePoints => {
    i++;
    if (i >= source.length) fail("ends with a lone \\");
    const c = source[i++];
    if (c === "d") return DIGITS;
    if (c === "D") return complement(DIGITS);
    if (c === "w") return word();
    if (c === "W") return complement(word());
    if (c === "s") return SPACE;
    if (c === "S") return complement(SPACE);
    if (c in CONTROL) return CONTROL[c];
    if (c === "x") return hex(2);
    if (c === "u") {
      if (source[i] !== "{") {
        const unit = hex(4);
        if (unit >= 0xd800 && unit <= 0xdfff) fail("has half of a surrogate pair: write \\u{…}");
        return unit;
      }
      const end = source.indexOf("}", i);
      const text = source.slice(i + 1, end);
      if (end < 0 || !/^[0-9a-fA-F]{1,6}$/.test(text) || parseInt(text, 16) > LAST) {
        fail("has an escape \\u{…} that isn't a code point");
      }
      i = end + 1;
      return parseInt(text, 16);
    }
    if (SYNTAX.has(c) || (inClass && c === "-")) return c.codePointAt(0)!;
    if (c === "b" || c === "B") {
      return fail("asks for a word boundary (\\b), which stores read differently");
    }
    if (/[1-9k]/.test(c)) return fail("has a backreference, which takes more than linear time");
    return fail(`has an escape (\\${c}) the stores don't all read alike`);
  };
  const char = (): number => {
    const cp = source.codePointAt(i)!;
    i += cp > 0xffff ? 2 : 1;
    return cp;
  };
  const klass = (): CodePoints => {
    i++;
    const negated = source[i] === "^";
    if (negated) i++;
    const ranges: CodePoints = [];
    const member = () => source[i] === "\\" ? escape(true) : char();
    while (source[i] !== "]") {
      if (i >= source.length) fail("has a [ without its ]");
      const from = member();
      if (source[i] === "-" && source[i + 1] !== "]" && i + 1 < source.length) {
        i++;
        const to = member();
        if (typeof from !== "number" || typeof to !== "number") {
          fail("has a range with a class at one end (as [\\d-z])");
        }
        if (to < from) fail("has a range out of order");
        ranges.push([from as number, to as number]);
      } else if (typeof from === "number") ranges.push([from, from]);
      else ranges.push(...from);
    }
    i++;
    if (!ranges.length) fail("has an empty class ([] or [^]), which stores read differently");
    const set = folded(merged(ranges));
    return negated ? complement(set) : set;
  };
  const quantifier = (): { min: number; max: number } | undefined => {
    const c = source[i];
    if (c === "*") return i++, { min: 0, max: Infinity };
    if (c === "+") return i++, { min: 1, max: Infinity };
    if (c === "?") return i++, { min: 0, max: 1 };
    if (c !== "{") return undefined;
    const found = /^\{(\d+)(,(\d*))?\}/.exec(source.slice(i));
    if (!found) return fail("has a { that isn't a quantifier: write \\{");
    i += found[0].length;
    const min = Number(found[1]);
    const max = found[2] === undefined ? min : found[3] ? Number(found[3]) : Infinity;
    if (min > REPEAT_MOST || (max !== Infinity && max > REPEAT_MOST)) {
      fail(`repeats something more than ${REPEAT_MOST} times`);
    }
    if (max < min) fail("has a quantifier whose numbers are out of order");
    return { min, max };
  };
  const atom = (): PatternNode => {
    const c = source[i];
    if (c === "^") return i++, { kind: "start" };
    if (c === "$") return i++, { kind: "end" };
    if (c === ".") return i++, { kind: "set", set: dotAll ? ALL : complement(BREAKS) };
    if (c === "[") return { kind: "set", set: klass() };
    if (c === "(") {
      i++;
      if (source[i] === "?") {
        if (source[i + 1] !== ":") {
          fail("has a group other than (…) and (?:…): no lookarounds or named groups");
        }
        i += 2;
      }
      const inner = either();
      if (source[i] !== ")") fail("has a ( without its )");
      i++;
      return inner;
    }
    if (c === "*" || c === "+" || c === "?" || c === "{") {
      return fail("has a quantifier with nothing to repeat");
    }
    if (c === ")") return fail("has a ) without its (");
    if (c === "]" || c === "}") return fail(`has a lone ${c}: write \\${c}`);
    const one = c === "\\" ? escape(false) : char();
    return { kind: "set", set: typeof one === "number" ? folded([[one, one]]) : one };
  };
  const quantified = (): PatternNode => {
    const node = atom();
    const times = quantifier();
    if (!times) return node;
    if (node.kind === "start" || node.kind === "end") fail("repeats ^ or $");
    if (source[i] === "?") i++; // Lazy: it matches where greedy does.
    return { kind: "repeat", node, ...times };
  };
  const sequence = (): PatternNode => {
    const items: PatternNode[] = [];
    while (i < source.length && source[i] !== "|" && source[i] !== ")") items.push(quantified());
    return items.length === 1 ? items[0] : { kind: "sequence", items };
  };
  function either(): PatternNode {
    const options = [sequence()];
    while (source[i] === "|") {
      i++;
      options.push(sequence());
    }
    return options.length === 1 ? options[0] : { kind: "either", options };
  }

  const node = either();
  if (i < source.length) fail("has a ) without its (");
  return node;
}

type State =
  | { op: "set"; set: CodePoints; next: number }
  | { op: "split"; a: number; b: number }
  | { op: "start" | "end"; next: number }
  | { op: "match" };

/** The automaton: each state, and where it starts. */
function compile(source: string, node: PatternNode): { states: State[]; start: number } {
  const states: State[] = [];
  const add = (state: State) => {
    if (states.length >= STATES_MOST) {
      refuse(source, `makes more than ${STATES_MOST} states: repeat less, or less at a time`);
    }
    return states.push(state) - 1;
  };
  // Built backwards: each part is given where to go after it.
  const build = (node: PatternNode, next: number): number => {
    switch (node.kind) {
      case "set":
        return add({ op: "set", set: node.set, next });
      case "start":
      case "end":
        return add({ op: node.kind, next });
      case "sequence":
        return node.items.reduceRight((at, item) => build(item, at), next);
      case "either": {
        const entries = node.options.map((option) => build(option, next));
        return entries.reduceRight((b, a) => add({ op: "split", a, b }));
      }
      case "repeat": {
        let at = next;
        if (node.max === Infinity) {
          const loop = add({ op: "split", a: -1, b: next });
          (states[loop] as { a: number }).a = build(node.node, loop);
          at = loop;
        } else {
          for (let k = node.min; k < node.max; k++) {
            at = add({ op: "split", a: build(node.node, at), b: at });
          }
        }
        for (let k = 0; k < node.min; k++) at = build(node.node, at);
        return at;
      }
    }
  };
  const start = build(node, add({ op: "match" }));
  return { states, start };
}

/**
 * Whether the automaton matches somewhere in `text`: every thread moves on
 * together, a character at a time (a Pike VM), so a state is visited at
 * most once per character.
 */
function run(states: State[], start: number, text: string): boolean {
  const seen = new Uint32Array(states.length);
  let generation = 1;
  let current: number[] = [];
  let next: number[] = [];
  const stack: number[] = [];
  const add = (list: number[], from: number, atStart: boolean, atEnd: boolean) => {
    stack.push(from);
    while (stack.length) {
      const at = stack.pop()!;
      if (seen[at] === generation) continue;
      seen[at] = generation;
      const state = states[at];
      if (state.op === "split") stack.push(state.b, state.a);
      else if (state.op === "start") {
        if (atStart) stack.push(state.next);
      } else if (state.op === "end") {
        if (atEnd) stack.push(state.next);
      } else list.push(at);
    }
  };
  for (let i = 0;;) {
    // A match may start anywhere.
    add(current, start, i === 0, i === text.length);
    for (const at of current) if (states[at].op === "match") return true;
    if (i >= text.length) return false;
    const cp = text.codePointAt(i)!;
    const width = cp > 0xffff ? 2 : 1;
    generation++;
    next.length = 0;
    for (const at of current) {
      const state = states[at];
      if (state.op === "set" && holds(state.set, cp)) {
        add(next, state.next, false, i + width === text.length);
      }
    }
    [current, next] = [next, current];
    i += width;
  }
}

/** Patterns checked lately, by source and options: filters match many documents with one. */
const checked = new Map<string, Pattern>();
const CHECKED_MOST = 256;

/**
 * A `$regex` and its `$options`, checked and ready to match; else `invalid`,
 * saying why. Strings only: a pattern, at most `PATTERN_MOST` long, and
 * options of `i` and `s`.
 */
export function pattern(source: unknown, options: unknown = ""): Pattern {
  if (typeof source !== "string") {
    throw failure("invalid", '$regex takes a pattern as a string: { $regex: "^ana" }', {
      public: true,
    });
  }
  if (typeof options !== "string" || !OPTIONS.test(options)) {
    throw failure(
      "invalid",
      `$options are i (ignore case) and s (. matches line breaks), not ${JSON.stringify(options)}`,
      { public: true },
    );
  }
  const key = `${options}\u0000${source}`;
  const known = checked.get(key);
  if (known) return known;
  if (source.length > PATTERN_MOST) refuse(source, `is longer than ${PATTERN_MOST} characters`);
  const node = parse(source, options.includes("i"), options.includes("s"));
  const { states, start } = compile(source, node);
  const made: Pattern = { source, options, node, test: (text) => run(states, start, text) };
  checked.set(key, made);
  if (checked.size > CHECKED_MOST) checked.delete(checked.keys().next().value!);
  return made;
}
