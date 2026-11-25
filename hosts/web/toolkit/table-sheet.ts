import type { ExportCell, ExportOptions, Sheet } from "./export.ts";

/** The column properties used to project rows into an export. */
export type SheetColumn<R> = {
  /** The row field to project. */
  key: string;
  /** Its header. An empty title omits an action column from the file. */
  title: string;
  /** The cell as text: what search, sorting and export use (`row[key]` by default). */
  text?(row: R): string;
};

// A named column needs only the sheet fields. An inline UI column may carry other options,
// and its renderer gets the same row type as its text.
type AppColumn<R> =
  | SheetColumn<R>
  | (SheetColumn<R> & {
    render?(row: R): unknown;
    [option: string]: unknown;
  });

/** A cell as text: its column's `text`, or `row[key]`. */
export function textOf<R, C extends AppColumn<R> = AppColumn<R>>(
  column: C,
  row: R,
): string {
  if (column.text) return column.text(row);
  const value = (row as Record<string, unknown>)?.[column.key];
  return value === undefined || value === null ? "" : String(value);
}

/** Projects the chosen columns, displayed or raw, into a file. Untitled action columns stay on screen. */
export function tableSheet<R, C extends AppColumn<R> = AppColumn<R>>(
  columns: C[],
  rows: R[],
  footerRows: Record<string, ExportCell>[] = [],
  values: ExportOptions["values"] = "display",
): Sheet<ExportCell> {
  const fields = columns.filter((column) => column.title !== "");
  const keys = fields.map((column) => column.key);
  const cell = (column: SheetColumn<R>, row: R): ExportCell => {
    if (values !== "raw") return textOf(column, row);
    const raw = (row as Record<string, unknown>)?.[column.key];
    if (raw === null || typeof raw === "boolean" || typeof raw === "number") return raw;
    return String(raw ?? "");
  };
  return {
    keys,
    headers: fields.map((column) => column.title),
    rows: rows.map((row) => fields.map((column) => cell(column, row))),
    footerRows: footerRows.map((row) => keys.map((key) => Object.hasOwn(row, key) ? row[key] : "")),
  };
}
