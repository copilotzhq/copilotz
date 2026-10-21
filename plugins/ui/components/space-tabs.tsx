/** @jsxRuntime classic */
/** @jsx React.createElement */
"use client";
/** Space section tabs, with a dot on sections with unseen agent activity. @module */
// deno-lint-ignore verbatim-module-syntax -- classic JSX requires this runtime import.
import * as React from "react";
import { TabBar } from "@copilotz/copilotz/web/kit";
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
    <TabBar
      label="Space sections"
      panelId={panelId}
      selected={selected}
      onSelect={onSelect}
      items={sections.map((section) => ({
        id: section.id,
        label: section.label,
        icon: section.icon,
        marked: marked?.has(section.id),
      }))}
    />
  );
}
