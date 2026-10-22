/** @jsxRuntime classic */
/** @jsx React.createElement */
/** @jsxFrag React.Fragment */
// deno-lint-ignore verbatim-module-syntax -- classic JSX requires this runtime import.
import * as React from "react";
import { useEffect, useRef } from "react";
import { defineView, type ViewDefinition } from "@copilotz/copilotz/views";
import type { BrowserViewContext } from "@copilotz/copilotz/web";
import { readSpaces, readThreads } from "@copilotz/copilotz/core/web";
import { isReconnecting, ReadStatus } from "@copilotz/copilotz/web/kit";
import {
  type MenuItem,
  menuItems,
  NO_SPACE_GROUP,
  openGroups,
  revealGroup,
  shellPreferences,
  shellState,
  toggleGroup,
} from "../../model.ts";
import { Sidebar } from "../../components/sidebar.tsx";
import { UserMenu } from "../../components/user-menu.tsx";
import { nextSidebar } from "../shell/index.tsx";

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};

/** Run an app menu item: its Action, or its dialog View. */
export function runMenuItem(
  ctx: BrowserViewContext,
  item: MenuItem,
  input: Readonly<{ threadId?: string | null; spaceId?: string | null }>,
): void {
  if (item.page) {
    ctx.actions.shellOpenPage({ page: item.page });
    return;
  }
  if (item.dialog) {
    ctx.actions.shellDialog({
      reference: { shows: item.dialog, value: { ...input } },
    });
    return;
  }
  const action = item.action ? ctx.actions[item.action] : undefined;
  if (!action) return;
  action({ ...input }).result().catch((cause: unknown) =>
    ctx.actions.shellToast({
      text: cause instanceof Error ? cause.message : `${item.label} failed.`,
      tone: "error",
    })
  );
}

/**
 * Once a different conversation (or Space) opens, its group shows, even if
 * the person collapsed it before. Not on the first render: a reload keeps
 * what they chose.
 */
function RevealOnOpen(
  { opened, group, onReveal }: {
    /** The open conversation or Space. */
    opened: string | null;
    /** Its sidebar group, once known. */
    group: string | undefined;
    onReveal(group: string): void;
  },
): null {
  const handled = useRef(opened);
  useEffect(() => {
    if (!opened || !group || handled.current === opened) return;
    handled.current = opened;
    onReveal(group);
  }, [opened, group]);
  return null;
}

/** The sidebar over live conversations and Spaces. */
const view: ViewDefinition<unknown, React.ReactNode, BrowserViewContext> =
  defineView<unknown, React.ReactNode, BrowserViewContext>({
    id: "ui.sidebar",
    shows: "shellSidebar",
    renderer: "react",
    modes: ["full"],
    render(_value, ctx) {
      const nav = shellState(ctx.collections.shell.get("main").value);
      const preferences = shellPreferences(
        ctx.collections.shellPreferences.get("main").value,
      );
      const overlay = ctx.collections.shellOverlay.get("main").value;
      const threadsRead = readThreads(ctx);
      const threads = threadsRead.value;
      const spaces = readSpaces(ctx).value;
      const shell = record(ctx.resources.shell);
      const features = record(shell.features);
      const labels = record(shell.labels);
      const sender = record(record(ctx.resources.chat).sender);
      const spacesEnabled = features.spaces !== false &&
        Boolean(ctx.collections.space);
      const current = threads.find((thread) => thread.id === nav.threadId);
      const currentGroup = current
        ? typeof current.spaceId === "string" && current.spaceId
          ? current.spaceId
          : NO_SPACE_GROUP
        : undefined;
      // Group state is each person's own, so people sharing a browser keep theirs.
      const person = typeof sender.id === "string"
        ? sender.id
        : typeof sender.externalId === "string"
        ? sender.externalId
        : "";
      const expanded = openGroups(preferences, person, [
        nav.spaceId,
        currentGroup,
      ]);
      const actions = ctx.actions;
      const reveal = (group: string) => {
        const patch = revealGroup(preferences, person, group);
        if (patch) actions.shellPreference(patch);
      };
      // On a phone the sidebar is a drawer: picking somewhere to go closes it.
      const drawer = overlay?.drawer === true;
      const leave =
        <T extends unknown[]>(go: (...args: T) => void) => (...args: T) => {
          go(...args);
          if (drawer) actions.shellOverlay({ drawer: false });
        };
      const result = (handle: { result(): Promise<unknown> }) =>
        handle.result();
      const toast = (text: string, tone: "info" | "error" = "info") =>
        actions.shellToast({ text, tone });
      return (
        <>
          <RevealOnOpen
            opened={nav.threadId}
            group={currentGroup}
            onReveal={reveal}
          />
          <RevealOnOpen
            opened={nav.spaceId}
            group={nav.spaceId ?? undefined}
            onReveal={reveal}
          />
          <Sidebar
            brand={record(shell.branding) as {
              title?: string;
              subtitle?: string;
              logoUrl?: string;
            }}
            labels={labels as Record<string, string>}
            threads={threads}
            spaces={spaces}
            currentThreadId={nav.threadId}
            currentSpaceId={nav.spaceId}
            groupBy={preferences.groupBy}
            showArchived={preferences.archived}
            expanded={expanded}
            spacesEnabled={spacesEnabled}
            announce={toast}
            creatingSpace={overlay?.createSpace === true}
            onCreatingSpace={(open) =>
              ctx.actions.shellOverlay({ createSpace: open })}
            drawer={drawer}
            onNewChat={leave((spaceId?: string) =>
              actions.shellNewChat(spaceId ? { spaceId } : {})
            )}
            onOpenThread={leave((threadId: string) =>
              actions.shellOpenThread({ threadId })
            )}
            onOpenSpace={leave((spaceId: string) =>
              actions.shellOpenSpace({ spaceId })
            )}
            onToggleSpace={(group, open) =>
              actions.shellPreference(
                toggleGroup(preferences, person, group, open),
              )}
            onGroupBy={(groupBy) => actions.shellPreference({ groupBy })}
            onShowArchived={(archived) => actions.shellPreference({ archived })}
            onToggleSidebar={() =>
              drawer
                ? actions.shellOverlay({ drawer: false })
                : actions.shellPreference({
                  sidebar: nextSidebar(preferences.sidebar),
                })}
            onOpenSearch={leave(() => actions.shellPalette({ open: true }))}
            onRename={actions.chatRenameThread
              ? (threadId, name) =>
                result(actions.chatRenameThread({ threadId, name }))
              : undefined}
            onArchive={actions.chatArchiveThread
              ? (threadId, archived) =>
                result(actions.chatArchiveThread({ threadId, archived })).then(
                  () =>
                    toast(
                      archived
                        ? "Conversation archived."
                        : "Conversation restored.",
                    ),
                )
              : undefined}
            onDelete={actions.chatDeleteThread
              ? async (threadId) => {
                await result(actions.chatDeleteThread({ threadId }));
                if (nav.threadId === threadId) actions.shellNewChat({});
                toast("Conversation deleted.");
              }
              : undefined}
            onMove={spacesEnabled && actions.chatMoveThread
              ? (threadId, spaceId, fromSpaceId) =>
                result(
                  actions.chatMoveThread({ threadId, spaceId, fromSpaceId }),
                )
              : undefined}
            onCreateSpace={spacesEnabled && actions.chatCreateSpace
              ? async (value) => {
                const created = await result(
                  actions.chatCreateSpace(value),
                ) as { spaceId?: string } | undefined;
                return created?.spaceId;
              }
              : undefined}
            onUpdateSpace={spacesEnabled && actions.chatUpdateSpace
              ? (spaceId, value) =>
                result(actions.chatUpdateSpace({ spaceId, ...value }))
              : undefined}
            onDeleteSpace={spacesEnabled && actions.chatDeleteSpace
              ? async (spaceId) => {
                await result(actions.chatDeleteSpace({ spaceId }));
                if (nav.spaceId === spaceId) actions.shellCloseSpace({});
                toast("Space deleted.");
              }
              : undefined}
            status={(threadsRead.status !== "ready" &&
                !isReconnecting(threadsRead)) || threadsRead.pending
              ? (
                <ReadStatus
                  state={threadsRead}
                  noun="conversations"
                  compact
                />
              )
              : undefined}
            footer={
              <UserMenu
                user={{
                  name: typeof sender.name === "string"
                    ? sender.name
                    : undefined,
                  email: typeof sender.email === "string"
                    ? sender.email
                    : undefined,
                }}
                theme={preferences.theme}
                onTheme={(theme) => actions.shellPreference({ theme })}
                onProfile={Object.keys(sender).length
                  ? leave(() =>
                    actions.shellDialog({
                      reference: { shows: "userProfile", value: null },
                    })
                  )
                  : undefined}
                items={menuItems(ctx.resources.userMenu)}
                onItem={leave((item: MenuItem) => runMenuItem(ctx, item, {}))}
              />
            }
          />
        </>
      );
    },
  });

export default view;
