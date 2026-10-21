/** @jsxRuntime classic */
/** @jsx React.createElement */
/** @jsxFrag React.Fragment */
"use client";
/**
 * Space section tabs: a real tablist with roving focus. In a narrow container
 * the tabs become icons with tooltips, so every section stays reachable.
 * @module
 */
// deno-lint-ignore verbatim-module-syntax -- classic JSX requires this runtime import.
import * as React from "react";
import {
  cn,
  dom,
  Icon,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@copilotz/copilotz/web/kit";
import type { SpaceSection } from "../model.ts";

export function SpaceTabs(
  { sections, selected, onSelect, marked, panelId }: {
    sections: readonly SpaceSection[];
    selected: string;
    onSelect(id: string): void;
    /** Sections with unseen agent activity (a dot on the tab). */
    marked?: ReadonlySet<string>;
    panelId: string;
  },
): React.ReactElement {
  return (
    <div className="@container/tabs min-w-0">
      <div
        role="tablist"
        aria-label="Space sections"
        className="flex min-w-0 gap-0.5 overflow-x-auto [scrollbar-width:none]"
        onKeyDown={(event) => {
          const tabs = Array.from(
            dom(event.currentTarget).querySelectorAll('[role="tab"]'),
          );
          const index = tabs.indexOf(dom(event.target));
          if (index < 0) return;
          const next = event.key === "ArrowRight"
            ? (index + 1) % tabs.length
            : event.key === "ArrowLeft"
            ? (index + tabs.length - 1) % tabs.length
            : event.key === "Home"
            ? 0
            : event.key === "End"
            ? tabs.length - 1
            : -1;
          if (next < 0) return;
          event.preventDefault();
          tabs[next].focus();
          tabs[next].click();
        }}
      >
        {sections.map((section) => {
          const active = section.id === selected;
          const dot = marked?.has(section.id) && !active;
          return (
            <Tooltip key={section.id}>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  role="tab"
                  id={`tab-${section.id}`}
                  aria-selected={active}
                  aria-controls={panelId}
                  aria-label={dot
                    ? `${section.label}, new activity`
                    : section.label}
                  tabIndex={active ? 0 : -1}
                  onClick={() => onSelect(section.id)}
                  className={cn(
                    "focus-visible:ring-ring/45 relative inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-sm whitespace-nowrap outline-none focus-visible:ring-[3px]",
                    active
                      ? "bg-accent text-foreground font-medium"
                      : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
                  )}
                >
                  <Icon name={section.icon} className="size-4 shrink-0" />
                  <span
                    className={cn(
                      "@max-[42rem]/tabs:sr-only",
                      !section.icon && "@max-[42rem]/tabs:not-sr-only",
                    )}
                  >
                    {section.label}
                  </span>
                  {dot && (
                    <span
                      aria-hidden="true"
                      className="bg-info absolute top-1 right-1 size-1.5 rounded-full"
                    />
                  )}
                </button>
              </TooltipTrigger>
              <TooltipContent className="@min-[42rem]/tabs:hidden">
                {section.label}
              </TooltipContent>
            </Tooltip>
          );
        })}
      </div>
    </div>
  );
}
