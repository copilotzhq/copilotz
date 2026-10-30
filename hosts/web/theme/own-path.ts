/**
 * A path on the app's own origin, as a theme may name one (its fonts'
 * stylesheet, a font to preload, a logo's image): it starts with one `/` and
 * has no `..` (nor dots, slashes or backslashes encoded), and nothing in it
 * can end the attribute it goes in: no spaces, quotes, `<`, `>` or `\`.
 * Anything else is undefined.
 */
export function ownPath(url: unknown): string | undefined {
  if (typeof url !== "string" || /[\s"'<>\\]/.test(url)) return undefined;
  return /^\/(?!\/)/.test(url) && !url.includes("..") && !/%(?:2e|2f|5c)/i.test(url)
    ? url
    : undefined;
}
