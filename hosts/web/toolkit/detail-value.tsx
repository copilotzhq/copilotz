/**
 * One value, as a detail page shows it, by what it is: a time (in words, the
 * date on hover), Yes or No, a number grouped, an id in mono with a way to
 * copy it, a link to the web, text (long text clamped, with "Show more"), a
 * few short values as chips, and a document or list inside as a nested
 * detail list (folded when it's big). Nothing (null, empty) is a quiet "—".
 * `as` says what it is where guessing won't do.
 *
 * ```tsx
 * <DetailValue field="createdAt" value="2026-10-28T09:12:00Z" />
 * ```
 */
import type { ReactNode } from "react";
import { Chip } from "./chip.tsx";
import { CopyButton } from "./copy-button.tsx";
import { DetailList } from "./detail-list.tsx";
import { Icon } from "./icon.tsx";
import { LongText } from "./long-text.tsx";
import { safeHref } from "./markdown/spans.ts";
import { sheet } from "./sheet.tsx";
import { Time } from "./time.tsx";

const SHEET = sheet(
  "detail-value",
  `
.copilotz-value-none { color: var(--muted-foreground); }
.copilotz-value-number { font-variant-numeric: tabular-nums; }
.copilotz-value-yes, .copilotz-value-no { display: inline-flex; align-items: center; gap: 6px; }
.copilotz-value-yes > .copilotz-icon { color: var(--success-text); }
.copilotz-value-no { color: var(--muted-foreground); }
.copilotz-value-time > .copilotz-time { font-size: inherit; color: inherit; }
.copilotz-value-id { display: inline-flex; align-items: center; gap: 2px; max-width: 100%; vertical-align: middle; }
.copilotz-value-id > code { min-width: 0; font-size: 12.5px; color: var(--secondary-foreground); overflow-wrap: anywhere; }
.copilotz-value-id > .copilotz-copy { flex: none; height: 24px; padding: 0 5px; }
.copilotz-value-text { white-space: pre-wrap; overflow-wrap: anywhere; }
.copilotz-value-link { color: var(--primary-text); text-underline-offset: 3px; text-decoration-thickness: 1px;
  overflow-wrap: anywhere; }
.copilotz-value-chips { display: flex; flex-wrap: wrap; gap: 6px; }
.copilotz-value-fold > summary { display: inline-flex; align-items: center; gap: 6px; max-width: 100%;
  border-radius: var(--radius-xs); color: var(--secondary-foreground); cursor: pointer; list-style: none; }
.copilotz-value-fold > summary::-webkit-details-marker { display: none; }
.copilotz-value-fold > summary > .copilotz-icon { flex: none; color: var(--muted-foreground); transition: transform .15s; }
.copilotz-value-fold[open] > summary > .copilotz-icon { transform: rotate(90deg); }
.copilotz-value-fold > summary:hover { color: var(--foreground); }
.copilotz-value-preview { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  color: var(--muted-foreground); }
.copilotz-value-fold > :not(summary) { margin-top: 8px; }
.copilotz-value-items { display: grid; gap: 8px; margin: 0; padding: 0 0 0 20px; }
.copilotz-value-items > li::marker { color: var(--muted-foreground); font-size: 12.5px; font-variant-numeric: tabular-nums; }
.copilotz-value-mono { display: block; max-height: 168px; overflow: auto; font-size: 12.5px; white-space: pre-wrap;
  overflow-wrap: anywhere; color: var(--secondary-foreground); }
`,
);

/** A field holding an id, by its name: `_id`, `id`, `threadId`, `place_id`. */
const ID_FIELD = /(?:^_?id|Id|_id)$/;
const UUID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;
const DATE_TIME = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const WEB = /^https?:\/\/\S+$/i;

/** As many short values as show as chips; more, and fields, before a nested list folds. */
const CHIPS = 10;
const CHIP_LENGTH = 40;
const FIELDS = 6;
const ITEMS = 3;
/** How deep nested lists go before what's inside is shown as data. */
const DEPTH = 3;

const none = <span className="copilotz-value-none">—</span>;

const plain = (value: unknown): value is string | number | boolean =>
  typeof value === "string" || typeof value === "number" || typeof value === "boolean";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) && !(value instanceof Date);

/** A value on one line, as data: how a document shows deeper than nested lists go. */
const brief = (value: unknown): string =>
  JSON.stringify(value, (_, v) => typeof v === "bigint" ? String(v) : v) ?? String(value);

function Id({ id }: { id: string }): ReactNode {
  return (
    <span className="copilotz-value-id">
      <code>{id}</code>
      <CopyButton text={id} label="Copy ID" />
    </span>
  );
}

/** Something big, folded: a summary to open it by. */
function Fold({ summary, children }: { summary: ReactNode; children: ReactNode }): ReactNode {
  return (
    <details className="copilotz-value-fold">
      <summary>
        <Icon name="chevron" size={14} />
        {summary}
      </summary>
      {children}
    </details>
  );
}

function List({ items, field, depth }: { items: unknown[]; field: string; depth: number }) {
  if (!items.length) return none;
  const short = items.every((item) => plain(item) && String(item).length <= CHIP_LENGTH);
  if (short && items.length <= CHIPS) {
    return (
      <span className="copilotz-value-chips">
        {items.map((item, i) => <Chip key={i} size="sm">{String(item)}</Chip>)}
      </span>
    );
  }
  if (short) {
    // Many short values (a vector, a long list of tags): as data, folded.
    return (
      <Fold
        summary={
          <>
            {items.length} items
            <span className="copilotz-value-preview">{items.slice(0, 4).join(", ")}…</span>
          </>
        }
      >
        <code className="copilotz-value-mono">{items.join(", ")}</code>
      </Fold>
    );
  }
  const list = (
    <ol className="copilotz-value-items">
      {items.map((item, i) => (
        <li key={i}>
          <DetailValue value={item} field={field} depth={depth + 1} />
        </li>
      ))}
    </ol>
  );
  return items.length > ITEMS ? <Fold summary={<>{items.length} items</>}>{list}</Fold> : list;
}

function Fields({ value, depth }: { value: Record<string, unknown>; depth: number }) {
  const keys = Object.keys(value);
  if (!keys.length) return none;
  if (depth >= DEPTH) return <code className="copilotz-value-mono">{brief(value)}</code>;
  const nested = <DetailList item={value} depth={depth + 1} />;
  if (keys.length <= FIELDS) return nested;
  return (
    <Fold
      summary={
        <>
          {keys.length} fields
          <span className="copilotz-value-preview">{keys.slice(0, 4).join(", ")}…</span>
        </>
      }
    >
      {nested}
    </Fold>
  );
}

export function DetailValue(
  { value, field = "", as, depth = 0 }: {
    value: unknown;
    /** The field it's in (a path: `source.thread`): an id's name says it's one. */
    field?: string;
    /** What it is, where guessing won't do. */
    as?: "id" | "time" | "text";
    /** How deep in nested lists it is. */
    depth?: number;
  },
): ReactNode {
  return (
    <>
      {SHEET}
      {shown(value, field, as, depth)}
    </>
  );
}

function shown(value: unknown, field: string, as: string | undefined, depth: number): ReactNode {
  if (value === null || value === undefined || value === "") return none;
  if (value instanceof Date || (typeof value === "string" && as === "time")) {
    const at = value instanceof Date ? value : new Date(value);
    return Number.isNaN(at.getTime())
      ? <span className="copilotz-value-text">{String(value)}</span>
      : (
        <span className="copilotz-value-time">
          <Time at={at.toISOString()} long />
        </span>
      );
  }
  if (typeof value === "boolean") {
    return value
      ? (
        <span className="copilotz-value-yes">
          <Icon name="check" size={15} />Yes
        </span>
      )
      : <span className="copilotz-value-no">No</span>;
  }
  if (typeof value === "number" || typeof value === "bigint") {
    return <span className="copilotz-value-number">{value.toLocaleString()}</span>;
  }
  if (typeof value === "string") {
    const name = field.split(".").at(-1) ?? "";
    if (as === "text") return <LongText text={value} />;
    if (as === "id" || ID_FIELD.test(name) || UUID.test(value)) return <Id id={value} />;
    if (DATE_TIME.test(value)) return shown(value, field, "time", depth);
    if (DATE.test(value)) {
      const [year, month, day] = value.split("-").map(Number);
      return (
        <time dateTime={value}>
          {new Date(year, month - 1, day).toLocaleDateString(undefined, { dateStyle: "medium" })}
        </time>
      );
    }
    const href = WEB.test(value) ? safeHref(value) : undefined;
    if (href) {
      return (
        <a
          className="copilotz-value-link"
          href={href}
          target="_blank"
          rel="noopener noreferrer nofollow"
        >
          {value}
        </a>
      );
    }
    return <LongText text={value} className="copilotz-value-text" />;
  }
  if (Array.isArray(value)) return <List items={value} field={field} depth={depth} />;
  if (isRecord(value)) return <Fields value={value} depth={depth} />;
  return <span className="copilotz-value-text">{String(value)}</span>;
}
