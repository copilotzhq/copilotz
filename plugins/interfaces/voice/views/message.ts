/**
 * A chat message on the phone (the `message` View, medium `voice`): its
 * words as they're said aloud. Agents write Markdown, so its marks go (bold,
 * headings, bullets, code), a link says its words, a web address its site,
 * and pictographs (emoji) go; a line that ends without a stop gets one, so
 * the voice pauses there. Files aren't said. It also says what an agent is
 * writing, as it writes (`{ text }`): each word comes out the same once
 * it's whole, so what's said of it never changes. An app says its messages
 * otherwise with a `message` View of its own in this medium (the last
 * plugin's wins), keeping to that.
 */
import type { ViewContext } from "../../../../runtime/mod.ts";

export const messageView = (m: { text?: string }, _ctx: ViewContext): string =>
  spoken(m.text ?? "");

/** One word, as said: no Markdown marks, a link's words, a web address's site. */
function word(w: string): string {
  const site = /^<?(?:https?:\/\/)(?:www\.)?([^/\s<>]+)[^\s<>]*>?([.,;:!?)]*)$/i.exec(w);
  if (site) return site[1] + site[2];
  return w
    // A link's address: `[words](https://…)` says its words.
    .replace(/\]\([^)\s]*\)/g, "")
    .replace(/^!?\[/, "")
    .replace(/[*`~]+/g, "")
    .replace(/^_+|_+(?=[.,;:!?)]*$)/g, "")
    .replace(/\p{Extended_Pictographic}️?/gu, "");
}

/** Markdown, as it's said aloud (see above). */
export function spoken(markdown: string): string {
  const lines = markdown.split("\n").map((line) =>
    line
      // Headings, quotes, bullets and rules: their words only.
      .replace(/^\s{0,3}(?:#{1,6}|>+|[-*+•])\s+/, "")
      .replace(/^\s*(?:[-*_]\s*){3,}$/, "")
      .split(/(\s+)/).map((part) => /\s/.test(part) ? " " : word(part)).join("")
      // A space stays once it's there (it may have been said): a word gone leaves its space.
      .replace(/ {2,}/g, " ").trimStart()
  );
  let said = "";
  for (const [i, line] of lines.entries()) {
    const last = i === lines.length - 1;
    if (!line.trim()) {
      if (!last && said && !/\s$/.test(said)) said += " ";
      continue;
    }
    said += line;
    if (last) break;
    // A line's end is a pause: a stop, unless it has one (only once the next line shows).
    const stops = /[.!?:;,…]\s*$/.test(line);
    said += stops ? (/\s$/.test(line) ? "" : " ") : ". ";
  }
  // Nothing after its last word: a word still being written is said once whole.
  return said.trimEnd();
}
