/**
 * Local types for `rehype-highlight`. Its own types reference the DOM lib
 * through highlight.js, which would change global types for every module
 * checked alongside the kit.
 * @module
 */
/** Highlights `language-*` code blocks; never guesses a language when `detect` is false. */
declare function rehypeHighlight(
  options?: { detect?: boolean; ignoreMissing?: boolean },
): (tree: unknown) => void;
export default rehypeHighlight;
