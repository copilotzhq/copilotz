/**
 * A page's readable text: its title, the main text without scripts, styles
 * or navigation, and its links. A small tag scanner, not a DOM: pages are
 * read for what they say, and the web runs in Deno, Node, Bun and workerd.
 */

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  rsquo: "’",
  lsquo: "‘",
  rdquo: "”",
  ldquo: "“",
  copy: "©",
};

export function decode(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
    if (name[0] === "#") {
      const code = name[1].toLowerCase() === "x" ? parseInt(name.slice(2), 16) : +name.slice(1);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
    }
    return ENTITIES[name.toLowerCase()] ?? whole;
  });
}

/** Elements whose content is never text for a reader. */
const DROP = "script|style|noscript|template|svg|iframe|object|embed|canvas|head|select|button";
/** Elements that are a page's furniture, not its text. */
const CHROME = "nav|header|footer|aside|form|dialog";
const BLOCK =
  "p|div|section|article|main|li|ul|ol|table|tr|h[1-6]|br|hr|blockquote|pre|figure|figcaption|dt|dd|dl|details|summary";

/** Removes `<tag …>…</tag>` for these tags, nested ones too (innermost first). */
function without(html: string, tags: string): string {
  const pair = new RegExp(`<(${tags})\\b[^>]*>(?:(?!<(?:${tags})\\b)[\\s\\S])*?</\\1\\s*>`, "gi");
  let previous;
  do {
    previous = html;
    html = html.replace(pair, " ");
  } while (html !== previous);
  // An opening tag never closed would swallow nothing, but its stray tag goes with the rest.
  return html;
}

export type Readable = { title: string; text: string; links: { text: string; url: string }[] };

export function readable(html: string, base: URL): Readable {
  const title = decode(/<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? "").replace(
    /\s+/g,
    " ",
  )
    .trim();
  let body = html.replace(/<!--[\s\S]*?-->/g, " ").replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, " ");
  body = without(body, DROP.replace("|head", ""));
  body = body.replace(/<head\b[\s\S]*?<\/head\s*>/i, " ");
  // The main content when the page says which it is; else the page without its furniture.
  const main = /<(main|article)\b[^>]*>([\s\S]*)<\/\1\s*>/i.exec(body);
  if (main && main[2].replace(/<[^>]*>/g, "").trim().length > 200) body = main[2];
  else body = without(body, CHROME);

  const links: Readable["links"] = [];
  const seen = new Set<string>();
  body = body.replace(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi, (_, attrs: string, inner: string) => {
    const label = decode(inner.replace(/<[^>]*>/g, "")).replace(/\s+/g, " ").trim();
    const href = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrs);
    const raw = href && decode(href[1] ?? href[2] ?? href[3] ?? "").trim();
    if (raw && label && !/^(#|javascript:|mailto:|tel:|data:)/i.test(raw)) {
      try {
        const url = new URL(raw, base);
        if (/^https?:$/.test(url.protocol)) {
          url.hash = "";
          if (!seen.has(url.href) && links.length < 40) {
            seen.add(url.href);
            links.push({ text: label.slice(0, 100), url: url.href });
          }
        }
      } catch { /* not a link */ }
    }
    return inner;
  });

  const text = decode(
    body
      .replace(new RegExp(`</?(?:${BLOCK})\\b[^>]*>`, "gi"), "\n")
      .replace(/<[^>]*>/g, ""),
  )
    .replace(/[ \t\f\v ]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { title, text, links };
}
