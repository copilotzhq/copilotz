/** @jsxRuntime classic */
/** @jsx React.createElement */
/** @jsxFrag React.Fragment */
"use client";
/**
 * A tablist with roving focus (arrows, Home, End). In a narrow container the
 * tabs with icons become icons with tooltips, so every tab stays reachable.
 * @module
 */
// deno-lint-ignore verbatim-module-syntax -- classic JSX requires this runtime import.
import * as React from "react";
import { cn } from "../utils.ts";
import { dom } from "../dom.ts";
import { Icon } from "../icon.tsx";
import { Tooltip, TooltipContent, TooltipTrigger } from "./tooltip.tsx";

/** One tab: `marked` shows a dot (such as unseen activity). */
export interface TabItem {
  id: string;
  label: string;
  icon?: string;
  marked?: boolean;
}

/** Tabs that select a panel; the caller renders the panel with `panelId`. */
export function TabBar(
  { items, selected, onSelect, label, panelId, idPrefix = "tab" }: {
    items: readonly TabItem[];
    selected: string;
    onSelect(id: string): void;
    /** The tablist's accessible name. */
    label: string;
    panelId: string;
    idPrefix?: string;
  },
): React.ReactElement {
  return (
    <div className="@container/tabs min-w-0">
      <div
        role="tablist"
        aria-label={label}
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
        {items.map((item) => {
          const active = item.id === selected;
          const dot = item.marked && !active;
          return (
            <Tooltip key={item.id}>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  role="tab"
                  id={`${idPrefix}-${item.id}`}
                  aria-selected={active}
                  aria-controls={panelId}
                  aria-label={dot ? `${item.label}, new activity` : item.label}
                  tabIndex={active ? 0 : -1}
                  onClick={() => onSelect(item.id)}
                  className={cn(
                    "focus-visible:ring-ring/45 relative inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-sm whitespace-nowrap outline-none focus-visible:ring-[3px]",
                    active
                      ? "bg-accent text-foreground font-medium"
                      : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
                  )}
                >
                  {item.icon && (
                    <Icon name={item.icon} className="size-4 shrink-0" />
                  )}
                  <span
                    className={cn(item.icon && "@max-[42rem]/tabs:sr-only")}
                  >
                    {item.label}
                  </span>
                  {dot && (
                    <span
                      aria-hidden="true"
                      className="bg-info absolute top-1 right-1 size-1.5 rounded-full"
                    />
                  )}
                </button>
              </TooltipTrigger>
              <TooltipContent
                className={item.icon ? "@min-[42rem]/tabs:hidden" : "hidden"}
              >
                {item.label}
              </TooltipContent>
            </Tooltip>
          );
        })}
      </div>
    </div>
  );
}
