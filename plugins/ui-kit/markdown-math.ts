/** KaTeX for Markdown, loaded on first use by `Markdown`. @module */
import rehypeKatex from "rehype-katex";
import type { Options } from "react-markdown";

type RehypePlugin = NonNullable<Options["rehypePlugins"]>[number];

/**
 * KaTeX's own HTML and fonts render the same everywhere; the MathML copy is
 * for assistive technology. `trust: false` refuses `\href`, `\url` and HTML
 * extensions, so math can never carry a link or markup.
 */
export const mathPlugin: RehypePlugin = [
  rehypeKatex,
  { output: "htmlAndMathml", throwOnError: false, trust: false },
];
