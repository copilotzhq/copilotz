/**
 * A server-paged table's state, kept in the page's address
 * (`/customers?search=ann&sort=name&order=desc&offset=25&limit=25`): the
 * View reads it from `where.query` and asks its query with it, and the
 * table's changes move the address (`go()`), so the View reads again, and
 * Back goes back a page. The address's other keys (a date range, a filter)
 * stay as they are.
 *
 * ```tsx
 * const table = tableAddress(where, 25);
 * const found = ctx.db.collection("customer").query("list", table.state);
 * <DataTable {...table} total={found.value?.total} rows={found.value?.rows ?? []} … />
 * ```
 */
import { go, type Where } from "./host.tsx";
import type { TableState } from "./toolkit/table.ts";

const KEYS = ["search", "sort", "order", "offset", "limit"];

/** The most rows a page the address asks for may have. */
const MOST = 1000;

/** The table's state the address holds (`pageSize` when it says none). */
export function tableState(where: Where, pageSize: number): TableState {
  const query = where.query ?? {};
  const whole = (value: string | undefined) => {
    const n = Math.floor(Number(value));
    return Number.isFinite(n) && n > 0 ? n : 0;
  };
  return {
    search: query.search ?? "",
    ...(query.sort ? { sort: query.sort } : {}),
    order: query.order === "desc" ? "desc" : "asc",
    offset: whole(query.offset),
    limit: Math.min(whole(query.limit) || pageSize, MOST),
  };
}

/**
 * The address's query (with its `?`, or `""`) with the table's `state` and
 * the `extra` keys (`undefined` or `""` drops one), the others kept.
 */
export function tableQuery(
  where: Where,
  state?: TableState,
  extra: Record<string, string | undefined> = {},
): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(where.query ?? {})) {
    if (!(state && KEYS.includes(key)) && !(key in extra)) query.set(key, value);
  }
  if (state) {
    if (state.search) query.set("search", state.search);
    if (state.sort) query.set("sort", state.sort);
    if (state.sort && state.order === "desc") query.set("order", "desc");
    if (state.offset) query.set("offset", String(state.offset));
    query.set("limit", String(state.limit));
  }
  for (const [key, value] of Object.entries(extra)) {
    if (value !== undefined && value !== "") query.set(key, value);
  }
  const text = query.toString();
  return text ? `?${text}` : "";
}

/**
 * A `DataTable`'s `state` and `onState`, from and to the address: spread
 * them on the table (`<DataTable {...tableAddress(where, 25)} …/>`).
 */
export function tableAddress(
  where: Where,
  pageSize: number,
): { state: TableState; onState(state: TableState): void } {
  return {
    state: tableState(where, pageSize),
    onState: (state) => go(`${where.path}${tableQuery(where, state)}`),
  };
}
