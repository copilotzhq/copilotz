/**
 * What a tags field adds (see tags-input.tsx): the tags in what was typed
 * or pasted, split at commas and line breaks, trimmed, each once, after
 * those already there.
 *
 * ```ts
 * withTags(["CODE128"], "EAN13, UPC-A,EAN13"); // ["CODE128", "EAN13", "UPC-A"]
 * ```
 */
export function withTags(values: readonly string[], text: string): string[] {
  const out = [...values];
  for (const piece of text.split(/[,\n\r]/)) {
    const tag = piece.trim();
    if (tag && !out.includes(tag)) out.push(tag);
  }
  return out;
}
