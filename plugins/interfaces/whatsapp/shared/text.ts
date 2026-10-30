/**
 * Agents write Markdown; WhatsApp shows its own: `*bold*`, `_italic_`,
 * `~strike~`, `` `code` ``, ``` blocks, `> quotes` and lists. Long replies
 * go as several messages, split where a reader would pause.
 */

/** The longest text WhatsApp takes in one message. */
export const LIMIT = 4096;

const FENCE = /```[\s\S]*?(?:```|$)/g;

/** Markdown outside code blocks, as WhatsApp formats it; inline code stays as it is. */
function prose(text: string): string {
  const code: string[] = [];
  const kept = text.replace(/`[^`\n]+`/g, (span) => `\uE002${code.push(span) - 1}\uE002`);
  return words(kept).replace(/\uE002(\d+)\uE002/g, (_, i) => code[Number(i)]);
}

function words(text: string): string {
  const BOLD = "\uE001";
  return text
    // Headings read as a bold line.
    .replace(/^ {0,3}#{1,6}[ \t]+(.+?)[ \t]*#*[ \t]*$/gm, `${BOLD}$1${BOLD}`)
    // Rules go; list bullets read as bullets.
    .replace(/^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/gm, "")
    .replace(/^([ \t]*)[-*+][ \t]+/gm, "$1• ")
    // Images and links: their words, then where they go.
    .replace(/!\[([^\]]*)\]\(([^)\s]+)[^)]*\)/g, (_, alt, url) => alt ? `${alt}: ${url}` : url)
    .replace(
      /\[([^\]]+)\]\(([^)\s]+)[^)]*\)/g,
      (_, words, url) => words === url || `mailto:${words}` === url ? url : `${words} (${url})`,
    )
    // Bold first (kept aside), then italics, then strikes.
    .replace(
      /\*\*(?=\S)([\s\S]*?\S)\*\*|__(?=\S)([\s\S]*?\S)__/g,
      (_, a, b) => `${BOLD}${a ?? b}${BOLD}`,
    )
    .replace(/(?<![\w*])\*(?=\S)([^*\n]*?\S)\*(?![\w*])/g, "_$1_")
    .replace(/~~(?=\S)([\s\S]*?\S)~~/g, "~$1~")
    .replaceAll(BOLD, "*")
    .replace(/[ \t]+$/gm, "");
}

/** An agent's Markdown, as WhatsApp shows it; code stays as it is. */
export function toWhatsApp(markdown: string): string {
  let out = "";
  let last = 0;
  for (const match of markdown.matchAll(FENCE)) {
    out += prose(markdown.slice(last, match.index));
    // A fence's language goes: WhatsApp shows the block in mono either way.
    out += match[0].replace(/^```[^\n]*\n/, "```\n");
    last = match.index! + match[0].length;
  }
  return (out + prose(markdown.slice(last))).replace(/\n{3,}/g, "\n\n").trim();
}

/** Where `pattern` last matches in `text` past `from`: the index just after it. */
function lastAfter(text: string, pattern: RegExp, from: number): number | undefined {
  let found: number | undefined;
  for (const match of text.matchAll(pattern)) {
    const end = match.index! + match[0].length;
    if (end >= from) found = end;
  }
  return found;
}

/**
 * Text in parts of at most `max` characters, each cut where a reader would
 * pause: between paragraphs, else lines, else sentences, else words (never
 * in less than half a part). A code block cut in two is closed and opened
 * again, so each part reads as it should.
 */
export function split(text: string, max = LIMIT): string[] {
  const parts: string[] = [];
  let rest = text.trim();
  // Room to close a code block, and open it again.
  const room = max - 4;
  while (rest.length > max) {
    const window = rest.slice(0, room);
    const half = Math.floor(room / 2);
    let at = lastAfter(window, /\n[ \t]*\n/g, half) ??
      lastAfter(window, /\n/g, half) ??
      lastAfter(window, /[.!?…]["')\]]*\s/g, half) ??
      lastAfter(window, /\s/g, half) ??
      room;
    // Never between the halves of a character outside the basic plane.
    if (/[\uD800-\uDBFF]/.test(rest[at - 1] ?? "")) at -= 1;
    let part = rest.slice(0, at).trimEnd();
    rest = rest.slice(at).trimStart();
    if ((part.match(/```/g) ?? []).length % 2 === 1) {
      part += "\n```";
      rest = "```\n" + rest;
    }
    parts.push(part);
  }
  if (rest) parts.push(rest);
  return parts;
}
