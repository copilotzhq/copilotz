/// <reference lib="dom" />
/**
 * Code or output, in mono, on a quiet surface: a `title` row over it (a
 * command, a file's path) with `actions` at its end, the text, and a
 * `footer` under it (how a command ended). The text is a string, or parts
 * with a tone each: `error` (what went wrong, as stderr), `muted`, `accent`,
 * and `added` or `removed` (a change, line by line, marked + and −).
 *
 * Long text shows its first `lines` (or, `from: "end"`, its last, as a log
 * reads), with a toggle for the rest. Given `height` instead, it scrolls
 * within that many lines, and with `follow` it keeps to the end as the text
 * grows while you're there. `numbers` numbers the lines; `wrap={false}`
 * keeps long lines whole (they scroll sideways); `copy` copies the text (or,
 * given text, that), from the title row, or from a corner without one.
 * Nothing to show, it says `empty`, if given.
 *
 * ```tsx
 * <CodeBlock title="$ npm test" code={[{ text: out }, { text: err, tone: "error" }]}
 *   lines={8} from="end" footer="exit 1 · 2.4 s" copy />
 * ```
 */
import {
  type CSSProperties,
  type ReactNode,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { Button } from "./button.tsx";
import { CopyButton } from "./copy-button.tsx";
import { cx } from "./cx.ts";
import { type CodePart, linesOf } from "./code-lines.ts";
import { sheet } from "./sheet.tsx";

export type { CodePart, CodeTone } from "./code-lines.ts";

const SHEET = sheet(
  "code-block",
  `
.copilotz-code { --copilotz-code-pad: 12px; position: relative; min-width: 0; border: 1px solid var(--border); border-radius: var(--radius-lg);
  background: color-mix(in oklab, var(--muted) 62%, var(--card)); color: var(--foreground); overflow: hidden; }
.copilotz-code-head { display: flex; align-items: center; gap: 8px; min-height: 34px; padding: 3px 4px 3px var(--copilotz-code-pad);
  border-bottom: 1px solid var(--border); background: var(--card); font: 600 12.5px/1.45 var(--font-mono);
  font-variant-ligatures: none; }
.copilotz-code-title { flex: 1; min-width: 0; display: flex; align-items: center; gap: 8px; overflow-wrap: anywhere; }
.copilotz-code-actions { flex: none; display: flex; align-items: center; gap: 2px; font-family: var(--font-sans); }
.copilotz-code-body { display: block; margin: 0; padding: 8px var(--copilotz-code-pad); overflow: auto;
  font: 12.5px/1.6 var(--font-mono); font-variant-ligatures: none; tab-size: 4; white-space: pre-wrap;
  overflow-wrap: anywhere; scrollbar-width: thin; scrollbar-color: var(--input) transparent; }
.copilotz-code-nowrap .copilotz-code-body { white-space: pre; overflow-wrap: normal; }
.copilotz-code-scroll .copilotz-code-body { max-height: calc(var(--lines) * 1.6em + 16px); overscroll-behavior: contain; }
.copilotz-code-line { display: block; min-height: 1.6em; }
.copilotz-code-numbered .copilotz-code-line { display: grid; grid-template-columns: var(--gutter) minmax(0, 1fr); column-gap: 14px; }
.copilotz-code-number { color: var(--muted-foreground); opacity: .7; text-align: right; user-select: none; }
.copilotz-code [data-tone=error] { color: var(--destructive-text); }
.copilotz-code [data-tone=muted] { color: var(--muted-foreground); }
.copilotz-code [data-tone=accent] { color: var(--primary-text); }
.copilotz-code-line[data-tone=added], .copilotz-code-line[data-tone=removed] { position: relative;
  margin: 0 calc(var(--copilotz-code-pad) * -1); padding: 0 var(--copilotz-code-pad) 0 calc(var(--copilotz-code-pad) + 14px); }
.copilotz-code-line[data-tone=added] { background: var(--success-soft); }
.copilotz-code-line[data-tone=removed] { background: var(--destructive-soft); }
.copilotz-code-line[data-tone=added]::before, .copilotz-code-line[data-tone=removed]::before { position: absolute;
  left: var(--copilotz-code-pad); user-select: none; font-weight: 700; }
.copilotz-code-line[data-tone=added]::before { content: "+"; color: var(--success-text); }
.copilotz-code-line[data-tone=removed]::before { content: "−"; color: var(--destructive-text); }
.copilotz-code-empty { color: var(--muted-foreground); font-style: italic; }
.copilotz-code-corner { position: absolute; top: 5px; right: 5px; }
.copilotz-code-cornered .copilotz-code-body { padding-right: 44px; }
.copilotz-code-more { display: flex; padding: 0 var(--copilotz-code-pad); font-family: var(--font-sans); }
.copilotz-code-more:first-child, .copilotz-code-head + .copilotz-code-more { padding-top: 6px; }
.copilotz-code-more:last-child { padding-bottom: 7px; }
.copilotz-code-more .copilotz-button { font-size: 12.5px; }
.copilotz-code-foot { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 12px; padding: 6px var(--copilotz-code-pad);
  border-top: 1px solid var(--border); color: var(--muted-foreground); font: 12px/1.4 var(--font-sans); }
`,
);

/** Fewer hidden lines than this aren't worth a toggle: they show. */
const SLACK = 2;

export function CodeBlock(
  {
    code,
    title,
    actions,
    footer,
    lines: shown,
    from = "start",
    height,
    follow,
    numbers,
    wrap = true,
    copy,
    empty,
    label,
    className,
  }: {
    code: string | CodePart[];
    title?: ReactNode;
    actions?: ReactNode;
    footer?: ReactNode;
    /** How many lines show until it's opened. */
    lines?: number;
    /** Which end shows while it's folded. */
    from?: "start" | "end";
    /** Scrolls within this many lines, instead of folding. */
    height?: number;
    /** Scrolling, it keeps to the end as the text grows, while you're there. */
    follow?: boolean;
    numbers?: boolean;
    wrap?: boolean;
    /** A copy button: for the text, or for this. */
    copy?: boolean | string;
    empty?: ReactNode;
    /** What it is, said to screen readers, when the title doesn't say. */
    label?: string;
    className?: string;
  },
): ReactNode {
  const [open, setOpen] = useState(false);
  const body = useRef<HTMLPreElement>(null);
  const near = useRef(true);
  const id = useId();
  const all = linesOf(code);
  const text = typeof code === "string" ? code : code.map((p) => p.text).join("");
  const copied = typeof copy === "string" ? copy : copy ? text : "";
  const head = !!(title || actions);
  const folds = shown !== undefined && height === undefined && all.length > shown + SLACK;
  const hidden = folds && !open ? all.length - shown : 0;
  const visible = hidden ? (from === "end" ? all.slice(-shown!) : all.slice(0, shown)) : all;
  const first = hidden && from === "end" ? hidden : 0;

  useLayoutEffect(() => {
    const el = body.current;
    if (el && follow && near.current) el.scrollTop = el.scrollHeight;
  }, [text, follow]);

  const toggle = folds
    ? (
      <div className="copilotz-code-more">
        <Button
          variant="link"
          size="sm"
          aria-expanded={open}
          aria-controls={id}
          onClick={() => setOpen(!open)}
        >
          {open
            ? "Show less"
            : from === "end"
            ? `Show ${hidden} earlier line${hidden === 1 ? "" : "s"}`
            : `Show ${hidden} more line${hidden === 1 ? "" : "s"}`}
        </Button>
      </div>
    )
    : null;
  const style = {
    ...(height ? { "--lines": height } : {}),
    ...(numbers ? { "--gutter": `${String(all.length).length}ch` } : {}),
  } as CSSProperties;

  return (
    <div
      className={cx(
        "copilotz-code",
        !wrap && "copilotz-code-nowrap",
        height !== undefined && "copilotz-code-scroll",
        numbers && "copilotz-code-numbered",
        copied && !head && "copilotz-code-cornered",
        className,
      )}
      style={style}
    >
      {SHEET}
      {head
        ? (
          <div className="copilotz-code-head">
            <div className="copilotz-code-title">{title}</div>
            <div className="copilotz-code-actions">
              {actions}
              {copied ? <CopyButton text={copied} /> : null}
            </div>
          </div>
        )
        : copied
        ? (
          <span className="copilotz-code-corner">
            <CopyButton text={copied} />
          </span>
        )
        : null}
      {from === "end" ? toggle : null}
      <pre
        id={id}
        ref={body}
        className="copilotz-code-body"
        aria-label={label}
        tabIndex={height !== undefined ? 0 : undefined}
        onScroll={follow
          ? (event) => {
            const el = event.currentTarget;
            near.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
          }
          : undefined}
      >
        <code>
          {visible.length
            ? visible.map((line, i) => (
              <span key={first + i} className="copilotz-code-line" data-tone={line.tone}>
                {numbers ? <span className="copilotz-code-number">{first + i + 1}</span> : null}
                <span>
                  {line.parts.map((part, j) => (
                    <span key={j} data-tone={part.tone === line.tone ? undefined : part.tone}>
                      {part.text}
                    </span>
                  ))}
                </span>
              </span>
            ))
            : empty
            ? <span className="copilotz-code-empty">{empty}</span>
            : null}
        </code>
      </pre>
      {from === "start" ? toggle : null}
      {footer ? <div className="copilotz-code-foot">{footer}</div> : null}
    </div>
  );
}
