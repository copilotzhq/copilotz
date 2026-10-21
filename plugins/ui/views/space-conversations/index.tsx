/** @jsxRuntime classic */
/** @jsx React.createElement */
/** @jsxFrag React.Fragment */
// deno-lint-ignore verbatim-module-syntax -- classic JSX requires this runtime import.
import * as React from "react";
import { useState } from "react";
import { MessageSquare, SquarePen } from "lucide-react";
import { defineView, type ViewDefinition } from "@copilotz/copilotz/views";
import type { BrowserViewContext, Row } from "@copilotz/copilotz/web";
import {
  Badge,
  Button,
  cn,
  formatRelative,
  ReadStatus,
  ResourceList,
  ResourceRow,
  ResourceToolbar,
} from "@copilotz/copilotz/web/kit";

function Conversations(
  { rows, panel, current, onOpen, onNew }: {
    rows: readonly Row[];
    panel: boolean;
    current: string | null;
    onOpen(id: string): void;
    onNew(): void;
  },
): React.ReactElement {
  const [query, setQuery] = useState("");
  const visible = rows.filter((row) =>
    String(row.name ?? "").toLowerCase().includes(query.trim().toLowerCase())
  );
  return (
    <div
      className={cn(
        "mx-auto grid w-full gap-3",
        panel ? "p-3" : "max-w-3xl p-4 sm:p-6",
      )}
    >
      <ResourceToolbar
        search={query}
        onSearch={setQuery}
        searchLabel="Search chats"
      >
        <Button type="button" size="sm" onClick={onNew}>
          <SquarePen /> New chat
        </Button>
      </ResourceToolbar>
      {visible.length
        ? (
          <ResourceList label="Chats in this Space">
            {visible.map((row) => (
              <ResourceRow
                key={row.id}
                leading={
                  <MessageSquare
                    aria-hidden="true"
                    className="text-muted-foreground size-4"
                  />
                }
                title={String(row.name ?? "") || "New conversation"}
                meta={
                  <>
                    {row.status === "archived" && (
                      <Badge variant="outline">Archived</Badge>
                    )}
                    {row.updatedAt
                      ? (
                        <time dateTime={String(row.updatedAt)}>
                          {formatRelative(String(row.updatedAt))}
                        </time>
                      )
                      : null}
                  </>
                }
                selected={current === row.id}
                onOpen={() => onOpen(row.id)}
              />
            ))}
          </ResourceList>
        )
        : (
          <p className="text-muted-foreground py-6 text-center text-sm">
            {query.trim()
              ? `No chats match “${query.trim()}”.`
              : "No chats in this Space yet."}
          </p>
        )}
    </div>
  );
}

/** The conversations attached to a Space. */
const view: ViewDefinition<
  { spaceId: string; threadId?: string | null },
  React.ReactNode,
  BrowserViewContext
> = defineView<
  { spaceId: string; threadId?: string | null },
  React.ReactNode,
  BrowserViewContext
>({
  id: "ui.spaceConversations",
  shows: "spaceConversations",
  renderer: "react",
  modes: ["full", "panel"],
  url: true,
  render({ spaceId, threadId = null }, ctx) {
    const threads = ctx.collections.thread.list({
      where: { spaceId },
      order: { field: "id", direction: "desc" },
      limit: 200,
    });
    if (threads.status !== "ready") {
      return (
        <div className="p-4">
          <ReadStatus state={threads} noun="chats" />
        </div>
      );
    }
    const rows = [...threads.value].sort((left, right) =>
      String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? ""))
    );
    return (
      <Conversations
        rows={rows}
        panel={ctx.hints.mode === "panel"}
        current={threadId}
        onOpen={(id) => ctx.actions.shellOpenThread?.({ threadId: id })}
        onNew={() => ctx.actions.shellNewChat?.({ spaceId })}
      />
    );
  },
});

export default view;
