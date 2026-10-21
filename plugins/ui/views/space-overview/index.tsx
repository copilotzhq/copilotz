/** @jsxRuntime classic */
/** @jsx React.createElement */
/** @jsxFrag React.Fragment */
// deno-lint-ignore verbatim-module-syntax -- classic JSX requires this runtime import.
import * as React from "react";
import { useState } from "react";
import { MessageSquare, Pencil, Users } from "lucide-react";
import { defineView, type ViewDefinition } from "@copilotz/copilotz/views";
import type { BrowserViewContext } from "@copilotz/copilotz/web";
import {
  Button,
  cn,
  formatRelative,
  Markdown,
  NameDescriptionDialog,
  ReadStatus,
} from "@copilotz/copilotz/web/kit";

/** A Space's description and its counts; editable by those who may. */
const view: ViewDefinition<
  { spaceId: string; threadId?: string | null },
  React.ReactNode,
  BrowserViewContext
> = defineView<
  { spaceId: string; threadId?: string | null },
  React.ReactNode,
  BrowserViewContext
>({
  id: "ui.spaceOverview",
  shows: "spaceOverview",
  renderer: "react",
  modes: ["full", "panel"],
  url: true,
  render({ spaceId }, ctx) {
    const space = ctx.collections.space.get(spaceId);
    const threads = ctx.collections.thread.list({
      where: { spaceId },
      order: { field: "id", direction: "desc" },
      limit: 200,
    });
    const value = space.value;
    if (!value) return <ReadStatus state={space} noun="Space" />;
    const members = Array.isArray(value.memberIds) ? value.memberIds.length : 0;
    return (
      <Overview
        panel={ctx.hints.mode === "panel"}
        name={String(value.name ?? "")}
        description={String(value.description ?? "")}
        updatedAt={String(value.updatedAt ?? "")}
        conversations={threads.status === "ready"
          ? threads.value.filter((thread) => thread.status !== "archived")
            .length
          : undefined}
        members={members}
        onOpen={(section) => ctx.actions.shellSection?.({ section })}
        onSave={ctx.actions.chatUpdateSpace
          ? (patch) =>
            ctx.actions.chatUpdateSpace({ spaceId, ...patch }).result()
          : undefined}
      />
    );
  },
});

function Overview(
  {
    panel,
    name,
    description,
    updatedAt,
    conversations,
    members,
    onOpen,
    onSave,
  }: {
    panel: boolean;
    name: string;
    description: string;
    updatedAt: string;
    conversations?: number;
    members: number;
    onOpen(section: string): void;
    onSave?(patch: { name: string; description: string }): Promise<unknown>;
  },
): React.ReactElement {
  const [editing, setEditing] = useState(false);
  return (
    <div
      className={cn(
        "mx-auto grid w-full gap-5",
        panel ? "p-4" : "max-w-3xl p-4 sm:p-8",
      )}
    >
      <div className="grid gap-2">
        {description
          ? <Markdown className="text-muted-foreground">{description}</Markdown>
          : (
            <p className="text-muted-foreground text-sm">
              No description yet.
            </p>
          )}
        {updatedAt && (
          <p className="text-muted-foreground text-xs">
            Updated {formatRelative(updatedAt)}
          </p>
        )}
      </div>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => onOpen("conversations")}
          className="hover:bg-accent focus-visible:ring-ring/45 flex items-center gap-2 rounded-lg border px-3 py-2 text-sm outline-none focus-visible:ring-[3px]"
        >
          <MessageSquare
            aria-hidden="true"
            className="text-muted-foreground size-4"
          />
          {conversations === undefined
            ? "Chats"
            : `${conversations} chat${conversations === 1 ? "" : "s"}`}
        </button>
        <button
          type="button"
          onClick={() => onOpen("members")}
          className="hover:bg-accent focus-visible:ring-ring/45 flex items-center gap-2 rounded-lg border px-3 py-2 text-sm outline-none focus-visible:ring-[3px]"
        >
          <Users aria-hidden="true" className="text-muted-foreground size-4" />
          {`${members} member${members === 1 ? "" : "s"}`}
        </button>
      </div>
      {onSave && (
        <div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setEditing(true)}
          >
            <Pencil /> Edit Space
          </Button>
          <NameDescriptionDialog
            open={editing}
            onOpenChange={setEditing}
            title="Edit Space"
            initial={{ name, description }}
            onSubmit={onSave}
          />
        </div>
      )}
    </div>
  );
}

export default view;
