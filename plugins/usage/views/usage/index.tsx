/** @jsxRuntime classic */
/** @jsx React.createElement */
/** @jsxFrag React.Fragment */
// deno-lint-ignore verbatim-module-syntax -- classic JSX requires this runtime import.
import * as React from "react";
import { defineView } from "@copilotz/copilotz/views";
import type { BrowserViewContext } from "@copilotz/copilotz/web";
import {
  formatCount,
  Metric,
  ReadStatus,
  ResourceTable,
  Screen,
} from "@copilotz/copilotz/web/kit";
const view: import("@copilotz/copilotz/views").ViewDefinition<
  unknown,
  React.ReactNode,
  BrowserViewContext
> = defineView<unknown, React.ReactNode, BrowserViewContext>({
  id: "usage.summary",
  shows: "usage",
  renderer: "react",
  modes: ["full", "panel"],
  url: true,
  render(_item, ctx) {
    const usage = ctx.collections.usage.list({ limit: 100 });
    const sum = (key: string) =>
      usage.value.reduce(
        (total, row) =>
          total + (typeof row[key] === "number" ? row[key] as number : 0),
        0,
      );
    return (
      <Screen
        title="Usage"
        description="Totals for the most recent model calls."
        density={ctx.hints.mode}
      >
        <ReadStatus state={usage} noun="usage" />
        <div className="grid gap-3 sm:grid-cols-3">
          <Metric label="Model calls" value={formatCount(usage.value.length)} />
          <Metric label="Tokens" value={formatCount(sum("totalTokens"))} />
          <Metric
            label="Cost (USD)"
            value={`$${sum("totalCostUsd").toFixed(4)}`}
          />
        </div>
        <ResourceTable
          rows={usage.value}
          columns={[
            "model",
            "status",
            "totalTokens",
            "totalCostUsd",
            "createdAt",
          ]}
          labels={{
            totalTokens: "Tokens",
            totalCostUsd: "Cost (USD)",
            createdAt: "When",
          }}
          emptyTitle="No model calls yet"
        />
      </Screen>
    );
  },
});

export default view;
