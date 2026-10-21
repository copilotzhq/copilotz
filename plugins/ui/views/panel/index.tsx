/** @jsxRuntime classic */
/** @jsx React.createElement */
/** @jsxFrag React.Fragment */
// deno-lint-ignore verbatim-module-syntax -- classic JSX requires this runtime import.
import * as React from "react";
import { useState } from "react";
import { FolderInput, X } from "lucide-react";
import { defineView, type ViewDefinition } from "@copilotz/copilotz/views";
import type { BrowserViewContext } from "@copilotz/copilotz/web";
import { readSpaces } from "@copilotz/copilotz/core/web";
import { Button, EmptyState, showSafely } from "@copilotz/copilotz/web/kit";
import { shellPreferences, shellState } from "../../model.ts";
import { ResizablePanel } from "../../components/resizable-panel.tsx";
import { MovePicker } from "../../components/move-picker.tsx";
import { navReference } from "../shell/index.tsx";

function NoSpace(
  { ctx, threadId, title }: {
    ctx: BrowserViewContext;
    threadId: string;
    title: string;
  },
): React.ReactElement {
  const [picking, setPicking] = useState(false);
  const spaces = readSpaces(ctx).value.filter((space) =>
    space.status !== "archived"
  );
  return (
    <div className="flex h-full flex-col">
      <div className="flex h-12 shrink-0 items-center justify-end border-b px-1.5">
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label="Close the side panel"
          onClick={() => ctx.actions.shellPanel({ open: false })}
        >
          <X />
        </Button>
      </div>
      <div className="p-4">
        <EmptyState
          icon={<FolderInput />}
          title="Not in a Space yet"
          action={ctx.actions.chatMoveThread
            ? (
              <Button type="button" size="sm" onClick={() => setPicking(true)}>
                Move to a Space…
              </Button>
            )
            : undefined}
        >
          A Space keeps this conversation's boards, documents and other
          resources together. They show here once it's in one.
        </EmptyState>
      </div>
      {picking && (
        <MovePicker
          open
          onOpenChange={setPicking}
          title={title}
          current={null}
          spaces={spaces.map((space) => ({
            id: space.id,
            name: String(space.name ?? space.id),
          }))}
          onMove={(spaceId) =>
            ctx.actions.chatMoveThread({ threadId, spaceId, fromSpaceId: null })
              .result()}
        />
      )}
    </div>
  );
}

/**
 * The right panel beside a conversation: the conversation's Space sections,
 * or the app's `resources.shell.panel` View. Its width is the reader's.
 */
const view: ViewDefinition<
  { threadId: string },
  React.ReactNode,
  BrowserViewContext
> = defineView<{ threadId: string }, React.ReactNode, BrowserViewContext>({
  id: "ui.panel",
  shows: "shellPanel",
  renderer: "react",
  modes: ["full"],
  render({ threadId }, ctx) {
    const nav = shellState(ctx.collections.shell.get("main").value);
    const preferences = shellPreferences(
      ctx.collections.shellPreferences.get("main").value,
    );
    const thread = ctx.collections.thread.get(threadId).value;
    const spaceId = typeof thread?.spaceId === "string" ? thread.spaceId : null;
    const custom = (ctx.resources.shell as Record<string, unknown> | undefined)
      ?.panel as { view?: unknown } | undefined;
    const content = typeof custom?.view === "string"
      ? showSafely(
        ctx,
        navReference({
          shows: custom.view,
          value: { threadId, spaceId },
        }, nav.origin),
        { mode: "panel" },
        "The panel",
      )
      : spaceId
      ? showSafely(
        ctx,
        navReference(
          { shows: "space", value: { spaceId, threadId } },
          nav.origin,
        ),
        { mode: "panel" },
        "The panel",
      )
      : (
        <NoSpace
          ctx={ctx}
          threadId={threadId}
          title={String(thread?.name ?? "") || "This conversation"}
        />
      );
    return (
      <ResizablePanel
        label="Side panel"
        width={preferences.panelWidth}
        onResize={(panelWidth) => ctx.actions.shellPreference({ panelWidth })}
      >
        <div id="shell-panel" className="flex h-full min-h-0 flex-col">
          {content}
        </div>
      </ResizablePanel>
    );
  },
});

export default view;
