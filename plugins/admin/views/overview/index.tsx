/** @jsxRuntime classic */
/** @jsx React.createElement */
/** @jsxFrag React.Fragment */
// deno-lint-ignore verbatim-module-syntax -- classic JSX requires this runtime import.
import * as React from "react";
import { defineView } from "@copilotz/copilotz/views";
import type { BrowserViewContext } from "@copilotz/copilotz/web";
import { TabBar } from "@copilotz/copilotz/web/kit";
import { ADMIN_SECTIONS, adminSection } from "../query/index.tsx";

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
      const current =
        ADMIN_SECTIONS.find((item) => item.id === value?.section) ??
          ADMIN_SECTIONS[0];
      const panel = ctx.hints.mode === "panel";
      return (
        <section
          aria-label="Administration"
          data-density={ctx.hints.mode}
          className={panel
            ? "flex w-full flex-col gap-3 p-4 text-sm"
            : "mx-auto flex w-full max-w-5xl flex-col gap-5 p-4 sm:p-6"}
        >
          <TabBar
            label="Administration sections"
            idPrefix="admin-tab"
            panelId="admin-section"
            items={ADMIN_SECTIONS}
            selected={current.id}
            onSelect={(next) =>
              ctx.show({ shows: "admin", value: { section: next } }, {
                source: "link",
                region: "main",
              })}
          />
          <div
            role="tabpanel"
            id="admin-section"
            aria-labelledby={`admin-tab-${current.id}`}
            className="grid min-w-0 gap-4"
          >
            <header className="grid gap-0.5">
              <h2 className="text-lg font-semibold tracking-tight">
                {current.label}
              </h2>
              <p className="text-muted-foreground text-sm">
                {current.description}
              </p>
            </header>
            {adminSection(ctx, current.id)}
          </div>
        </section>
      );
    },
  },
);

export default view;
