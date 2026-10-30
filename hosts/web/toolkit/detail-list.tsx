/**
 * A document's fields as label and value, one per row, on a card: the
 * `item`'s own fields in order, or the `fields` given (by name, or a path
 * into nested ones: `tags.thread`), each labelled from its name ("createdAt"
 * is "Created"; `humanize`) unless given a `label`, and its value formatted
 * by what it is (`DetailValue`), unless given one.
 *
 * Labels sit beside their values where there's room; where there isn't (a
 * narrow container, a phone), and in a `panel` `Page`, they stack over them.
 * `layout` says which, always. `bare` leaves out the card, for a front end's
 * own surface.
 *
 * ```tsx
 * <DetailList item={space} />
 * <DetailList item={memory} fields={["text", "createdAt", { field: "core", label: "Always in mind" }]} />
 * ```
 */
import type { ReactNode } from "react";
import { cx } from "./cx.ts";
import { DetailValue } from "./detail-value.tsx";
import { humanize } from "./humanize.ts";
import { sheet } from "./sheet.tsx";

/** A row: a field (or a path into nested ones), and what to call or show for it, if not its own. */
export type Detail = {
  field: string;
  label?: ReactNode;
  /** What to show, instead of the field's value. */
  value?: ReactNode;
  /** What the value is, where guessing won't do (an id without an id's name). */
  as?: "id" | "time" | "text";
};

const SHEET = sheet(
  "detail-list",
  `
.copilotz-details { container-type: inline-size; margin: 0; border: 1px solid var(--border); border-radius: var(--radius-xl);
  background: var(--card); color: var(--card-foreground); box-shadow: var(--shadow-sm); font-size: 14px; line-height: 1.5; }
.copilotz-details-bare { border: 0; border-radius: 0; background: none; box-shadow: none; }
.copilotz-details-row { display: grid; grid-template-columns: clamp(7rem, 30%, 13rem) minmax(0, 1fr); align-items: baseline;
  gap: 2px 20px; padding: 11px 16px; }
.copilotz-details-row + .copilotz-details-row { border-top: 1px solid var(--border); }
.copilotz-details-row > dt { min-width: 0; color: var(--muted-foreground); font-size: 13.5px; overflow-wrap: anywhere; }
.copilotz-details-row > dd { min-width: 0; margin: 0; overflow-wrap: anywhere; }
.copilotz-details-nested { border-left: 2px solid var(--border); }
.copilotz-details-nested > .copilotz-details-row { grid-template-columns: clamp(4.5rem, 25%, 8rem) minmax(0, 1fr);
  gap: 1px 14px; padding: 3px 0 3px 12px; border: 0; }
.copilotz-details-nested > .copilotz-details-row > dt { font-size: 13px; }
.copilotz-details-stacked > .copilotz-details-row { grid-template-columns: minmax(0, 1fr); padding: 9px 14px; }
.copilotz-details-stacked > .copilotz-details-row > dt { font-size: 12.5px; font-weight: 520; }
.copilotz-details-stacked.copilotz-details-nested > .copilotz-details-row { padding: 3px 0 3px 12px; }
@container (max-width: 460px) {
  .copilotz-details-auto > .copilotz-details-row { grid-template-columns: minmax(0, 1fr); padding: 9px 14px; }
  .copilotz-details-auto > .copilotz-details-row > dt { font-size: 12.5px; font-weight: 520; }
  .copilotz-details-auto.copilotz-details-nested > .copilotz-details-row { padding: 3px 0 3px 12px; }
}
.copilotz-page-panel .copilotz-details-auto > .copilotz-details-row { grid-template-columns: minmax(0, 1fr); padding: 9px 14px; }
.copilotz-page-panel .copilotz-details-auto > .copilotz-details-row > dt { font-size: 12.5px; font-weight: 520; }
.copilotz-page-panel .copilotz-details-auto.copilotz-details-nested > .copilotz-details-row { padding: 3px 0 3px 12px; }
`,
);

/** The value at a path (`tags.thread`): a field's, or one inside it. */
const at = (item: unknown, path: string): unknown =>
  path.split(".").reduce<unknown>(
    (value, key) =>
      typeof value === "object" && value !== null
        ? (value as Record<string, unknown>)[key]
        : undefined,
    item,
  );

export function DetailList(
  { item, fields, layout = "auto", bare, depth = 0, className }: {
    /** The document whose fields it lists. */
    item?: Record<string, unknown>;
    /** Which rows, in order: the item's own fields, unless given. */
    fields?: (string | Detail)[];
    /** `columns` (label beside value) or `stacked` (label over it); `auto`, as there's room. */
    layout?: "auto" | "columns" | "stacked";
    bare?: boolean;
    /** How deep inside another list's value it is: nested ones are bare and compact. */
    depth?: number;
    className?: string;
  },
): ReactNode {
  const rows = (fields ?? Object.keys(item ?? {})).map((row) =>
    typeof row === "string" ? { field: row } : row
  );
  const nested = depth > 0;
  return (
    <dl
      className={cx(
        "copilotz-details",
        `copilotz-details-${layout}`,
        (bare || nested) && "copilotz-details-bare",
        nested && "copilotz-details-nested",
        className,
      )}
    >
      {SHEET}
      {rows.map((row) => (
        <div key={row.field} className="copilotz-details-row">
          <dt>{row.label ?? humanize(row.field)}</dt>
          <dd>
            {row.value !== undefined ? row.value : (
              <DetailValue
                value={at(item, row.field)}
                field={row.field}
                as={row.as}
                depth={depth}
              />
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}
