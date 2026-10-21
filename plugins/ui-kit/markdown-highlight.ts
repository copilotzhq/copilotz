/** Code highlighting for Markdown, loaded on first use by `Markdown`. @module */
// @ts-types="./rehype-highlight.d.ts"
import rehypeHighlight from "rehype-highlight";
import type { Options } from "react-markdown";

type RehypePlugin = NonNullable<Options["rehypePlugins"]>[number];

/** Highlights fenced code by its declared language; nothing is guessed. */
export const highlightPlugin: RehypePlugin = [rehypeHighlight, {
  detect: false,
}];
