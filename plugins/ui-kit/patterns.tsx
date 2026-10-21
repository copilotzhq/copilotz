/** @jsxRuntime classic */
/** @jsx React.createElement */
/** @jsxFrag React.Fragment */
// deno-lint-ignore verbatim-module-syntax -- classic JSX requires this runtime import.
import * as React from "react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "./components/card.tsx";
import { Button } from "./components/button.tsx";
import { cn } from "./utils.ts";
import type { ReadState } from "../../client/web/types.ts";
export function Screen(
  { title, density = "full", children, actions }: {
    title: string;
    density?: string;
    children?: React.ReactNode;
    actions?: React.ReactNode;
  },
): React.ReactElement | null {
  return (
    <section
      aria-label={title}
      data-density={density}
      className={cn(
        "flex min-h-0 flex-col gap-4",
        density === "panel" ? "p-3 text-sm" : "p-6",
      )}
    >
      <header className="flex items-center justify-between gap-3">
        <h1 className="text-lg font-semibold">{title}</h1>
        {actions}
      </header>
      {children}
    </section>
  );
}
/** A held query read (opened from a URL) starts only from this button. */
export function ReadStatus(
  { state }: { state: ReadState & { refresh?(): void } },
): React.ReactElement | null {
  if (state.status === "ready") {
    return state.pending
      ? <p role="status" className="text-muted-foreground">Saving…</p>
      : null;
  }
  if (state.status === "held") {
    return (
      <div
        role="status"
        className="flex flex-wrap items-center gap-2 text-muted-foreground"
      >
        <span>Opened from a link. Load this content to continue.</span>
        {state.refresh && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => state.refresh?.()}
          >
            Load
          </Button>
        )}
      </div>
    );
  }
  const labels = {
    loading: "Loading…",
    missing: "Nothing here yet",
    stale: "Connection interrupted. Showing saved data.",
    denied: "This content is unavailable.",
  };
  return (
    <p
      role={state.status === "denied" ? "alert" : "status"}
      className="text-muted-foreground"
    >
      {labels[state.status]}
    </p>
  );
}
export function Metric(
  { label, value }: { label: string; value: React.ReactNode },
): React.ReactElement | null {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{label}</CardTitle>
      </CardHeader>
      <CardContent className="text-2xl font-semibold">{value}</CardContent>
    </Card>
  );
}
export function ResourceTable(
  { rows, columns, open }: {
    rows: readonly Record<string, unknown>[];
    columns: readonly string[];
    open?: (row: Record<string, unknown>) => void;
  },
): React.ReactElement | null {
  if (!rows.length) {
    return <p className="text-muted-foreground">No records yet.</p>;
  }
  return (
    <div className="overflow-x-auto rounded-md border">
      <table className="w-full text-left text-sm">
        <thead className="bg-muted">
          <tr>
            {columns.map((column) => (
              <th key={column} className="p-3 font-medium">{column}</th>
            ))}
            {open && <th className="p-3">Details</th>}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={String(row.id ?? index)} className="border-t">
              {columns.map((column) => (
                <td key={column} className="p-3">
                  {typeof row[column] === "object"
                    ? JSON.stringify(row[column])
                    : String(row[column] ?? "—")}
                </td>
              ))}
              {open && (
                <td>
                  <Button
                    variant="ghost"
                    onClick={() => open(row)}
                  >
                    Open
                  </Button>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
