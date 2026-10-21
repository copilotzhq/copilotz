/** @jsxRuntime classic */
/** @jsx React.createElement */
// deno-lint-ignore verbatim-module-syntax -- classic JSX requires this runtime import.
import * as React from "react";
import { defineView } from "@copilotz/copilotz/views";
import type { BrowserViewContext } from "@copilotz/copilotz/web";
import {
  EmptyState,
  Frame,
  Notice,
  ReadStatus,
} from "@copilotz/copilotz/web/kit";

const view: import("@copilotz/copilotz/views").ViewDefinition<
  { id: string },
  React.ReactNode,
  BrowserViewContext
> = defineView<{ id: string }, React.ReactNode, BrowserViewContext>({
  id: "admin.agent",
  shows: "agent",
  renderer: "react",
  modes: ["full", "panel", "dialog"],
  url: true,
  render({ id }, ctx) {
    // Agents are public Resources exposed through the authorized query Action.
    const aliases = ctx.resources.admin?.actionAliases as
      | Readonly<Record<string, string>>
      | undefined;
    const state = ctx.readAction(aliases?.agents ?? "adminAgents", {
      resource: "agents",
      method: "GET",
      query: { limit: "100" },
    });
    const response = state.value as {
      status?: number;
      data?: Record<string, unknown>[];
    } | undefined;
    const failed = Boolean(response?.status && response.status >= 400);
    const agent = !failed && Array.isArray(response?.data)
      ? response.data.find((row) => row.id === id)
      : undefined;
    return (
      <Frame ctx={ctx} title={String(agent?.name ?? "Agent")}>
        <ReadStatus state={state} />
        {failed && <Notice tone="error">Unable to read this agent.</Notice>}
        {agent && (
          <dl className="grid gap-3">
            <dt>ID</dt>
            <dd>{id}</dd>
            <dt>Role</dt>
            <dd>{String(agent.role ?? "—")}</dd>
            <dt>Capabilities</dt>
            <dd>
              <pre className="overflow-x-auto whitespace-pre-wrap">{JSON.stringify(agent.capabilities ?? {}, null, 2)}</pre>
            </dd>
          </dl>
        )}
        {!failed && !agent && state.status === "ready" && (
          <EmptyState title="Agent unavailable" />
        )}
      </Frame>
    );
  },
});

export default view;
