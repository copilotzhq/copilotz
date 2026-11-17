/**
 * A list of rows, one under the other with a line between: links to go to
 * (`href`), things to do (`onSelect`), or rows that only say something. Each
 * has a `label`, maybe a quieter `description`, an `icon` (by name or the
 * app's own) and something at its `end` (a badge, a count, or the row's own
 * buttons: they sit beside its link, never in it); the `active` one is
 * marked (the page it's on). On its own it has a border and rounded
 * corners; `flush`, it has neither, to sit in a `Card` under its heading.
 *
 * ```tsx
 * <Card title="Summary reports" icon="chart" padding="none">
 *   <ListGroup flush items={[
 *     { href: "/reports/sales", label: "Sales", description: "By day, by employee" },
 *     { href: "/reports/taxes", label: "Taxes" },
 *   ]} />
 * </Card>
 * <ListGroup label="Values" items={values.map((v) => ({
 *   key: v, label: v,
 *   end: <IconButton icon="trash" label={`Remove ${v}`} size="sm" onClick={() => remove(v)} />,
 * }))} />
 * ```
 */
import type { ReactNode } from "react";
import { cx } from "./cx.ts";
import { type IconLike, iconOf } from "./icon.tsx";
import { sheet } from "./sheet.tsx";

/** A row: where it goes or what it does, and what it says. */
export type ListGroupItem = {
  /** Its key among the rows (its `href` by default). */
  key?: string;
  label: ReactNode;
  description?: ReactNode;
  icon?: IconLike;
  /** At its end: a badge, a count, the row's own buttons (beside its link, not in it). */
  end?: ReactNode;
  href?: string;
  onSelect?(): void;
  /** The row of the page this is. */
  active?: boolean;
  disabled?: boolean;
};

const SHEET = sheet(
  "list-group",
  `
.copilotz-list-group { margin: 0; padding: 0; list-style: none;
  border: var(--list-group-border-width, 1px) solid var(--border);
  border-radius: var(--list-group-radius, var(--radius-lg)); background: var(--card);
  color: var(--card-foreground); overflow: hidden; }
.copilotz-list-group-flush { border: 0; border-radius: 0; background: transparent; }
.copilotz-list-group > li + li { border-top: 1px solid var(--border); }
.copilotz-list-group-item { display: flex; align-items: center; transition: background-color .15s, color .15s; }
.copilotz-list-group-item:has(> a.copilotz-list-group-row:not([aria-disabled=true]):hover,
  > button.copilotz-list-group-row:hover:not(:disabled)) { background: var(--accent);
  color: var(--accent-foreground); }
.copilotz-list-group-item:has(> [aria-current]) { background: var(--primary-soft); color: var(--primary-text);
  box-shadow: inset 3px 0 0 var(--primary); }
.copilotz-list-group-row { flex: 1; display: flex; align-items: center; gap: 12px; min-width: 0;
  min-height: var(--list-group-row-height, 44px); padding: var(--list-group-padding, 10px 14px); margin: 0;
  border: 0; background: transparent; color: inherit; font: inherit; text-align: left;
  text-decoration: none; }
a.copilotz-list-group-row, button.copilotz-list-group-row { cursor: pointer; }
.copilotz-list-group-row:focus-visible { outline-offset: -2px; }
.copilotz-list-group-row:disabled, .copilotz-list-group-row[aria-disabled=true] { opacity: .55; cursor: default; }
.copilotz-list-group-row > .copilotz-icon { color: var(--muted-foreground); }
.copilotz-list-group-text { flex: 1; display: grid; min-width: 0; gap: 1px; }
.copilotz-list-group-label { font-size: var(--list-group-font-size, 14px); font-weight: var(--list-group-font-weight, 560);
  line-height: 1.35; overflow-wrap: anywhere; }
.copilotz-list-group-description { color: var(--muted-foreground); font-size: 12.5px; line-height: 1.4; }
.copilotz-list-group-end { flex: none; display: flex; align-items: center; gap: 6px;
  padding-inline-end: var(--list-group-end-padding, 14px); color: var(--muted-foreground); }
@media (pointer: coarse) { .copilotz-list-group-row { min-height: 48px; } }
`,
);

export function ListGroup(
  { items, flush, label, className }: {
    items: ListGroupItem[];
    /** No border of its own: inside a card. */
    flush?: boolean;
    /** What the list is, said to screen readers. */
    label?: string;
    className?: string;
  },
): ReactNode {
  return (
    <ul
      className={cx("copilotz-list-group", flush && "copilotz-list-group-flush", className)}
      aria-label={label}
    >
      {SHEET}
      {items.map((item, i) => (
        <li key={item.key ?? item.href ?? i} className="copilotz-list-group-item">
          {row(item)}
          {item.end ? <span className="copilotz-list-group-end">{item.end}</span> : null}
        </li>
      ))}
    </ul>
  );
}

function row(item: ListGroupItem): ReactNode {
  const inside = (
    <>
      {iconOf(item.icon, 18)}
      <span className="copilotz-list-group-text">
        <span className="copilotz-list-group-label">{item.label}</span>
        {item.description
          ? <span className="copilotz-list-group-description">{item.description}</span>
          : null}
      </span>
    </>
  );
  const current = item.active ? { "aria-current": "page" as const } : {};
  if (item.href !== undefined) {
    return item.disabled
      ? (
        <a className="copilotz-list-group-row" aria-disabled="true" {...current}>
          {inside}
        </a>
      )
      : (
        <a
          className="copilotz-list-group-row"
          href={item.href}
          onClick={item.onSelect}
          {...current}
        >
          {inside}
        </a>
      );
  }
  if (item.onSelect) {
    return (
      <button
        type="button"
        className="copilotz-list-group-row"
        disabled={item.disabled}
        onClick={item.onSelect}
        {...current}
      >
        {inside}
      </button>
    );
  }
  return <div className="copilotz-list-group-row" {...current}>{inside}</div>;
}
