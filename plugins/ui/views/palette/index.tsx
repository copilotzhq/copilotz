/** @jsxRuntime classic */
/** @jsx React.createElement */
/** @jsxFrag React.Fragment */
// deno-lint-ignore verbatim-module-syntax -- classic JSX requires this runtime import.
import * as React from "react";
import {
  MessageSquare,
  Monitor,
  Moon,
  PanelLeft,
  PanelRight,
  Plus,
  SquarePen,
  Sun,
} from "lucide-react";
import { defineView, type ViewDefinition } from "@copilotz/copilotz/views";
import type { BrowserViewContext } from "@copilotz/copilotz/web";
import { readSpaces, readThreads } from "@copilotz/copilotz/core/web";
import { formatRelative } from "@copilotz/copilotz/web/kit";
import { shellPreferences, shellState } from "../../model.ts";
import {
  type Command,
  CommandPalette,
} from "../../components/command-palette.tsx";
import { SpaceMark } from "../../components/space-mark.tsx";
import { nextSidebar } from "../shell/index.tsx";

/** ⌘K. Reads conversations and Spaces only while open. */
const view: ViewDefinition<unknown, React.ReactNode, BrowserViewContext> =
  defineView<unknown, React.ReactNode, BrowserViewContext>({
    id: "ui.palette",
    shows: "shellPalette",
    renderer: "react",
    modes: ["full"],
    render(_value, ctx) {
      const open = ctx.collections.shellOverlay.get("main").value?.palette ===
        true;
      const setOpen = (value: boolean) =>
        ctx.actions.shellPalette({ open: value });
      if (!open) {
        return (
          <CommandPalette open={false} onOpenChange={setOpen} commands={[]} />
        );
      }
      const nav = shellState(ctx.collections.shell.get("main").value);
      const preferences = shellPreferences(
        ctx.collections.shellPreferences.get("main").value,
      );
      const actions = ctx.actions;
      const spaces = readSpaces(ctx).value.filter((space) =>
        space.status !== "archived"
      );
      const names = new Map(
        spaces.map((space) => [space.id, String(space.name ?? space.id)]),
      );
      const threads = readThreads(ctx).value.filter((thread) =>
        thread.status !== "archived"
      );
      const commands: Command[] = [
        {
          id: "new-chat",
          group: "Actions",
          label: "New chat",
          icon: <SquarePen />,
          run: () => actions.shellNewChat({}),
        },
        ...(actions.chatCreateSpace
          ? [{
            id: "new-space",
            group: "Actions",
            label: "New Space",
            icon: <Plus />,
            keywords: "create space",
            run: () => actions.shellOverlay({ createSpace: true }),
          }]
          : []),
        {
          id: "sidebar",
          group: "Actions",
          label: "Toggle sidebar",
          hint: "⌘B",
          icon: <PanelLeft />,
          run: () =>
            actions.shellPreference({
              sidebar: nextSidebar(preferences.sidebar),
            }),
        },
        ...(nav.threadId && !nav.spaceId
          ? [{
            id: "panel",
            group: "Actions",
            label: nav.panel ? "Hide side panel" : "Show side panel",
            hint: "⌘.",
            icon: <PanelRight />,
            run: () => actions.shellPanel({ open: !nav.panel }),
          }]
          : []),
        ...(["light", "dark", "system"] as const).map((theme) => ({
          id: `theme-${theme}`,
          group: "Actions",
          label: `Theme: ${theme[0].toUpperCase()}${theme.slice(1)}`,
          keywords: "appearance dark light",
          icon: theme === "light"
            ? <Sun />
            : theme === "dark"
            ? <Moon />
            : <Monitor />,
          run: () => actions.shellPreference({ theme }),
        })),
        ...spaces.map((space) => ({
          id: `space-${space.id}`,
          group: "Spaces",
          label: String(space.name ?? space.id),
          keywords: String(space.description ?? ""),
          icon: <SpaceMark id={space.id} name={String(space.name ?? "")} />,
          run: () => actions.shellOpenSpace({ spaceId: space.id }),
        })),
        ...threads.map((thread) => ({
          id: `thread-${thread.id}`,
          group: "Conversations",
          label: String(thread.name ?? "") || "New conversation",
          hint: [
            typeof thread.spaceId === "string"
              ? names.get(thread.spaceId)
              : undefined,
            thread.updatedAt ? formatRelative(String(thread.updatedAt)) : "",
          ].filter(Boolean).join(" · "),
          keywords: typeof thread.spaceId === "string"
            ? names.get(thread.spaceId)
            : "",
          icon: <MessageSquare />,
          run: () => actions.shellOpenThread({ threadId: thread.id }),
        })),
      ];
      return <CommandPalette open onOpenChange={setOpen} commands={commands} />;
    },
  });

export default view;
