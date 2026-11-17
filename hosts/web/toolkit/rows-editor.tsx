/**
 * A list of records edited as one form: a row of fields each (tax codes,
 * an invoice's lines, a kit's items). `render` gives a row's fields, from
 * the row, its place, and `set`, which changes it. Each row is numbered
 * ("Row 1", or the app's `rowLabel`) and has two buttons after it: one adds
 * a row after it, and one takes it out. "Add a row" at the end adds one
 * there, and with no rows it's all there is. `add={false}` has neither (the rows are
 * the app's to make); `removeIcon` and `removeLabel` change the remove button's
 * icon and words. `make()` is a new row. `min`
 * and `max` bound how many rows there are: the buttons that would pass them
 * are disabled. A row's `error` (a function of the row) shows under its
 * fields and names the row's fields as invalid.
 *
 * Adding a row puts the focus in its first field; taking one out, in the
 * row that took its place (the one before it, when it was the last; the add
 * button, when none are left). Each row's fields are a group named by its
 * number. A row keeps its fields as it's edited: rows are told apart by
 * `rowKey` when given, or each by its object (an edit through `set` keeps
 * it). Narrower than 480px, a row's number goes over its fields.
 *
 * ```tsx
 * <RowsEditor label="Tax codes" rows={codes} onChange={setCodes} make={() => ({ code: "", name: "" })}
 *   rowLabel={(_, i) => `Tax code ${i + 1}`} error={(row) => (row.code ? undefined : "Give the code.")}
 *   render={(row, i, set) => (
 *     <Grid columns="1fr 2fr" collapse={false}>
 *       <Input aria-label="Code" value={row.code} onChange={(e) => set({ ...row, code: e.target.value })} />
 *       <Input aria-label="Name" value={row.name} onChange={(e) => set({ ...row, name: e.target.value })} />
 *     </Grid>
 *   )} />
 * ```
 */
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { Button } from "./button.tsx";
import { cx } from "./cx.ts";
import { IconButton } from "./icon-button.tsx";
import type { IconLike } from "./icon.tsx";
import {
  canAdd,
  canRemove,
  carryKey,
  focusAfterRemoving,
  insertAfter,
  keyOfRow,
  removeAt,
  replaceAt,
} from "./rows.ts";
import { sheet } from "./sheet.tsx";
import { say } from "./words.ts";

const SHEET = sheet(
  "rows-editor",
  `
.copilotz-rows { container-type: inline-size; display: grid; gap: var(--rows-editor-gap, 12px); min-width: 0; }
.copilotz-rows-list { display: grid; gap: var(--rows-editor-gap, 12px); margin: 0; padding: 0; list-style: none; }
.copilotz-rows-row { display: grid;
  grid-template-columns: var(--rows-editor-label-width, 88px) minmax(0, 1fr) auto;
  grid-template-areas: "label fields actions" ". error .";
  align-items: first baseline; column-gap: var(--rows-editor-column-gap, 12px); row-gap: 6px; }
.copilotz-rows-label { grid-area: label; overflow-wrap: anywhere;
  font-size: var(--rows-editor-label-font-size, 13.5px); font-weight: var(--rows-editor-label-font-weight, 600);
  color: var(--rows-editor-label-color, var(--foreground)); }
.copilotz-rows-fields { grid-area: fields; min-width: 0; }
.copilotz-rows-actions { grid-area: actions; display: flex; gap: 2px; align-self: start;
  margin-top: var(--rows-editor-actions-offset, 6px); }
.copilotz-rows-error { grid-area: error; margin: 0; color: var(--destructive-text);
  font-size: var(--rows-editor-error-font-size, 12.5px); line-height: 1.45; }
.copilotz-rows-row[data-invalid] .copilotz-rows-label { color: var(--destructive-text); }
.copilotz-rows-row[data-invalid] :is(.copilotz-input, .copilotz-select > select, .copilotz-textarea) {
  border-color: var(--destructive); }
.copilotz-rows-add { justify-self: start; }
@container (max-width: 480px) {
  .copilotz-rows-row { grid-template-columns: minmax(0, 1fr) auto;
    grid-template-areas: "label actions" "fields fields" "error error"; align-items: center; }
  .copilotz-rows-actions { margin-top: 0; }
}
`,
);

/** What can take the focus in a row's fields, first to last. */
const FOCUSABLE = "input:not([type=hidden]):not(:disabled), select:not(:disabled), " +
  'textarea:not(:disabled), button:not(:disabled), [tabindex]:not([tabindex="-1"])';

export function RowsEditor<R>(
  {
    rows,
    onChange,
    make,
    render,
    rowKey,
    rowLabel,
    error,
    min = 0,
    max,
    label,
    addLabel,
    add: adds = true,
    removeIcon = "trash",
    removeLabel,
    className,
  }: {
    rows: readonly R[];
    onChange(rows: R[]): void;
    /** A new row, as "add" puts it in. */
    make(): R;
    /** A row's fields: the row, its place, and how to change it. */
    render(row: R, index: number, set: (row: R) => void): ReactNode;
    /** A row's own key (its id), when it has one. */
    rowKey?(row: R, index: number): string | number;
    /** A row's name: "Row 1" by default. */
    rowLabel?(row: R, index: number): ReactNode;
    /** What's wrong with a row, shown under its fields; nothing when it's right. */
    error?(row: R, index: number): ReactNode | undefined;
    /** The fewest rows: none by default. */
    min?: number;
    /** The most rows: no limit by default. */
    max?: number;
    /** What the rows are, said to screen readers ("Tax codes"). */
    label?: string;
    /** The add button's words ("Add a row" by default). */
    addLabel?: string;
    /** The buttons that add a row, one after each row and "Add a row" at the end (yes). */
    add?: boolean;
    /** The remove button's icon (a trash). */
    removeIcon?: IconLike;
    /** The remove button's words, said to screen readers: fixed, or from the row ("Remove row 1"). */
    removeLabel?: string | ((row: R, index: number) => string);
    className?: string;
  },
): ReactNode {
  const base = useId();
  const box = useRef<HTMLDivElement>(null);
  // Where the focus goes once the rows are drawn: a row (by key), or the add button.
  const [focus, setFocus] = useState<{ key?: string; add?: true; rows: readonly R[] }>();
  const keys = rows.map((row, i) => keyOfRow(row, i, rowKey));

  useEffect(() => {
    if (!focus || !box.current) return;
    const target = focus.add
      ? box.current.querySelector<HTMLElement>(".copilotz-rows-add")
      : [...box.current.querySelectorAll<HTMLElement>("[data-row-key]")]
        .find((row) => row.dataset.rowKey === focus.key)
        ?.querySelector<HTMLElement>(`.copilotz-rows-fields :is(${FOCUSABLE})`) ??
        null;
    if (target) {
      target.focus();
      setFocus(undefined);
    } else if (focus.rows !== rows) setFocus(undefined); // The app took other rows: nothing to wait for.
  }, [focus, rows]);

  const add = (index: number) => {
    if (!canAdd(rows.length, max)) return;
    const row = make();
    onChange(insertAfter(rows, index, row));
    setFocus({ key: keyOfRow(row, index + 1, rowKey), rows });
  };
  const remove = (index: number) => {
    if (!canRemove(rows.length, min)) return;
    const left = removeAt(rows, index);
    onChange(left);
    const at = focusAfterRemoving(rows.length, index);
    setFocus(at < 0 ? { add: true, rows } : { key: keyOfRow(left[at], at, rowKey), rows });
  };
  const set = (index: number) => (row: R) => {
    carryKey(rows[index], row);
    onChange(replaceAt(rows, index, row));
  };

  const more = adds && canAdd(rows.length, max);
  const fewer = canRemove(rows.length, min);
  return (
    <div ref={box} className={cx("copilotz-rows", className)} role="group" aria-label={label}>
      {SHEET}
      {rows.length
        ? (
          <ol className="copilotz-rows-list">
            {rows.map((row, i) => {
              const id = `${base}-${i}`;
              const problem = error?.(row, i);
              return (
                <li
                  key={keys[i]}
                  data-row-key={keys[i]}
                  className="copilotz-rows-row"
                  data-invalid={problem ? "" : undefined}
                >
                  <span id={`${id}-label`} className="copilotz-rows-label">
                    {rowLabel ? rowLabel(row, i) : say("row", { row: i + 1 })}
                  </span>
                  <div
                    className="copilotz-rows-fields"
                    role="group"
                    aria-labelledby={`${id}-label`}
                    aria-describedby={problem ? `${id}-error` : undefined}
                  >
                    {render(row, i, set(i))}
                  </div>
                  <div className="copilotz-rows-actions">
                    {adds
                      ? (
                        <IconButton
                          icon="plus"
                          size="sm"
                          label={say("addRowAfter", { row: i + 1 })}
                          disabled={!more}
                          onClick={() => add(i)}
                        />
                      )
                      : null}
                    <IconButton
                      icon={removeIcon}
                      size="sm"
                      label={typeof removeLabel === "function"
                        ? removeLabel(row, i)
                        : removeLabel ?? say("removeRow", { row: i + 1 })}
                      disabled={!fewer}
                      onClick={() => remove(i)}
                    />
                  </div>
                  {problem
                    ? <p id={`${id}-error`} className="copilotz-rows-error">{problem}</p>
                    : null}
                </li>
              );
            })}
          </ol>
        )
        : null}
      {more
        ? (
          <Button
            size="sm"
            icon="plus"
            className="copilotz-rows-add"
            onClick={() => add(rows.length - 1)}
          >
            {addLabel ?? say("addRow")}
          </Button>
        )
        : null}
    </div>
  );
}
