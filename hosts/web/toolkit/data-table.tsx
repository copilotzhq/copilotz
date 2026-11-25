/**
 * A list of rows to read, find and act on: a toolbar (the page's own actions
 * at its start, given the ticked rows; a search, a column chooser and an
 * export menu at its end), headers that sort, a box to tick per row, and the
 * pages under it (`Pagination`). It says when it's loading, and `empty` when
 * nothing shows. Columns are data (`Column`): what each shows, as text for
 * search, sorting and export, and how it sits (`align`, `width`, `nowrap`),
 * so a screen writes no CSS for its table.
 *
 * - **In the browser** (the default): give every row; it searches (each
 *   word, case and accents aside), sorts and pages them itself. Fine for a
 *   few thousand.
 * - **On the server**: give `total` and the page's `rows`, with `state` and
 *   `onState`: the View reads its query with the state (`{ search, sort,
 *   order, offset, limit }`). `tableAddress(where, 25)` keeps it in the
 *   page's address, so the View reads it again as it changes.
 *
 * A click on a row ticks it (not on a link, button or field in it); `actions`
 * are given the ticked rows' keys, and a way to clear them. `detail` opens a
 * row under each one, by a button at its start (`detailOpen`: open at first, or
 * always, with no button). `layout="fixed"` shares the width by the columns'
 * `width`s; fields in cells fill their column. The export takes the
 * visible columns of the rows shown, or of every row that matches
 * (`exportAll`), into `<exportName>.<extension>` (see `export.ts`).
 *
 * ```tsx
 * <DataTable label="Items" columns={[
 *   { key: "name", title: "Name" },
 *   { key: "price", title: "Price", numeric: true, align: "right", text: (r) => money(r.price) },
 *   { key: "edit", title: "", label: "Edit", render: (r) => <a href={`/items/${r.id}`}>Edit</a> },
 * ]} rows={items} rowKey={(r) => r.id} exportName="items"
 *   actions={(ticked, clear) => <Button disabled={!ticked.length} onClick={…}>Delete</Button>} />
 * ```
 */
import {
  type Context,
  createContext,
  Fragment,
  type MouseEvent,
  type ReactNode,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { lang } from "../words.ts";
import { Button } from "./button.tsx";
import { Checkbox } from "./checkbox.tsx";
import { cx } from "./cx.ts";
import {
  downloadTableFile,
  EXPORT_FORMATS,
  type ExportCell,
  type ExportFormat,
  type ExportOptions,
  type TableExportFormat,
} from "./export.ts";
import { usesTableLayout } from "./pdf.ts";
import { Icon } from "./icon.tsx";
import { Input } from "./input.tsx";
import { Menu } from "./menu.tsx";
import { Pagination } from "./pagination.tsx";
import { Popover } from "./popover.tsx";
import { sheet } from "./sheet.tsx";
import { Spinner } from "./spinner.tsx";
import {
  type Column,
  isLinks,
  isSortable,
  type Key,
  PAGE_SIZES,
  sortedBy,
  tableSheet,
  type TableState,
  tableView,
  textOf,
} from "./table.ts";
import { say } from "./words.ts";

export { type Column, type Key, PAGE_SIZES, type TableState };

/** A format in the export menu: by name, or with the menu's own words for it. */
type FormatChoice<F extends string> = F | { format: F; label: string };
export type ExportChoice = FormatChoice<ExportFormat>;

/** Provide named formats around the app's screens. A table may add or replace them locally. */
export const TableExportFormats: Context<Record<string, TableExportFormat>> = createContext<
  Record<string, TableExportFormat>
>({});

const CELL = "var(--table-cell-padding, 10px 12px)";
const LINE = "var(--table-border-color, var(--border))";

const SHEET = sheet(
  "data-table",
  `
.copilotz-table { min-width: 0; font-size: var(--table-font-size, 14px); }
.copilotz-table-toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: var(--table-toolbar-gap, 8px);
  margin-bottom: var(--table-toolbar-margin, 12px); }
.copilotz-table-actions, .copilotz-table-tools { display: flex; flex-wrap: wrap; align-items: center;
  gap: var(--table-toolbar-gap, 8px); }
.copilotz-table-actions:empty { display: none; }
.copilotz-table-tools { margin-inline-start: auto; }
.copilotz-table-search { width: var(--table-search-width, 220px); max-width: 100%; }
@media (max-width: 560px) {
  .copilotz-table-tools { flex: 1 1 100%; }
  .copilotz-table-search { flex: 1 1 auto; width: auto; }
}
.copilotz-table-box { position: relative; overflow-x: auto; border: 1px solid ${LINE}; border-radius: var(--table-radius, var(--radius-lg));
  background: var(--table-background, var(--card)); }
.copilotz-table-grid { width: 100%; margin: 0; border-collapse: separate; border-spacing: 0;
  color: var(--card-foreground); line-height: 1.45; }
.copilotz-table-grid th, .copilotz-table-grid td { padding: ${CELL}; border-top: var(--table-row-border-width, 1px) solid ${LINE};
  text-align: start; vertical-align: middle; }
.copilotz-table-grid tr > :is(th, td) + :is(th, td) {
  border-inline-start: var(--table-column-border-width, 0px) solid ${LINE}; }
.copilotz-table-grid thead th { border-top: 0;
  background: var(--table-head-background, color-mix(in oklab, var(--muted) 70%, var(--card)));
  color: var(--table-head-foreground, var(--muted-foreground)); font-size: var(--table-head-font-size, 12.5px);
  font-weight: var(--table-head-font-weight, 600); white-space: nowrap; vertical-align: bottom; }
.copilotz-table-fixed { table-layout: fixed; }
/* Fields in cells fill their column and shrink with it (a Select's minimum goes too). */
.copilotz-table-grid td :is(.copilotz-input, .copilotz-input-group, .copilotz-select, .copilotz-picker,
  .copilotz-textarea, .copilotz-tags-input, .copilotz-file-input) { box-sizing: border-box; width: 100%; min-width: 0; }
.copilotz-table-grid td :is(.copilotz-select, .copilotz-picker) { min-width: 0; }
.copilotz-table-grid thead th.copilotz-table-sortable { padding: 0; }
.copilotz-table-sort { display: flex; align-items: center; gap: 4px; width: 100%; margin: 0; padding: ${CELL};
  border: 0; background: none; color: inherit; font: inherit; text-align: inherit; cursor: pointer; }
.copilotz-table-sort:hover, th[aria-sort] > .copilotz-table-sort { color: var(--foreground); }
.copilotz-table-sort:focus-visible { outline-offset: -2px; }
.copilotz-table-sort > .copilotz-icon { opacity: 0; transition: opacity .15s, transform .15s; }
.copilotz-table-sort:hover > .copilotz-icon, .copilotz-table-sort:focus-visible > .copilotz-icon { opacity: .55; }
th[aria-sort] > .copilotz-table-sort > .copilotz-icon { opacity: 1; }
th[aria-sort=ascending] > .copilotz-table-sort > .copilotz-icon { transform: rotate(180deg); }
.copilotz-table-grid tbody > tr.copilotz-table-stripe { background: var(--table-stripe, transparent); }
.copilotz-table-grid tbody > tr[data-row]:hover {
  background: var(--table-hover, color-mix(in oklab, var(--muted) 55%, transparent)); }
.copilotz-table-grid tbody > tr.copilotz-table-selected { background: var(--table-selected, var(--primary-soft)); }
.copilotz-table-grid .copilotz-table-control { width: 44px; padding-block: 0; text-align: center; }
.copilotz-table-control > .copilotz-checkbox { vertical-align: middle; }
.copilotz-table-control > .copilotz-checkbox > input { margin: 0; }
.copilotz-table-expand { display: inline-grid; place-items: center; width: 28px; height: 28px; margin: 0; padding: 0;
  border: 0; border-radius: var(--radius-sm); background: none; color: var(--muted-foreground); cursor: pointer; }
.copilotz-table-expand:hover { background: var(--accent); color: var(--accent-foreground); }
.copilotz-table-expand > .copilotz-icon { transition: transform .15s; }
.copilotz-table-expand[aria-expanded=true] > .copilotz-icon { transform: rotate(90deg); }
.copilotz-table-grid tbody > tr.copilotz-table-detail > td { padding: var(--table-detail-padding, 12px 16px);
  background: color-mix(in oklab, var(--muted) 40%, var(--card)); }
.copilotz-table-grid td.copilotz-table-empty { padding: var(--table-empty-padding, 32px 12px); text-align: center;
  color: var(--muted-foreground); }
.copilotz-table-loading { display: inline-flex; align-items: center; gap: 8px; }
.copilotz-table-grid .copilotz-table-right { text-align: end; }
.copilotz-table-grid .copilotz-table-center { text-align: center; }
.copilotz-table-right > .copilotz-table-sort { justify-content: flex-end; }
.copilotz-table-center > .copilotz-table-sort { justify-content: center; }
.copilotz-table-number { font-variant-numeric: tabular-nums; }
.copilotz-table-grid .copilotz-table-nowrap { white-space: nowrap; }
.copilotz-table-grid td a:not([class]) { color: var(--primary-text); text-underline-offset: 2px; }
.copilotz-table-grid tfoot td { font-weight: 600; }
.copilotz-table-columns { display: grid; gap: 2px; padding: 4px; }
.copilotz-table-columns > .copilotz-checkbox { padding: 5px 6px; border-radius: var(--radius-sm); }
.copilotz-table-columns > .copilotz-checkbox:hover { background: var(--accent); }
@media (pointer: coarse) { .copilotz-table-expand { width: 40px; height: 40px; } }
`,
);

/**
 * What in a row has clicks of its own, so a click there doesn't tick the row: links, buttons and
 * fields, and the whole of a toolkit field's box (its padding, its addons, a tags field's room), so
 * a row whose cells are fields can be typed in without being ticked.
 */
export const OWN_CLICK = [
  "a",
  "button",
  "input",
  "select",
  "textarea",
  "label",
  "summary",
  "[role=button]",
  "[role=switch]",
  "[role=combobox]",
  "[role=spinbutton]",
  "[contenteditable=true]",
  ".copilotz-input",
  ".copilotz-input-group",
  ".copilotz-select",
  ".copilotz-textarea",
  ".copilotz-tags-input",
  ".copilotz-file-input",
  ".copilotz-picker",
].join(", ");

/** Whether a click lands on something of its own in the row: a link, a button, a field. */
const ownClick = (event: MouseEvent) => !!(event.target as Element).closest?.(OWN_CLICK);

const ALIGN = { left: undefined, right: "copilotz-table-right", center: "copilotz-table-center" };

type DataTableProps<R> = {
  columns: Column<R>[];
  rows: R[];
  rowKey(row: R): Key;
  /** What the table is, said to screen readers ("Items"). */
  label?: string;
  /** On the server: every matching row's count; `rows` is then the page. */
  total?: number;
  /** What it shows (search, sort, page), when the screen keeps it; with `onState`. */
  state?: TableState;
  onState?(state: TableState): void;
  /** Rows to a page at first (25). */
  pageSize?: number;
  /** The page sizes to choose from (10, 25, 50, 100; `false`: no choosing). */
  pageSizes?: number[] | false;
  /** Keep the page-size menu when only one size is offered. */
  showSinglePageSize?: boolean;
  /** A box to tick per row: yes when there are `actions`. */
  selectable?: boolean;
  /** The toolbar's start: the page's actions, given the ticked rows' keys (Delete, Email…). */
  actions?(selected: Key[], clear: () => void): ReactNode;
  /** The search box (yes). */
  search?: boolean;
  /** The column chooser (yes). */
  chooseColumns?: boolean;
  /** The export menu's formats (CSV, Excel, PDF); `false`: none. */
  exports?: ExportChoice[] | false;
  /** Ordered menu choices including custom format names. */
  exportChoices?: FormatChoice<string>[];
  /** An export's file name, without its extension ("export"). */
  exportName?: string;
  /** Export every row that matches (searched and sorted), not only the page shown. */
  exportAll?: boolean;
  /** How the files are made (see `export.ts`). */
  exportOptions?: ExportOptions;
  /** Additional or replacement formats for this table, keyed by name. */
  formats?: Record<string, TableExportFormat>;
  /** Totals by column key, shown below the body and included in each file. */
  footerRows?: Record<string, ExportCell>[];
  /** What it says when no row shows ("Nothing to show"). */
  empty?: ReactNode;
  loading?: boolean;
  /** Rows under the others (`<tr>`s of totals). */
  footer?: ReactNode;
  /** A row under each one, shown by a button at its start. */
  detail?(row: R): ReactNode;
  /**
   * Whether the `detail` rows are open at first: `true` shows them always (no button), or a
   * function says per row (the button still closes and opens it).
   */
  detailOpen?: boolean | ((row: R) => boolean);
  /**
   * The table's layout: `"auto"` (the browser shares the width out by content) or `"fixed"`
   * (by the columns' `width`s, the rest shared evenly; cells never widen their column).
   */
  layout?: "auto" | "fixed";
  /** A button or filter beside the built-in tools. */
  toolbarContent?: ReactNode;
  /** Show the toolbar (the default). */
  toolbar?: boolean;
  pagination?: boolean;
  /** The table element's id. */
  id?: string;
  className?: string;
};

/** Lists, searches and exports the visible columns of a page or a client-side list. */
export function DataTable<R>(props: DataTableProps<R>): ReactNode {
  const {
    columns,
    rows,
    rowKey,
    actions,
    search = true,
    chooseColumns = true,
    exports,
    toolbar = true,
    pagination = true,
  } = props;
  const selectable = props.selectable ?? actions !== undefined;
  const server = props.total !== undefined;
  const base = useId();
  const [own, setOwn] = useState<TableState>({
    search: "",
    order: "asc",
    offset: 0,
    limit: props.pageSize ?? 25,
  });
  const state = props.state ?? own;
  const latest = useRef(state);
  latest.current = state;
  const setState = (next: TableState) => props.onState ? props.onState(next) : setOwn(next);
  const [shown, setShown] = useState<Record<string, boolean>>({});
  const [ticked, setTicked] = useState<Key[]>([]);
  const [opened, setOpened] = useState<Key[]>([]);

  // The search box asks after a pause; a search set from outside (the address) shows in it.
  const [typed, setTyped] = useState(state.search);
  const asked = useRef(state.search);
  useEffect(() => {
    if (state.search === asked.current) return;
    asked.current = state.search;
    setTyped(state.search);
  }, [state.search]);
  useEffect(() => {
    if (typed === latest.current.search) return;
    const timer = setTimeout(() => {
      asked.current = typed;
      setState({ ...latest.current, search: typed, offset: 0 });
    }, 500);
    return () => clearTimeout(timer);
  }, [typed]);

  const visible = columns.filter((column) => shown[column.key] ?? !column.hidden);
  const { page, total, matching } = useMemo(
    () =>
      server
        ? { page: rows, total: props.total ?? rows.length, matching: rows }
        : tableView(rows, columns, state, { paged: pagination, locale: lang() }),
    [rows, columns, state, server, props.total, pagination],
  );

  // In the browser, ticked rows that are gone (deleted) aren't ticked any more.
  const present = useMemo(() => server ? undefined : new Set(rows.map(rowKey)), [rows, server]);
  const selected = present ? ticked.filter((key) => present.has(key)) : ticked;
  const keys = page.map(rowKey);
  const all = keys.length > 0 && keys.every((key) => selected.includes(key));
  const some = !all && keys.some((key) => selected.includes(key));
  const tick = (key: Key, on: boolean) =>
    setTicked(on ? [...selected.filter((k) => k !== key), key] : selected.filter((k) => k !== key));
  const clear = () => setTicked([]);

  const titled = columns.filter((column) => !isLinks(column as Column<unknown>));
  const visibleTitled = visible.filter((column) => !isLinks(column as Column<unknown>));
  const sharedFormats = useContext(TableExportFormats);
  const definitions = { ...sharedFormats, ...props.exportOptions?.formats, ...props.formats };
  const choices = exports === false ? false : props.exportChoices ?? exports ??
    [...new Set(["csv", "xlsx", "pdf", ...Object.keys(definitions)])];
  const formats = choices === false ? [] : choices.map((choice) => {
    if (typeof choice !== "string") return choice;
    const label = Object.hasOwn(definitions, choice)
      ? definitions[choice].label
      : EXPORT_FORMATS.find((f) => f.format === choice)?.label ?? choice;
    return { format: choice, label };
  });
  const save = (format: string) => {
    const sheet = tableSheet(
      visibleTitled,
      props.exportAll ? matching : page,
      props.footerRows,
      props.exportOptions?.values,
    );
    const pdf = props.exportOptions?.pdf;
    // Positional settings describe the initially visible columns, before chooser edits.
    const byKey = new Map(
      titled.filter((c) => !c.hidden).map((c, i) => [c.key, pdf?.columns?.[i]]),
    );
    const columns = visibleTitled.map((c) => ({
      align: c.align,
      ...byKey.get(c.key),
    }));
    downloadTableFile(format, sheet, props.exportName ?? "export", {
      ...props.exportOptions,
      formats: definitions,
      pdf: usesTableLayout(pdf, props.footerRows) ? { ...pdf, columns } : pdf,
    });
  };
  const always = props.detailOpen === true;
  const toggles = !!props.detail && !always;
  const span = visible.length + (selectable ? 1 : 0) + (toggles ? 1 : 0);
  const cellClass = (column: Column<R>) =>
    cx(
      ALIGN[column.align ?? "left"],
      column.numeric && "copilotz-table-number",
      column.nowrap && "copilotz-table-nowrap",
      column.className,
    );
  const width = (column: Column<R>) =>
    column.width === undefined
      ? undefined
      : { width: typeof column.width === "number" ? `${column.width}px` : column.width };
  const showsToolbar = toolbar !== false &&
    (props.toolbarContent != null || actions !== undefined || search ||
      (chooseColumns && titled.length > 1) || formats.length > 0);

  return (
    <div className={cx("copilotz-table", props.className)}>
      {SHEET}
      {showsToolbar
        ? (
          <div className="copilotz-table-toolbar">
            <div className="copilotz-table-actions">
              {props.toolbarContent}
              {actions?.(selected, clear)}
            </div>
            <div className="copilotz-table-tools">
              {search
                ? (
                  <Input
                    size="sm"
                    icon="search"
                    type="search"
                    className="copilotz-table-search"
                    placeholder={say("search")}
                    aria-label={say("search")}
                    value={typed}
                    onChange={(event) => setTyped(event.target.value)}
                  />
                )
                : null}
              {chooseColumns && titled.length > 1
                ? (
                  <Popover
                    label={say("columns")}
                    align="end"
                    width={240}
                    trigger={(open) => (
                      <Button {...open} size="sm" icon="eye">{say("columns")}</Button>
                    )}
                  >
                    <div className="copilotz-table-columns">
                      {titled.map((column) => {
                        const on = shown[column.key] ?? !column.hidden;
                        return (
                          <Checkbox
                            key={column.key}
                            data-popover-item
                            label={column.title}
                            checked={on}
                            // The last column shown stays.
                            disabled={on && visibleTitled.length === 1}
                            onChange={(event) =>
                              setShown({ ...shown, [column.key]: event.target.checked })}
                          />
                        );
                      })}
                    </div>
                  </Popover>
                )
                : null}
              {formats.length
                ? (
                  <Menu
                    label={say("export")}
                    align="end"
                    trigger={(open) => (
                      <Button {...open} size="sm" icon="download" iconEnd="chevron-down">
                        {say("export")}
                      </Button>
                    )}
                    items={formats.map(({ format, label }) => ({
                      label,
                      onSelect: () => save(format),
                    }))}
                  />
                )
                : null}
            </div>
          </div>
        )
        : null}
      <div className="copilotz-table-box">
        <table
          id={props.id}
          className={cx("copilotz-table-grid", props.layout === "fixed" && "copilotz-table-fixed")}
          aria-label={props.label}
          aria-busy={props.loading || undefined}
        >
          <thead>
            <tr>
              {toggles
                ? (
                  <th className="copilotz-table-control" scope="col">
                    <span className="copilotz-sr">{say("showDetails")}</span>
                  </th>
                )
                : null}
              {selectable
                ? (
                  <th className="copilotz-table-control" scope="col">
                    <Checkbox
                      aria-label={say("selectAll")}
                      checked={all}
                      ref={(box: HTMLInputElement | null) => {
                        if (box) box.indeterminate = some;
                      }}
                      disabled={!keys.length}
                      onChange={(event) =>
                        setTicked(
                          event.target.checked
                            ? [...new Set([...selected, ...keys])]
                            : selected.filter((key) => !keys.includes(key)),
                        )}
                    />
                  </th>
                )
                : null}
              {visible.map((column) => {
                const sorted = state.sort === column.key;
                const sortable = isSortable(column as Column<unknown>);
                return (
                  <th
                    key={column.key}
                    scope="col"
                    data-field={column.key}
                    style={width(column)}
                    className={cx(sortable && "copilotz-table-sortable", cellClass(column))}
                    aria-sort={sorted && sortable
                      ? state.order === "asc" ? "ascending" : "descending"
                      : undefined}
                  >
                    {isLinks(column as Column<unknown>)
                      ? <span className="copilotz-sr">{column.label ?? column.key}</span>
                      : sortable
                      ? (
                        <button
                          type="button"
                          className="copilotz-table-sort"
                          onClick={() => setState(sortedBy(state, column.key))}
                        >
                          {column.title}
                          <Icon name={sorted ? "down" : "selector"} size={13} />
                        </button>
                      )
                      : column.title}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {props.loading
              ? (
                <tr>
                  <td className="copilotz-table-empty" colSpan={span}>
                    <span className="copilotz-table-loading">
                      <Spinner size={14} />
                      {say("loadingRows")}
                    </span>
                  </td>
                </tr>
              )
              : page.length === 0
              ? (
                <tr>
                  <td className="copilotz-table-empty" colSpan={span}>
                    {props.empty ?? say("noRows")}
                  </td>
                </tr>
              )
              : page.map((row, index) => {
                const key = rowKey(row);
                const on = selected.includes(key);
                const firstOpen = typeof props.detailOpen === "function"
                  ? props.detailOpen(row)
                  : always;
                // `opened` holds the rows the user turned from how they began.
                const open = !!props.detail && (always || firstOpen !== opened.includes(key));
                const detailId = `${base}-detail-${index}`;
                return (
                  <Fragment key={key}>
                    <tr
                      data-row=""
                      className={cx(
                        index % 2 === 0 && "copilotz-table-stripe",
                        on && "copilotz-table-selected",
                      )}
                      onClick={(event) => {
                        if (selectable && !ownClick(event)) tick(key, !on);
                      }}
                    >
                      {toggles
                        ? (
                          <td className="copilotz-table-control">
                            <button
                              type="button"
                              className="copilotz-table-expand"
                              aria-expanded={open}
                              aria-controls={open ? detailId : undefined}
                              aria-label={say(open ? "hideDetails" : "showDetails")}
                              onClick={() =>
                                setOpened(
                                  open ? opened.filter((k) => k !== key) : [...opened, key],
                                )}
                            >
                              <Icon name="chevron" size={15} />
                            </button>
                          </td>
                        )
                        : null}
                      {selectable
                        ? (
                          <td className="copilotz-table-control">
                            <Checkbox
                              aria-label={say("selectRow")}
                              checked={on}
                              onChange={(event) => tick(key, event.target.checked)}
                            />
                          </td>
                        )
                        : null}
                      {visible.map((column) => (
                        <td key={column.key} className={cellClass(column)}>
                          {column.render ? column.render(row) : textOf(column, row)}
                        </td>
                      ))}
                    </tr>
                    {open
                      ? (
                        <tr id={detailId} className="copilotz-table-detail">
                          <td colSpan={span}>{props.detail!(row)}</td>
                        </tr>
                      )
                      : null}
                  </Fragment>
                );
              })}
          </tbody>
          {props.footer || props.footerRows?.length
            ? (
              <tfoot>
                {props.footerRows?.map((row, i) => (
                  <tr key={i}>
                    {toggles && <td />}
                    {selectable && <td />}
                    {visible.map((column) => (
                      <td key={column.key} className={cellClass(column)}>
                        {column.title && Object.hasOwn(row, column.key)
                          ? String(row[column.key] ?? "")
                          : ""}
                      </td>
                    ))}
                  </tr>
                ))}
                {props.footer}
              </tfoot>
            )
            : null}
        </table>
      </div>
      {pagination && total > 0
        ? (
          <Pagination
            total={total}
            state={state}
            onState={setState}
            sizes={props.pageSizes ?? PAGE_SIZES}
            showSinglePageSize={props.showSinglePageSize}
          />
        )
        : null}
    </div>
  );
}
