/** @jsxRuntime classic */
/** @jsx React.createElement */
/** @jsxFrag React.Fragment */
// deno-lint-ignore verbatim-module-syntax -- classic JSX requires this runtime import.
import * as React from "react";
import { defineView } from "@copilotz/copilotz/views";
import type { BrowserViewContext } from "@copilotz/copilotz/web";
import { Screen, showSafely, TabBar } from "@copilotz/copilotz/web/kit";
import { ADMIN_SECTIONS } from "../query/index.tsx";

/**
 * The administration page: one tab per section, each an authorized query
 * Action. A tab navigates with `region: "main"`, so the section lives in the
 * shell's URL state (`?page=admin&section=agents`).
 */
const view: import("@copilotz/copilotz/views").ViewDefinition<
  { section?: string } | null,
  React.ReactNode,
  BrowserViewContext
> = defineView<
  { section?: string } | null,
  React.ReactNode,
  BrowserViewContext
>(
  {
    id: "admin.overview",
    shows: "admin",
    renderer: "react",
    modes: ["full", "panel"],
    url: true,
    render(value, ctx) {
      const section = ADMIN_SECTIONS.find((item) => item.id === value?.section)
        ?.id ?? "overview";
      return (
        <Screen
          title="Administration"
          description="Agents, conversations, people and usage for this app."
          density={ctx.hints.mode}
        >
          <TabBar
            label="Administration sections"
            idPrefix="admin-tab"
            panelId="admin-section"
            items={ADMIN_SECTIONS}
            selected={section}
            onSelect={(next) =>
              ctx.show({ shows: "admin", value: { section: next } }, {
                source: "link",
                region: "main",
              })}
          />
          <div
            role="tabpanel"
            id="admin-section"
            aria-labelledby={`admin-tab-${section}`}
            className="grid min-w-0 gap-4"
          >
            {showSafely(
              ctx,
              { shows: "adminQuery", value: { section, embedded: true } },
              { mode: ctx.hints.mode },
              "This section",
            )}
          </div>
        </Screen>
      );
    },
  },
);

export default view;
