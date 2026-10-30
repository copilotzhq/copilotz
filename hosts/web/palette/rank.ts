/**
 * How well a palette item fits what's typed, and where in its label: every
 * word typed must be found (any case, any accents), best at the start of the
 * label, then at the start of one of its words, then anywhere in it, then
 * its letters in order ("nchat" finds "New chat"); in its other words
 * (`keywords`: what a chat said) it counts for less. 0 is no fit.
 */

/** Text folded for matching (no case, no accents), with where each folded character came from. */
export function fold(text: string): { text: string; at: number[] } {
  let folded = "";
  const at: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const part = text[i].normalize("NFKD").replace(/\p{M}/gu, "").toLocaleLowerCase();
    for (const c of part) {
      folded += c;
      at.push(i);
    }
  }
  return { text: folded, at };
}

/** The words typed, folded. */
const wordsOf = (search: string) => fold(search).text.split(/\s+/).filter(Boolean);

/** Whether `at` starts a word in `text`. */
const starts = (text: string, at: number) => at === 0 || !/[\p{L}\p{N}]/u.test(text[at - 1]);

/** Where `word` starts a word of `text`, or -1. */
function boundary(text: string, word: string): number {
  for (let at = text.indexOf(word); at >= 0; at = text.indexOf(word, at + 1)) {
    if (starts(text, at)) return at;
  }
  return -1;
}

/** Where `word`'s letters are, in order, in `text` (close together), or undefined. */
function letters(text: string, word: string): number[] | undefined {
  const found: number[] = [];
  let from = 0;
  for (const c of word) {
    const at = text.indexOf(c, from);
    if (at < 0) return undefined;
    found.push(at);
    from = at + 1;
  }
  // Spread too thin, it isn't what was meant.
  return found[found.length - 1] - found[0] < word.length * 3 ? found : undefined;
}

/** How well one word fits a label. */
function wordInLabel(label: string, word: string): number {
  if (label === word) return 100;
  if (label.startsWith(word)) return 90;
  if (boundary(label, word) >= 0) return 70;
  if (label.includes(word)) return 50;
  return word.length > 1 && letters(label, word) ? 20 : 0;
}

/** How well one word fits the other words an item is found by. */
function wordInKeywords(keywords: string, word: string): number {
  if (boundary(keywords, word) >= 0) return 35;
  return keywords.includes(word) ? 25 : 0;
}

/** How well an item fits what's typed: 0 for not at all; with nothing typed, everything fits alike. */
export function rank(search: string, label: string, keywords: string[] = []): number {
  const words = wordsOf(search);
  if (!words.length) return 1;
  const name = fold(label).text;
  const more = fold(keywords.join(" \u0000 ")).text;
  let total = 0;
  for (const word of words) {
    const fit = Math.max(wordInLabel(name, word), wordInKeywords(more, word));
    if (!fit) return 0;
    total += fit;
  }
  const whole = words.join(" ");
  // What's typed, as it's typed, at the start: what was meant. Shorter labels fit closer.
  const bonus = name.startsWith(whole) ? 10 : 0;
  return total / words.length + bonus - Math.min(9, name.length / 20);
}

/** Where what's typed is in a label, as `[start, end)` ranges of it, in order, for showing. */
export function hits(search: string, label: string): [number, number][] {
  const words = wordsOf(search);
  if (!words.length) return [];
  const { text, at } = fold(label);
  const marked = new Set<number>();
  for (const word of words) {
    let start = boundary(text, word);
    if (start < 0) start = text.indexOf(word);
    const found = start >= 0
      ? Array.from({ length: word.length }, (_, i) => start + i)
      : letters(text, word) ?? [];
    for (const i of found) marked.add(at[i]);
  }
  const ranges: [number, number][] = [];
  for (const i of [...marked].sort((a, b) => a - b)) {
    const last = ranges[ranges.length - 1];
    if (last && last[1] === i) last[1] = i + 1;
    else ranges.push([i, i + 1]);
  }
  return ranges;
}
