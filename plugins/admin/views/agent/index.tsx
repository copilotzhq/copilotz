/** @jsxRuntime classic */
/** @jsx React.createElement */
// deno-lint-ignore verbatim-module-syntax -- classic JSX requires this runtime import.
import * as React from "react";
import { defineView } from "@copilotz/copilotz/views";
import type { BrowserViewContext } from "@copilotz/copilotz/web";
import {
  DetailList,
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
    const capabilities = agent?.capabilities &&
        typeof agent.capabilities === "object"
      ? Object.entries(agent.capabilities as Record<string, unknown>)
      : [];
    return (
      <Frame ctx={ctx} title={String(agent?.name ?? "Agent")}>
        <ReadStatus state={state} noun="agent" />
        {failed && (
          <Notice tone="error">
            {response?.status === 403 || response?.status === 401
              ? "You don't have access to this agent."
              : "This agent couldn't be loaded. Try again in a moment."}
          </Notice>
        )}
        {agent && (
          <DetailList
            items={[
              ["Name", agent.name],
              ["ID", <code key="id" className="text-xs">{id}</code>],
              ["Role", agent.role],
              [
                "Capabilities",
                capabilities.length
                  ? (
                    <ul key="capabilities" className="flex flex-wrap gap-1.5">
                      {capabilities.map(([name, value]) => (
                        <li
                          key={name}
                          className="bg-muted rounded-md px-2 py-0.5 text-xs"
                        >
                          {value === true
                            ? name
                            : `${name}: ${
                              typeof value === "object"
                                ? JSON.stringify(value)
                                : String(value)
                            }`}
                        </li>
                      ))}
                    </ul>
                  )
                  : null,
              ],
            ]}
          />
        )}
        {!failed && !agent && state.status === "ready" && (
          <EmptyState title="Agent unavailable">
            This agent isn't configured in this app.
          </EmptyState>
        )}
      </Frame>
    );
  },
});

export default view;
