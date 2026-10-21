/** @jsxRuntime classic */
/** @jsx React.createElement */
/** @jsxFrag React.Fragment */
// deno-lint-ignore verbatim-module-syntax -- classic JSX requires this runtime import.
import * as React from "react";
import { defineView } from "@copilotz/copilotz/views";
import type { BrowserViewContext } from "@copilotz/copilotz/web";
import {
  formatCount,
  humanize,
  Metric,
  Notice,
  ReadStatus,
  ResourceTable,
  Screen,
  type TabItem,
} from "@copilotz/copilotz/web/kit";

/** The administration sections, in tab order. */
export const ADMIN_SECTIONS: readonly TabItem[] = [
  { id: "overview", label: "Overview", icon: "gauge" },
  { id: "agents", label: "Agents", icon: "bot" },
  { id: "threads", label: "Conversations", icon: "message" },
  { id: "participants", label: "People", icon: "users" },
  { id: "activity", label: "Activity", icon: "chart" },
  { id: "usage", label: "Usage", icon: "zap" },
];

const sections: Record<
  string,
  {
    action: string;
    noun: string;
    columns: string[];
    labels?: Record<string, string>;
    opens?: string;
  }
> = {
  overview: { action: "adminOverview", noun: "overview", columns: [] },
  agents: {
    action: "adminAgents",
    noun: "agents",
    columns: ["name", "id", "role"],
    opens: "agent",
  },
  activity: {
    action: "adminActivity",
    noun: "activity",
    columns: ["bucket", "messageCount", "toolCallCount", "totalTokens"],
    labels: {
      bucket: "Period",
      messageCount: "Messages",
      toolCallCount: "Tool calls",
      totalTokens: "Tokens",
    },
  },
  threads: {
    action: "adminThreads",
    noun: "conversations",
    columns: ["name", "status", "updatedAt"],
    labels: { updatedAt: "Updated" },
    opens: "thread",
  },
  participants: {
    action: "adminParticipants",
    noun: "people",
    columns: ["displayName", "participantType", "id"],
    labels: { displayName: "Name", participantType: "Type" },
    opens: "participant",
  },
  usage: {
    action: "adminUsage",
    noun: "usage",
    columns: [
      "dimensions",
      "attempts",
      "inputTokens",
      "outputTokens",
      "totalCostUsd",
    ],
    labels: {
      dimensions: "Breakdown",
      inputTokens: "Input tokens",
      outputTokens: "Output tokens",
      totalCostUsd: "Cost (USD)",
    },
  },
};

function figure(value: unknown): string {
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return figure(record.total ?? record.totalCalls ?? record.count ?? null);
  }
  if (typeof value === "number") return formatCount(value);
  return value === null || value === undefined ? "—" : String(value);
}

function refusal(status: number): string {
  return status === 401 || status === 403
    ? "You don't have access to this section."
    : status === 404
    ? "This section isn't available in this app."
    : "This section couldn't be loaded. Try again in a moment.";
}

const view: import("@copilotz/copilotz/views").ViewDefinition<
  { section: string; query?: Record<string, string>; embedded?: boolean },
  React.ReactNode,
  BrowserViewContext
> = defineView<
  { section: string; query?: Record<string, string>; embedded?: boolean },
  React.ReactNode,
  BrowserViewContext
>({
  id: "admin.query",
  shows: "adminQuery",
  renderer: "react",
  modes: ["full", "panel"],
  url: true,
  render({ section, query = {}, embedded = false }, ctx) {
    const config = sections[section];
    if (!config) throw new TypeError("Unknown admin section");
    const title = ADMIN_SECTIONS.find((item) => item.id === section)?.label ??
      humanize(section);
    const aliases = ctx.resources.admin?.actionAliases as
      | Readonly<Record<string, string>>
      | undefined;
    const state = ctx.readAction(aliases?.[section] ?? config.action, {
      resource: section,
      method: "GET",
      query: { limit: "100", ...query },
    });
    const response = state.value as
      | { status?: number; data?: unknown }
      | undefined;
    const failed = Boolean(response?.status && response.status >= 400);
    const data = failed ? undefined : response?.data;
    const analytics = data && typeof data === "object" && !Array.isArray(data)
      ? data as Record<string, unknown>
      : undefined;
    const rows = (Array.isArray(data)
      ? data
      : Array.isArray(analytics?.breakdown)
      ? analytics.breakdown
      : []) as Record<string, unknown>[];
    // Usage rows group by dimensions such as model and provider.
    const shown = rows.map((row) =>
      row.dimensions && typeof row.dimensions === "object"
        ? {
          ...row,
          dimensions: Object.values(row.dimensions).filter((part) =>
            part !== null && part !== undefined && part !== ""
          ).join(" · "),
        }
        : row
    );
    const body = (
      <>
        <ReadStatus state={state} noun={config.noun} />
        {failed && response?.status && (
          <Notice tone="error">{refusal(response.status)}</Notice>
        )}
        {state.status !== "held" && !failed && section === "overview" &&
          analytics && (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {Object.entries(analytics).map(([label, value]) => (
              <Metric
                key={label}
                label={humanize(label)}
                value={figure(value)}
              />
            ))}
          </div>
        )}
        {state.status !== "held" && !failed && section !== "overview" &&
          state.status === "ready" && (
          <ResourceTable
            rows={shown}
            columns={config.columns}
            labels={config.labels}
            emptyTitle={`No ${config.noun} yet`}
            open={config.opens
              ? (row) =>
                ctx.show({ shows: config.opens!, value: { id: row.id } }, {
                  source: "link",
                })
              : undefined}
          />
        )}
      </>
    );
    if (embedded) {
      return <div className="grid min-w-0 gap-4">{body}</div>;
    }
    return (
      <Screen title={title} density={ctx.hints.mode}>
        {body}
      </Screen>
    );
  },
});

export default view;
