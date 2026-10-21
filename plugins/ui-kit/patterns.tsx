/** @jsxRuntime classic */
/** @jsx React.createElement */
/** @jsxFrag React.Fragment */
/** Screen layout, one read-state vocabulary, metrics and resource lists. @module */
import * as React from "react";
import { ArrowLeft, Search } from "lucide-react";
import { Button } from "./components/button.tsx";
import { Input } from "./components/input.tsx";
import { Spinner } from "./components/misc.tsx";
import { EmptyState, Notice } from "./components/feedback.tsx";
import { cn } from "./utils.ts";
import { formatRelative } from "../../client/web/format.ts";
import type { ReadState } from "../../client/web/types.ts";

/** A View body: a title row with actions, then content, in full or panel density. */
export function Screen(
  { title, description, density = "full", children, actions, className }: {
    title: string;
    description?: React.ReactNode;
    density?: string;
    children?: React.ReactNode;
    actions?: React.ReactNode;
    className?: string;
  },
): React.ReactElement | null {
  const panel = density === "panel";
  return (
    <section
      aria-label={title}
      data-density={density}
      className={cn(
        "flex min-h-0 w-full flex-col",
        panel ? "gap-3 p-4 text-sm" : "mx-auto max-w-5xl gap-5 p-4 sm:p-6",
        className,
      )}
    >
      <header className="flex min-w-0 items-start justify-between gap-3">
        <div className="grid min-w-0 gap-0.5">
          <h1
            className={cn(
              "truncate font-semibold tracking-tight",
              panel ? "text-sm" : "text-lg",
            )}
          >
            {title}
          </h1>
          {description && (
            <p className="text-muted-foreground text-sm">{description}</p>
          )}
        </div>
        {actions && (
          <div className="flex shrink-0 items-center gap-1.5">{actions}</div>
        )}
      </header>
      {children}
    </section>
  );
}

type AnyRead = ReadState & { refresh?(): void };

/**
 * One vocabulary for every read: loading, empty, reconnecting, refused,
 * failed, missing and held, plus the live read limits
 * (`subscription_capacity_exceeded`, `subscription_query_refused`). Renders
 * nothing for a ready read that has data.
 * `noun` names what is read ("conversations"); `empty` marks a ready, empty
 * read and shows `emptyTitle`, `emptyHint` and `emptyAction`.
 */
export function ReadStatus(
  {
    state,
    noun = "content",
    empty = false,
    emptyTitle,
    emptyHint,
    emptyAction,
    compact = false,
  }: {
    state: AnyRead;
    noun?: string;
    empty?: boolean;
    emptyTitle?: string;
    emptyHint?: React.ReactNode;
    emptyAction?: React.ReactNode;
    compact?: boolean;
  },
): React.ReactElement | null {
  const retry = state.refresh
    ? (
      <Button
        type="button"
        size="sm"
        variant="outline"
        onClick={() => state.refresh?.()}
      >
        Try again
      </Button>
    )
    : undefined;
  // Live read limits: say what happened and what helps, never a raw code.
  const code = state.error?.code;
  if (
    (state.status === "stale" || state.status === "denied") &&
    code === "subscription_capacity_exceeded"
  ) {
    return (
      <Notice tone="warning" title="Too many live views open" action={retry}>
        Close a panel or another tab of this app, then try again.
      </Notice>
    );
  }
  if (
    (state.status === "stale" || state.status === "denied") &&
    code === "subscription_query_refused"
  ) {
    return (
      <Notice tone="warning" title="Live updates unavailable" action={retry}>
        These {noun}{" "}
        can't stay up to date here yet. Reload the page to see the latest.
      </Notice>
    );
  }
  switch (state.status) {
    case "ready":
      if (state.pending) {
        return (
          <p
            role="status"
            className="text-muted-foreground flex items-center gap-2 text-xs"
          >
            <Spinner className="size-3" /> Saving…
          </p>
        );
      }
      if (!empty) return null;
      return compact
        ? (
          <p role="status" className="text-muted-foreground py-2 text-sm">
            {emptyTitle ?? `No ${noun} yet.`}
          </p>
        )
        : (
          <EmptyState
            title={emptyTitle ?? `No ${noun} yet`}
            action={emptyAction}
          >
            {emptyHint}
          </EmptyState>
        );
    case "loading":
      return (
        <p
          role="status"
          className={cn(
            "text-muted-foreground flex items-center gap-2 text-sm",
            compact ? "py-2" : "justify-center py-8",
          )}
        >
          <Spinner /> Loading {noun}…
        </p>
      );
    case "held":
      return (
        <Notice
          title="Opened from a link"
          action={state.refresh && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => state.refresh?.()}
            >
              Load
            </Button>
          )}
        >
          Load this content to continue.
        </Notice>
      );
    case "stale":
      if (state.error && state.error.kind !== "unavailable") {
        return (
          <Notice tone="error" title={`Couldn't load ${noun}`} action={retry}>
            {state.error.kind === "invalid"
              ? "The request was not accepted. Try again, or reload the page."
              : "Something went wrong. Try again in a moment."}
          </Notice>
        );
      }
      return (
        <Notice tone="warning" title="Reconnecting…" action={retry}>
          Showing the last saved {noun}.
        </Notice>
      );
    case "denied":
      return (
        <Notice tone="error" title={`No access to these ${noun}`}>
          Ask an owner to share them with you, or sign in with another account.
        </Notice>
      );
    case "missing":
      return (
        <Notice title="Not found">
          This {noun} no longer exists or isn't shared with you.
        </Notice>
      );
  }
}

/** A labelled figure. */
export function Metric(
  { label, value, hint }: {
    label: string;
    value: React.ReactNode;
    hint?: React.ReactNode;
  },
): React.ReactElement | null {
  return (
    <div
      data-slot="metric"
      className="bg-card grid gap-1 rounded-lg border p-4 shadow-soft"
    >
      <p className="text-muted-foreground text-xs font-medium">{label}</p>
      <p className="text-2xl font-semibold tracking-tight tabular-nums">
        {value}
      </p>
      {hint && <p className="text-muted-foreground text-xs">{hint}</p>}
    </div>
  );
}

/** Label and value pairs; values use the table's cell formatting. */
export function DetailList(
  { items, className }: {
    items: readonly (readonly [label: string, value: unknown])[];
    className?: string;
  },
): React.ReactElement {
  return (
    <dl
      data-slot="detail-list"
      className={cn(
        "bg-card grid grid-cols-[minmax(6rem,auto)_1fr] gap-x-6 rounded-lg border text-sm shadow-soft",
        className,
      )}
    >
      {items.map(([label, value], index) => (
        <div
          key={label}
          className={cn(
            "col-span-2 grid grid-cols-subgrid items-baseline px-4 py-2.5",
            index > 0 && "border-t",
          )}
        >
          <dt className="text-muted-foreground">{label}</dt>
          <dd className="min-w-0 break-words">
            {React.isValidElement(value) ? value : cell(value)}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** "updatedAt" → "Updated at", "totalCostUsd" → "Total cost usd". */
export function humanize(field: string): string {
  const words = field.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(
    /[_-]+/g,
    " ",
  ).trim().toLowerCase();
  return words ? words[0].toUpperCase() + words.slice(1) : field;
}

const isoTime =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/;

function cell(value: unknown): React.ReactNode {
  if (value === null || value === undefined || value === "") {
    return <span className="text-muted-foreground">—</span>;
  }
  if (typeof value === "string" && isoTime.test(value)) {
    return <time dateTime={value} title={value}>{formatRelative(value)}</time>;
  }
  if (typeof value === "number") {
    return <span className="tabular-nums">{value.toLocaleString()}</span>;
  }
  if (typeof value === "object") {
    return (
      <code className="text-muted-foreground text-xs">
        {JSON.stringify(value)}
      </code>
    );
  }
  return String(value);
}

/** Records as a table; a row with `open` is a button that opens it. */
export function ResourceTable(
  { rows, columns, open, labels = {}, emptyTitle = "No records yet" }: {
    rows: readonly Record<string, unknown>[];
    columns: readonly string[];
    open?: (row: Record<string, unknown>) => void;
    labels?: Readonly<Record<string, string>>;
    emptyTitle?: string;
  },
): React.ReactElement | null {
  if (!rows.length) return <EmptyState title={emptyTitle} />;
  return (
    <div className="bg-card overflow-x-auto rounded-lg border shadow-soft">
      <table className="w-full text-left text-sm">
        <thead className="bg-muted/60 text-muted-foreground text-xs">
          <tr>
            {columns.map((column) => (
              <th key={column} scope="col" className="px-3 py-2 font-medium">
                {labels[column] ?? humanize(column)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr
              key={String(row.id ?? index)}
              className={cn(
                "border-t transition-colors",
                open && "hover:bg-accent/50",
              )}
            >
              {columns.map((column, position) => (
                <td key={column} className="max-w-80 truncate px-3 py-2">
                  {open && position === 0
                    ? (
                      <button
                        type="button"
                        className="focus-visible:ring-ring/45 rounded-sm text-left font-medium underline-offset-4 outline-none hover:underline focus-visible:ring-[3px]"
                        onClick={() => open(row)}
                      >
                        {cell(row[column])}
                      </button>
                    )
                    : cell(row[column])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** One toolbar for every resource list: search, then actions. */
export function ResourceToolbar(
  { search, onSearch, searchLabel = "Search", children }: {
    search?: string;
    onSearch?: (value: string) => void;
    searchLabel?: string;
    children?: React.ReactNode;
  },
): React.ReactElement {
  return (
    <div
      data-slot="resource-toolbar"
      className="flex min-w-0 items-center gap-2"
    >
      {onSearch && (
        <label className="relative min-w-0 flex-1">
          <span className="sr-only">{searchLabel}</span>
          <Search
            aria-hidden="true"
            className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2"
          />
          <Input
            type="search"
            value={search ?? ""}
            placeholder={searchLabel}
            className="h-8 pl-8"
            onChange={(event) =>
              onSearch((event.target as unknown as { value: string }).value)}
          />
        </label>
      )}
      {children}
    </div>
  );
}

/** A list of resource rows with list semantics. */
export function ResourceList(
  { children, label, className }: {
    children?: React.ReactNode;
    label?: string;
    className?: string;
  },
): React.ReactElement {
  return (
    <ul
      data-slot="resource-list"
      aria-label={label}
      className={cn("grid gap-1.5", className)}
    >
      {children}
    </ul>
  );
}

/**
 * A resource row: an optional leading mark, title, one-line summary, meta
 * (such as a status Badge or relative time) and row actions as siblings of
 * the open button, so each stays separately focusable.
 */
export function ResourceRow(
  { title, subtitle, leading, meta, actions, onOpen, openLabel, selected }: {
    title: React.ReactNode;
    subtitle?: React.ReactNode;
    leading?: React.ReactNode;
    meta?: React.ReactNode;
    actions?: React.ReactNode;
    onOpen?: () => void;
    openLabel?: string;
    selected?: boolean;
  },
): React.ReactElement {
  const body = (
    <>
      {leading && <span className="shrink-0">{leading}</span>}
      <span className="grid min-w-0 flex-1 gap-0.5">
        <span className="truncate text-sm font-medium">{title}</span>
        {subtitle && (
          <span className="text-muted-foreground truncate text-xs">
            {subtitle}
          </span>
        )}
      </span>
      {meta && (
        <span className="text-muted-foreground flex shrink-0 items-center gap-2 text-xs">
          {meta}
        </span>
      )}
    </>
  );
  return (
    <li
      data-slot="resource-row"
      data-selected={selected || undefined}
      className={cn(
        "group/row bg-card flex min-w-0 items-center gap-1 rounded-lg border pr-1 transition-colors",
        onOpen && "hover:border-ring/40 hover:bg-accent/40",
        selected && "border-ring/50 bg-accent/50",
      )}
    >
      {onOpen
        ? (
          <button
            type="button"
            aria-label={openLabel}
            aria-current={selected ? "true" : undefined}
            className="focus-visible:ring-ring/45 flex min-w-0 flex-1 items-center gap-3 rounded-lg px-3 py-2.5 text-left outline-none focus-visible:ring-[3px]"
            onClick={onOpen}
          >
            {body}
          </button>
        )
        : (
          <div className="flex min-w-0 flex-1 items-center gap-3 px-3 py-2.5">
            {body}
          </div>
        )}
      {actions && (
        <div className="flex shrink-0 items-center gap-0.5">{actions}</div>
      )}
    </li>
  );
}

/** A detail header: "Back to <plural>", the title, a status and actions. */
export function ResourceHeader(
  { title, back, badge, actions, description }: {
    title: React.ReactNode;
    back?: { label: string; onClick(): void };
    badge?: React.ReactNode;
    actions?: React.ReactNode;
    description?: React.ReactNode;
  },
): React.ReactElement {
  return (
    <header data-slot="resource-header" className="grid gap-2">
      {back && (
        <Button
          type="button"
          variant="ghost"
          size="xs"
          className="text-muted-foreground -ml-1.5 w-fit"
          onClick={back.onClick}
        >
          <ArrowLeft /> {back.label}
        </Button>
      )}
      <div className="flex min-w-0 items-start gap-2">
        <h2 className="min-w-0 flex-1 truncate text-base font-semibold tracking-tight">
          {title}
        </h2>
        {badge}
        {actions && (
          <div className="flex shrink-0 items-center gap-1">{actions}</div>
        )}
      </div>
      {description && (
        <p className="text-muted-foreground text-sm">{description}</p>
      )}
    </header>
  );
}
