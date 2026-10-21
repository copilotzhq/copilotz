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
export const ADMIN_SECTIONS: readonly (TabItem & { description: string })[] = [
  {
    id: "overview",
    label: "Overview",
    icon: "gauge",
    description: "Totals across conversations, people and model usage.",
  },
  {
    id: "agents",
    label: "Agents",
    icon: "bot",
    description: "The agents configured in this app.",
  },
  {
    id: "threads",
    label: "Conversations",
    icon: "message",
    description: "Every conversation, most recently updated first.",
  },
  {
    id: "participants",
    label: "People",
    icon: "users",
    description: "People, agents and tools taking part in conversations.",
  },
  {
    id: "activity",
    label: "Activity",
    icon: "chart",
    description: "Messages, tool calls and tokens per day.",
  },
  {
    id: "usage",
    label: "Usage",
    icon: "zap",
    description: "Model calls, tokens and cost by model.",
  },
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

type Totals = Record<string, number | undefined>;

/** The overview's figures: known totals as labelled cards, others generic. */
function overviewMetrics(
  data: Record<string, unknown>,
): { label: string; value: string; hint?: string }[] {
  const totals = (key: string) =>
    (data[key] && typeof data[key] === "object" ? data[key] : {}) as Totals;
  const known = [
    "threadTotals",
    "messageTotals",
    "participantTotals",
    "llmTotals",
    "toolTotals",
  ];
  if (!known.some((key) => key in data)) {
    return Object.entries(data).map(([label, value]) => ({
      label: humanize(label),
      value: figure(value),
    }));
  }
  const threads = totals("threadTotals"), people = totals("participantTotals");
  const llm = totals("llmTotals"), tools = totals("toolTotals");
  const count = (value: number | undefined) => formatCount(value ?? 0);
  return [
    {
      label: "Conversations",
      value: count(threads.total),
      hint: `${count(threads.active)} active · ${
        count(threads.archived)
      } archived`,
    },
    { label: "Messages", value: count(totals("messageTotals").total) },
    {
      label: "People",
      value: count(people.human),
      hint: `${count(people.agent)} agents · ${count(people.tool)} tools`,
    },
    {
      label: "Model calls",
      value: count(llm.totalCalls),
      hint: `${count(llm.totalTokens)} tokens`,
    },
    { label: "Tool calls", value: count(tools.totalCalls) },
    {
      label: "Cost (USD)",
      value: `$${
        ((llm.totalCostUsd ?? 0) + (tools.totalCostUsd ?? 0)).toFixed(2)
      }`,
    },
  ];
}

function refusal(status: number): string {
  return status === 401 || status === 403
    ? "You don't have access to this section."
    : status === 404
    ? "This section isn't available in this app."
    : "This section couldn't be loaded. Try again in a moment.";
}

/**
 * One section's body, read through the caller's context. The administration
 * page calls it with its own context, so a page opened from a link holds the
 * query until the user loads it, as the query View does.
 */
export function adminSection(
  ctx: BrowserViewContext,
  section: string,
  query: Readonly<Record<string, string>> = {},
): React.ReactElement {
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
  const failed = Boolean(response?.status && response.status >= 400);
  const data = failed ? undefined : response?.data;
  const analytics = data && typeof data === "object" && !Array.isArray(data)
    ? data as Record<string, unknown>
    : undefined;
  const rows =
    (Array.isArray(data)
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
  const ready = state.status === "ready" && !failed;
  return (
    <div className="grid min-w-0 gap-4">
      <ReadStatus state={state} noun={config.noun} />
      {failed && response?.status && (
        <Notice tone="error">{refusal(response.status)}</Notice>
      )}
      {ready && section === "overview" && analytics && (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {overviewMetrics(analytics).map((metric) => (
            <Metric key={metric.label} {...metric} />
          ))}
        </div>
      )}
      {ready && section !== "overview" && (
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
    </div>
  );
}

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
  url: true,
  render({ section, query = {} }, ctx) {
    const known = ADMIN_SECTIONS.find((item) => item.id === section);
    return (
      <Screen
        title={known?.label ?? humanize(section)}
        description={known?.description}
        density={ctx.hints.mode}
      >
        {adminSection(ctx, section, query)}
      </Screen>
    );
  },
});

export default view;
