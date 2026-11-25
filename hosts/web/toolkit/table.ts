/**
 * What a data table does with its rows, apart from drawing them (see
 * `data-table.tsx`): its columns and state, searching (any word of any
 * titled column, case and accents aside: "joao" finds "João"), sorting (as
 * text in the page's language, numbers by their value), paging, and the
 * page links (‹ 1 2 3 … 9 ›). Plain functions, for a table in the browser
 * and for a query that pages on the server alike.
 *
 * ```ts
 * const { page, total } = tableView(rows, columns, { search: "ann", order: "asc", offset: 0, limit: 25 });
 * ```
 */
import type { ReactNode } from "react";
import { type SheetColumn, textOf } from "./table-sheet.ts";

export { tableSheet, textOf } from "./table-sheet.ts";

/** A row's identity: what `rowKey` gives, and what ticked rows are. */
export type Key = string | number;

/** A column: what it shows of each row, and how it searches, sorts and exports. */
export type Column<R> = SheetColumn<R> & {
  /** Its name for screen readers, where its header says nothing (a column of links). */
  label?: string;
  /** Sortable by its header: yes, unless `false` (a column of links never is). */
  sortable?: boolean;
  /** What a cell shows: `text`'s words, unless this draws it. */
  render?(row: R): ReactNode;
  /** Sorted by value: `row[key]` when it's a number, else the number in its text. */
  numeric?: boolean;
  align?: "left" | "right" | "center";
  /** Its width: pixels, or any CSS length (`"30%"`). Without it, the table shares the width out. */
  width?: number | string;
  /** Its cells kept on one line (a date, an amount). */
  nowrap?: boolean;
  /** Hidden until chosen in the column chooser. */
  hidden?: boolean;
  /** Its cells' and header's class. */
  className?: string;
};

/**
 * What a table shows: the search, the column it's sorted by and which way,
 * and the page (`offset` rows on, `limit` of them). A server-paged table's
 * query reads it.
 */
export type TableState = {
  search: string;
  sort?: string;
  order: "asc" | "desc";
  offset: number;
  limit: number;
};

/** The page sizes a table offers, by default. */
export const PAGE_SIZES: number[] = [10, 25, 50, 100];

/** A column of links or buttons: its header says nothing. */
export const isLinks = (column: Column<unknown>): boolean => column.title === "";

/** Whether its header sorts by it. */
export const isSortable = (column: Column<unknown>): boolean =>
  !isLinks(column) && column.sortable !== false;

/** Text as search compares it: lower case, without accents. */
export const fold = (text: string): string =>
  text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

/** The rows any titled column of which has the words searched (every word, in any column). */
export function searchRows<R>(rows: R[], columns: Column<R>[], search: string): R[] {
  const words = fold(search).split(/\s+/).filter(Boolean);
  if (!words.length) return rows;
  const searched = columns.filter((column) => !isLinks(column as Column<unknown>));
  return rows.filter((row) => {
    const text = searched.map((column) => fold(textOf(column, row))).join("\n");
    return words.every((word) => text.includes(word));
  });
}

/** A cell's number: `row[key]` when it is one, else the number in its text (`$1,234.50`). */
function numberOf<R>(column: Column<R>, row: R): number {
  const value = (row as Record<string, unknown>)?.[column.key];
  if (typeof value === "number") return value;
  const n = Number(textOf(column, row).replace(/[^\d.-]/g, ""));
  return Number.isFinite(n) ? n : Number.NEGATIVE_INFINITY;
}

/** The rows sorted by a column: as numbers, or as text in `locale`'s order (numbers in it by value). */
export function sortRows<R>(
  rows: R[],
  column: Column<R>,
  order: "asc" | "desc",
  locale?: string,
): R[] {
  const way = order === "desc" ? -1 : 1;
  const compare = new Intl.Collator(locale, { numeric: true, sensitivity: "base" }).compare;
  return rows.toSorted((a, b) =>
    way *
    (column.numeric
      ? numberOf(column, a) - numberOf(column, b)
      : compare(textOf(column, a), textOf(column, b)))
  );
}

/**
 * What a table shows of its rows: searched, sorted and paged by `state`
 * (`page`), how many match (`total`), and all of those (`matching`, for an
 * export of every row). Unpaged (`paged: false`), the page is all of them.
 */
export function tableView<R>(
  rows: R[],
  columns: Column<R>[],
  state: TableState,
  { paged = true, locale }: { paged?: boolean; locale?: string } = {},
): { page: R[]; total: number; matching: R[] } {
  let matching = searchRows(rows, columns, state.search);
  const by = columns.find((column) => column.key === state.sort);
  if (by && isSortable(by as Column<unknown>)) {
    matching = sortRows(matching, by, state.order, locale);
  }
  return {
    page: paged ? matching.slice(state.offset, state.offset + state.limit) : matching,
    total: matching.length,
    matching,
  };
}

/** The state after a header is pressed: sorted by it, ascending, or the other way if it was. */
export function sortedBy(state: TableState, key: string): TableState {
  const order = state.sort === key && state.order === "asc" ? "desc" : "asc";
  return { ...state, sort: key, order, offset: 0 };
}

/** How many pages `total` rows take (one, for none). */
export const pageCount = (total: number, limit: number): number =>
  Math.max(1, Math.ceil(total / Math.max(1, limit)));

/** The page `state` is on, from 1. */
export const pageOf = (state: TableState): number =>
  Math.floor(state.offset / Math.max(1, state.limit)) + 1;

/** The state on page `page` (kept within the pages there are). */
export function onPage(state: TableState, page: number, total: number): TableState {
  const at = Math.min(Math.max(page, 1), pageCount(total, state.limit));
  return { ...state, offset: (at - 1) * state.limit };
}

/**
 * The page links: every page when there are seven or fewer, else the first,
 * the last, and the five around this one, with a gap (`"gap"`) where pages
 * are left out: 1 … 4 5 6 7 8 … 20.
 */
export function pageLinks(current: number, count: number): (number | "gap")[] {
  if (count <= 7) return Array.from({ length: count }, (_, i) => i + 1);
  const from = Math.max(1, Math.min(current - 2, count - 4));
  const to = Math.min(count, from + 4);
  const links: (number | "gap")[] = [];
  if (from > 1) links.push(1, ...(from > 2 ? ["gap" as const] : []));
  for (let page = from; page <= to; page++) links.push(page);
  if (to < count) links.push(...(to < count - 1 ? ["gap" as const] : []), count);
  return links;
}

/**
 * The page sizes worth offering for `total` rows: each that shows fewer than
 * all of them, the first that shows them all, and the one in use.
 */
export function sizesFor(sizes: number[], total: number, limit: number): number[] {
  const sorted = [...new Set(sizes)].filter((size) => size > 0).sort((a, b) => a - b);
  const useful = sorted.filter((_, i) => i === 0 || sorted[i - 1] < total);
  return [...new Set([...useful, limit])].sort((a, b) => a - b);
}
