/**
 * Markdown inside a block: code, strong, emphasis, strikethrough, links (and
 * bare URLs), math, escapes, and line breaks (a chat's newlines are kept).
 * Links go only to the web (`http:`, `https:`), mail, or this app (`/…`);
 * any other shows as its text. Emphasis stays within a line.
 *
 * Math is `$…$` or `\(…\)` in a line, `$$…$$` or `\[…\]` on its own. A
 * dollar that's money stays text: `$…$` opens before a non-space, closes
 * after one, and not before a digit (so "$5 and $10" is two prices), and
 * `\$` is a dollar sign.
 */
export type Span =
  | { type: "text"; text: string }
  | { type: "code"; text: string }
  | { type: "strong" | "em" | "del"; children: Span[] }
  | { type: "link"; href: string; children: Span[] }
  | { type: "math"; tex: string; display: boolean }
  | { type: "break" };

const INLINE = new RegExp(
  [
    // 1, 2: code, between runs of backticks of the same length.
    /(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/u.source,
    // 3, 4: strong.
    /\*\*(?=\S)([^\n]*?\S)\*\*/u.source,
    /(?<![\p{L}\p{N}])__(?=\S)([^\n]*?\S)__(?![\p{L}\p{N}])/u.source,
    // 5: strikethrough.
    /~~(?=\S)([^\n]*?\S)~~/u.source,
    // 6, 7: emphasis.
    /\*(?=[^\s*])([^\n]*?[^\s*])\*(?!\*)/u.source,
    /(?<![\p{L}\p{N}_])_(?=[^\s_])([^\n]*?[^\s_])_(?![\p{L}\p{N}_])/u.source,
    // 8, 9: a link, [text](url "title").
    /\[([^\]\n]+)\]\(\s*<?([^)\s>]+)>?(?:\s+["'][^"'\n]*["'])?\s*\)/u.source,
    // 10: <https://…>.
    /<((?:https?:\/\/|mailto:)[^>\s]+)>/u.source,
    // 11: a bare URL, without the punctuation after it.
    /((?:https?:\/\/|www\.)[^\s<]*[^\s<.,:;"'!?)\]}*_~])/u.source,
    // 12, 13: math on its own, $$…$$ or \[…\].
    /\$\$([^$]+?)\$\$/u.source,
    /\\\[([\s\S]+?)\\\]/u.source,
    // 14, 15: math in a line, \(…\) or $…$.
    /\\\(([\s\S]+?)\\\)/u.source,
    /\$(?=[^\s$])([^$\n]*?[^\s$\\])\$(?!\d)/u.source,
    // 16: an escaped character.
    /\\([!-/:-@[-`{-~])/u.source,
    // 17: a line break.
    /(\n)/u.source,
  ].join("|"),
  "gu",
);

/** Where a link may go, or undefined: the web, mail, or a path in this app. */
export function safeHref(url: string): string | undefined {
  const href = url.trim();
  if (/^(?:https?:\/\/|mailto:)[^\s]+$/i.test(href)) return href;
  if (/^\/(?![/\\])[^\s]*$/.test(href)) return href;
  return undefined;
}

export function spans(text: string): Span[] {
  const out: Span[] = [];
  const push = (span: Span) => {
    const last = out[out.length - 1];
    if (span.type === "text" && last?.type === "text") last.text += span.text;
    else if (span.type !== "text" || span.text) out.push(span);
  };
  let at = 0;
  for (const m of text.matchAll(INLINE)) {
    push({ type: "text", text: text.slice(at, m.index) });
    at = m.index + m[0].length;
    if (m[1] !== undefined) {
      const code = m[2];
      push({ type: "code", text: /^ .* $/.test(code) && code.trim() ? code.slice(1, -1) : code });
    } else if (m[3] !== undefined || m[4] !== undefined) {
      push({ type: "strong", children: spans(m[3] ?? m[4]) });
    } else if (m[5] !== undefined) push({ type: "del", children: spans(m[5]) });
    else if (m[6] !== undefined || m[7] !== undefined) {
      push({ type: "em", children: spans(m[6] ?? m[7]) });
    } else if (m[8] !== undefined) {
      const href = safeHref(m[9]);
      if (href) push({ type: "link", href, children: spans(m[8]) });
      else for (const span of spans(m[8])) push(span);
    } else if (m[10] !== undefined) {
      push({ type: "link", href: m[10], children: [{ type: "text", text: m[10] }] });
    } else if (m[11] !== undefined) {
      const href = m[11].startsWith("www.") ? `https://${m[11]}` : m[11];
      push({ type: "link", href, children: [{ type: "text", text: m[11] }] });
    } else if (m[12] !== undefined || m[13] !== undefined) {
      push({ type: "math", tex: (m[12] ?? m[13]).trim(), display: true });
    } else if (m[14] !== undefined || m[15] !== undefined) {
      push({ type: "math", tex: (m[14] ?? m[15]).trim(), display: false });
    } else if (m[16] !== undefined) push({ type: "text", text: m[16] });
    else push({ type: "break" });
  }
  push({ type: "text", text: text.slice(at) });
  return out;
}
