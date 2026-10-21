/** @jsxRuntime classic */
/** @jsx React.createElement */
/** @jsxFrag React.Fragment */
// deno-lint-ignore verbatim-module-syntax -- classic JSX requires this runtime import.
import * as React from "react";
import { defineView } from "@copilotz/copilotz/views";
import type { BrowserViewContext } from "@copilotz/copilotz/web";
import {
  Metric,
  ReadStatus,
  ResourceTable,
  Screen,
} from "@copilotz/copilotz/web/kit";
const sections: Record<
  string,
  { action: string; title: string; columns: string[] }
> = {
  overview: { action: "adminOverview", title: "Overview", columns: [] },
  agents: {
    action: "adminAgents",
    title: "Agents",
    columns: ["id", "name", "role"],
  },
  activity: {
    action: "adminActivity",
    title: "Activity",
    columns: ["bucket", "messageCount", "toolCallCount", "totalTokens"],
  },
  threads: {
    action: "adminThreads",
    title: "Threads",
    columns: ["id", "name", "status"],
  },
  participants: {
    action: "adminParticipants",
    title: "Participants",
    columns: ["id", "displayName", "participantType"],
  },
  usage: {
    action: "adminUsage",
    title: "Usage analytics",
    columns: ["model", "totalTokens", "totalCostUsd"],
  },
};
const view: import("@copilotz/copilotz/views").ViewDefinition<
  { section: string; query?: Record<string, string> },
  React.ReactNode,
  BrowserViewContext
> = defineView<
  { section: string; query?: Record<string, string> },
  React.ReactNode,
  BrowserViewContext
>({
  id: "admin.query",
  shows: "adminQuery",
  renderer: "react",
  modes: ["full", "panel"],
  render({ section, query = {} }, ctx) {
    const config = sections[section];
    if (!config) throw new TypeError("Unknown admin section");
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
    const data = response?.data;
    const analytics = data && typeof data === "object" && !Array.isArray(data)
      ? data as Record<string, unknown>
      : undefined;
    const rows = Array.isArray(data)
      ? data
      : Array.isArray(analytics?.breakdown)
      ? analytics.breakdown
      : [];
    return (
      <Screen title={config.title} density={ctx.hints.mode}>
        <ReadStatus state={state} />
        {response?.status && response.status >= 400 && (
          <p role="alert">Unable to read this section.</p>
        )}
        {section === "overview" && data && typeof data === "object"
          ? (
            <div className="grid gap-3 sm:grid-cols-2">
              {Object.entries(data).map(([label, value]) => (
                <Metric
                  key={label}
                  label={label}
                  value={typeof value === "object" && value
                    ? String(
                      (value as Record<string, unknown>).total ??
                        (value as Record<string, unknown>).totalCalls ?? "—",
                    )
                    : String(value)}
                />
              ))}
            </div>
          )
          : (
            <ResourceTable
              rows={rows}
              open={section === "agents" || section === "participants" ||
                  section === "threads"
                ? (row) =>
                  ctx.show({
                    shows: section === "agents"
                      ? "agent"
                      : section === "participants"
                      ? "participant"
                      : "thread",
                    value: { id: row.id },
                  }, { source: "link" })
                : undefined}
              columns={section === "usage"
                ? [
                  "dimensions",
                  "attempts",
                  "inputTokens",
                  "outputTokens",
                  "totalCostUsd",
                ]
                : config.columns}
            />
          )}
      </Screen>
    );
  },
});

export default view;
