/**
 * Markdown as React elements, for what agents write: the safe subset that
 * `blocks` and `spans` read (headings, lists and tasks, quotes, code with a
 * copy button, tables, links, emphasis, math). Everything is text React
 * escapes, but for math, which is the MathML Temml writes from untrusted TeX
 * (see `Formula`); links go only to the web, mail or the app (`safeHref`),
 * and open in a new tab when they leave it. While a reply is being written
 * (`streaming`), a caret ends it.
 */
import { type ReactNode, useMemo } from "react";
import { Checkbox } from "../checkbox.tsx";
import { CopyButton } from "../copy-button.tsx";
import { cx } from "../cx.ts";
import { Formula } from "../formula.tsx";
import { sheet } from "../sheet.tsx";
import { type Block, blocks } from "./blocks.ts";
import { type Span, spans } from "./spans.ts";

const SHEET = sheet(
  "markdown",
  `
.copilotz-md { line-height: 1.65; overflow-wrap: anywhere; }
.copilotz-md > :first-child { margin-top: 0; }
.copilotz-md > :last-child { margin-bottom: 0; }
.copilotz-md p { margin: 0 0 .8em; }
.copilotz-md :is(h3, h4, h5, h6) { margin: 1.3em 0 .45em; line-height: 1.3; font-weight: 650; letter-spacing: -.01em; }
.copilotz-md h3 { font-size: 1.22em; }
.copilotz-md h4 { font-size: 1.1em; }
.copilotz-md h5 { font-size: 1em; }
.copilotz-md h6 { font-size: .95em; color: var(--secondary-foreground); }
.copilotz-md :is(ul, ol) { margin: 0 0 .8em; padding-left: 1.45em; }
.copilotz-md li { margin: .25em 0; padding-left: .15em; }
.copilotz-md li > p { margin: 0; }
.copilotz-md li > :is(ul, ol) { margin: .25em 0 .1em; }
.copilotz-md li::marker { color: var(--muted-foreground); }
.copilotz-md li.copilotz-md-task { list-style: none; display: flex; gap: 9px; margin-left: -1.4em; }
.copilotz-md-task > .copilotz-checkbox { margin-top: .12em; }
.copilotz-md-task > div { min-width: 0; }
.copilotz-md-task > div > p { margin: 0; }
.copilotz-md a { color: var(--primary-text); text-decoration: underline; text-decoration-thickness: 1px;
  text-underline-offset: 2px; text-decoration-color: color-mix(in oklab, currentColor 45%, transparent); }
.copilotz-md a:hover { text-decoration-color: currentColor; }
.copilotz-md strong { font-weight: 650; }
.copilotz-md code { padding: .12em .38em; border: 1px solid var(--border); border-radius: var(--radius-xs);
  background: var(--muted); font: .86em/1.4 var(--font-mono); font-variant-ligatures: none; }
.copilotz-md blockquote { margin: 0 0 .8em; padding: 2px 0 2px 14px; border-left: 3px solid var(--input);
  color: var(--secondary-foreground); }
.copilotz-md hr { margin: 1.4em 0; border: 0; border-top: 1px solid var(--border); }
.copilotz-md-code { margin: 0 0 .9em; border: 1px solid var(--border); border-radius: var(--radius-lg); overflow: hidden;
  background: color-mix(in oklab, var(--muted) 50%, var(--background)); }
.copilotz-md-code figcaption { display: flex; align-items: center; justify-content: space-between; min-height: 34px;
  padding: 3px 4px 3px 14px; border-bottom: 1px solid var(--border); color: var(--muted-foreground);
  font: 12px/1 var(--font-mono); }
.copilotz-md-code pre { margin: 0; padding: 12px 14px; overflow-x: auto; font: 13px/1.6 var(--font-mono);
  font-variant-ligatures: none; tab-size: 2; }
.copilotz-md-code pre code { padding: 0; border: 0; background: none; font: inherit; }
.copilotz-md-table { margin: 0 0 .9em; overflow-x: auto; border: 1px solid var(--border); border-radius: var(--radius-lg); }
.copilotz-md table { width: 100%; border-collapse: collapse; font-size: 14px; line-height: 1.5; }
.copilotz-md :is(th, td) { padding: 8px 12px; border-bottom: 1px solid var(--border); text-align: left; vertical-align: top; }
.copilotz-md th { background: color-mix(in oklab, var(--muted) 50%, var(--background)); font-weight: 620; white-space: nowrap; }
.copilotz-md tbody tr:last-child td { border-bottom: 0; }
.copilotz-md-streaming > :is(p, h3, h4, h5, h6):last-child::after,
.copilotz-md-streaming > :is(ul, ol):last-child > li:last-child > :last-child::after {
  content: ""; display: inline-block; width: 7px; height: 1.05em; margin-left: 2px; vertical-align: text-bottom;
  border-radius: 2px; background: var(--primary-text); animation: copilotz-caret 1s steps(2, start) infinite; }
@keyframes copilotz-caret { to { visibility: hidden; } }
`,
);

export function Markdown(
  { text, streaming, className }: { text: string; streaming?: boolean; className?: string },
): ReactNode {
  const parsed = useMemo(() => blocks(text), [text]);
  return (
    <div className={cx("copilotz-md", streaming && "copilotz-md-streaming", className)}>
      {SHEET}
      {parsed.map((b, i) => block(b, i))}
    </div>
  );
}

function block(b: Block, key: number): ReactNode {
  switch (b.type) {
    case "paragraph":
      return <p key={key}>{inline(spans(b.text))}</p>;
    case "heading": {
      // A reply's headings sit under the page's: # is a section of the message.
      const Tag = `h${Math.min(b.level + 2, 6)}` as "h3";
      return <Tag key={key}>{inline(spans(b.text))}</Tag>;
    }
    case "code":
      return (
        <figure key={key} className="copilotz-md-code">
          <figcaption>
            <span>{b.lang || "code"}</span>
            {b.open ? null : <CopyButton text={b.text} label="Copy code" />}
          </figcaption>
          <pre tabIndex={0}><code>{b.text}</code></pre>
        </figure>
      );
    case "list": {
      const items = b.items.map((item, i) =>
        item.done === undefined
          ? <li key={i}>{item.blocks.map((x, j) => block(x, j))}</li>
          : (
            <li key={i} className="copilotz-md-task">
              <Checkbox checked={item.done} disabled aria-label={item.done ? "Done" : "To do"} />
              <div>{item.blocks.map((x, j) => block(x, j))}</div>
            </li>
          )
      );
      return b.ordered
        ? <ol key={key} start={b.start === 1 ? undefined : b.start}>{items}</ol>
        : <ul key={key}>{items}</ul>;
    }
    case "math":
      return <Formula key={key} tex={b.tex} display pending={b.open} />;
    case "quote":
      return <blockquote key={key}>{b.blocks.map((x, i) => block(x, i))}</blockquote>;
    case "rule":
      return <hr key={key} />;
    case "table":
      return (
        <div key={key} className="copilotz-md-table" role="region" aria-label="Table" tabIndex={0}>
          <table>
            <thead>
              <tr>
                {b.head.map((cell, i) => (
                  <th key={i} style={{ textAlign: b.align[i] }}>{inline(spans(cell))}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {b.rows.map((row, r) => (
                <tr key={r}>
                  {b.head.map((_, i) => (
                    <td key={i} style={{ textAlign: b.align[i] }}>{inline(spans(row[i] ?? ""))}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
  }
}

function inline(parts: Span[]): ReactNode[] {
  return parts.map((s, key) => {
    switch (s.type) {
      case "text":
        return s.text;
      case "break":
        return <br key={key} />;
      case "code":
        return <code key={key}>{s.text}</code>;
      case "math":
        return <Formula key={key} tex={s.tex} display={s.display} />;
      case "strong":
        return <strong key={key}>{inline(s.children)}</strong>;
      case "em":
        return <em key={key}>{inline(s.children)}</em>;
      case "del":
        return <del key={key}>{inline(s.children)}</del>;
      case "link":
        return s.href.startsWith("/")
          ? <a key={key} href={s.href}>{inline(s.children)}</a>
          : (
            <a key={key} href={s.href} target="_blank" rel="noopener noreferrer nofollow">
              {inline(s.children)}
            </a>
          );
    }
  });
}
