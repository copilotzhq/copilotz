/**
 * A long list's pages: which rows show ("Showing 1 to 25 of 80 rows"), how
 * many to a page (a menu in the sentence: "25 rows per page"), and links to
 * the pages (‹ 1 2 3 … 9 ›, the current one marked, `aria-current`). It
 * works on a table's state (`offset`, `limit`): a `DataTable` draws one
 * under its rows, and any list may use one.
 *
 * ```tsx
 * <Pagination total={80} state={state} onState={setState} />
 * ```
 */
import type { ReactNode } from "react";
import { formatNumber } from "../words.ts";
import { Button } from "./button.tsx";
import { cx } from "./cx.ts";
import { Icon } from "./icon.tsx";
import { Menu } from "./menu.tsx";
import { sheet } from "./sheet.tsx";
import {
  onPage,
  PAGE_SIZES,
  pageCount,
  pageLinks,
  pageOf,
  sizesFor,
  type TableState,
} from "./table.ts";
import { say } from "./words.ts";

const SHEET = sheet(
  "pagination",
  `
.copilotz-pagination { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between;
  gap: 8px 16px; margin-top: var(--pagination-margin, 12px); color: var(--muted-foreground);
  font-size: var(--pagination-font-size, 13px); line-height: 1.4; }
.copilotz-pagination-detail { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 14px; }
.copilotz-pagination-sizes { display: inline-flex; align-items: center; gap: 6px; }
.copilotz-pagination-links { display: flex; flex-wrap: wrap; gap: var(--pagination-gap, 2px); margin: 0; padding: 0;
  list-style: none; }
.copilotz-pagination-link { display: inline-flex; align-items: center; justify-content: center;
  min-width: var(--pagination-link-size, 32px); height: var(--pagination-link-size, 32px); margin: 0; padding: 0 8px;
  border: 0; border-radius: var(--pagination-link-radius, var(--radius-md)); background: transparent;
  color: var(--foreground); font: inherit; font-weight: var(--pagination-link-font-weight, 560);
  font-variant-numeric: tabular-nums; line-height: 1; cursor: pointer; transition: background-color .15s, color .15s; }
.copilotz-pagination-link:hover:not(:disabled):not([aria-current]) { background: var(--accent);
  color: var(--accent-foreground); }
.copilotz-pagination-link[aria-current=page] { background: var(--pagination-current-background, var(--primary));
  color: var(--pagination-current-foreground, var(--primary-foreground)); cursor: default; }
.copilotz-pagination-link:disabled, .copilotz-pagination-gap { color: var(--muted-foreground); opacity: .5;
  cursor: default; }
@media (pointer: coarse) { .copilotz-pagination-link { min-width: 40px; height: 40px; } }
`,
);

export function Pagination(
  { total, state, onState, sizes = PAGE_SIZES, className }: {
    /** How many rows there are in all. */
    total: number;
    /** Where it is: `offset` and `limit` (the rest is kept as it is). */
    state: TableState;
    onState(state: TableState): void;
    /** The page sizes to choose from (`false`: no choosing). */
    sizes?: number[] | false;
    className?: string;
  },
): ReactNode {
  const count = pageCount(total, state.limit);
  const current = pageOf(state);
  const go = (page: number) => onState(onPage(state, page, total));
  const choices = sizes === false ? [] : sizesFor(sizes, total, state.limit);
  const perPage = say("rowsPerPage", { size: formatNumber(state.limit) });
  const link = (page: number, inside: ReactNode, label: string, disabled = false) => (
    <button
      type="button"
      className="copilotz-pagination-link"
      aria-label={label}
      aria-current={page === current ? "page" : undefined}
      disabled={disabled}
      onClick={() => go(page)}
    >
      {inside}
    </button>
  );
  return (
    <div className={cx("copilotz-pagination", className)}>
      {SHEET}
      <div className="copilotz-pagination-detail">
        <span aria-live="polite">
          {say("showingRows", {
            from: formatNumber(total ? state.offset + 1 : 0),
            to: formatNumber(Math.min(state.offset + state.limit, total)),
            total: formatNumber(total),
          })}
        </span>
        {choices.length > 1
          ? (
            <span className="copilotz-pagination-sizes">
              {say.nodes("rowsPerPage", {
                size: (
                  <Menu
                    label={perPage}
                    side="top"
                    trigger={(open) => (
                      <Button {...open} size="sm" iconEnd="chevron-down" aria-label={perPage}>
                        {formatNumber(state.limit)}
                      </Button>
                    )}
                    items={choices.map((size) => ({
                      label: formatNumber(size),
                      ...(size === state.limit ? { icon: "check" as const } : {}),
                      onSelect: () => onState({ ...state, limit: size, offset: 0 }),
                    }))}
                  />
                ),
              })}
            </span>
          )
          : null}
      </div>
      {count > 1
        ? (
          <nav aria-label={say("pages")}>
            <ul className="copilotz-pagination-links">
              <li>
                {link(
                  current - 1,
                  <Icon name="chevron-left" size={15} />,
                  say("previousPage"),
                  current === 1,
                )}
              </li>
              {pageLinks(current, count).map((page, i) => (
                <li key={`${page}-${i}`}>
                  {page === "gap"
                    ? (
                      <span
                        className="copilotz-pagination-link copilotz-pagination-gap"
                        aria-hidden="true"
                      >
                        …
                      </span>
                    )
                    : link(page, formatNumber(page), say("page", { page: formatNumber(page) }))}
                </li>
              ))}
              <li>
                {link(
                  current + 1,
                  <Icon name="chevron" size={15} />,
                  say("nextPage"),
                  current === count,
                )}
              </li>
            </ul>
          </nav>
        )
        : null}
    </div>
  );
}
