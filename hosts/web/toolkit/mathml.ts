/**
 * TeX as MathML, with Temml (given: it loads when first needed, see
 * `temml.ts`): what a formula draws. Temml runs untrusted: no
 * links, classes, styles or ids from the TeX (`trust: false`), bounded
 * macro expansion and sizes, so a formula draws only math, and TeX it can't
 * read says why instead.
 */
import type { Temml } from "./temml.ts";

/** The MathML for `tex`, or why there's none. */
export function mathml(
  temml: Temml,
  tex: string,
  display: boolean,
): { mathml: string } | { error: string } {
  try {
    return {
      mathml: temml.renderToString(tex, {
        displayMode: display,
        throwOnError: true,
        trust: false,
        maxExpand: 1000,
        // Absolute sizes (a \rule, a \hspace) at most 4 inches, in points.
        maxSize: [Infinity, 288],
      }),
    };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}
