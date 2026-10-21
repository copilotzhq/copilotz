/** @jsxRuntime classic */
/** @jsx React.createElement */
/** @jsxFrag React.Fragment */
// deno-lint-ignore verbatim-module-syntax -- classic JSX requires this runtime import.
import * as React from "react";
import { useState } from "react";
import {
  Archive,
  ArchiveRestore,
  ArrowLeft,
  ArrowRightLeft,
  MoreHorizontal,
  PanelRight,
  Pencil,
  SquarePen,
  Trash2,
} from "lucide-react";
import { defineView, type ViewDefinition } from "@copilotz/copilotz/views";
import type { BrowserViewContext, Row } from "@copilotz/copilotz/web";
import { readSpaces } from "@copilotz/copilotz/core/web";
import {
  Button,
  cn,
  ConfirmDialog,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Icon,
  Kbd,
  NameDescriptionDialog,
  showSafely,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@copilotz/copilotz/web/kit";
import { type MenuItem, menuItems, shellState } from "../../model.ts";
import { SpaceMark } from "../../components/space-mark.tsx";
import { MovePicker } from "../../components/move-picker.tsx";
import { runMenuItem } from "../sidebar/index.tsx";

function ThreadMenu(
  { ctx, thread, spaces, items, spaceId }: {
    ctx: BrowserViewContext;
    thread: Row;
    spaces: readonly Row[];
    items: readonly MenuItem[];
    spaceId: string | null;
  },
): React.ReactElement {
  const [dialog, setDialog] = useState<"rename" | "move" | "delete" | null>(
    null,
  );
  const actions = ctx.actions;
  const name = String(thread.name ?? "") || "New conversation";
  const archived = thread.status === "archived";
  const toast = (text: string, tone: "info" | "error" = "info") =>
    actions.shellToast({ text, tone });
  const fail = (cause: unknown) =>
    toast(
      cause instanceof Error ? cause.message : "That didn't work.",
      "error",
    );
  const app = items.filter((item) => item.requires !== "space");
  return (
    <>
      <DropdownMenu>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="Conversation options"
              >
                <MoreHorizontal />
              </Button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent>Options</TooltipContent>
        </Tooltip>
        <DropdownMenuContent align="end" className="w-56">
          <DropdownMenuItem onSelect={() => actions.shellNewChat({})}>
            <SquarePen /> New chat
          </DropdownMenuItem>
          {app.length > 0 && <DropdownMenuSeparator />}
          {app.map((item) => (
            <DropdownMenuItem
              key={item.id}
              destructive={item.destructive}
              onSelect={() =>
                runMenuItem(ctx, item, { threadId: thread.id, spaceId })}
            >
              <Icon name={item.icon} /> {item.label}
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          {actions.chatRenameThread && (
            <DropdownMenuItem onSelect={() => setDialog("rename")}>
              <Pencil /> Rename…
            </DropdownMenuItem>
          )}
          {actions.chatMoveThread && ctx.collections.space && (
            <DropdownMenuItem onSelect={() => setDialog("move")}>
              <ArrowRightLeft /> Move to Space…
            </DropdownMenuItem>
          )}
          {actions.chatArchiveThread && (
            <DropdownMenuItem
              onSelect={() =>
                void actions.chatArchiveThread({
                  threadId: thread.id,
                  archived: !archived,
                }).result().then(
                  () =>
                    toast(
                      archived
                        ? "Conversation restored."
                        : "Conversation archived.",
                    ),
                  fail,
                )}
            >
              {archived ? <ArchiveRestore /> : <Archive />}
              {archived ? "Restore" : "Archive"}
            </DropdownMenuItem>
          )}
          {actions.chatDeleteThread && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                destructive
                onSelect={() => setDialog("delete")}
              >
                <Trash2 /> Delete…
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      {dialog === "rename" && (
        <NameDescriptionDialog
          open
          onOpenChange={(open) => !open && setDialog(null)}
          title="Rename conversation"
          initial={{ name }}
          withDescription={false}
          submitLabel="Rename"
          onSubmit={async (value) => {
            await actions.chatRenameThread({
              threadId: thread.id,
              name: value.name,
            }).result();
          }}
        />
      )}
      {dialog === "move" && (
        <MovePicker
          open
          onOpenChange={(open) => !open && setDialog(null)}
          title={name}
          current={spaceId}
          spaces={spaces.filter((space) => space.status !== "archived").map((
            space,
          ) => ({ id: space.id, name: String(space.name ?? space.id) }))}
          onMove={(target) =>
            actions.chatMoveThread({
              threadId: thread.id,
              spaceId: target,
              fromSpaceId: spaceId,
            }).result().then(() =>
              toast(
                target
                  ? `Moved to ${
                    String(
                      spaces.find((space) => space.id === target)?.name ??
                        "the Space",
                    )
                  }.`
                  : "Moved out of its Space.",
              )
            )}
        />
      )}
      <ConfirmDialog
        open={dialog === "delete"}
        onOpenChange={(open) => !open && setDialog(null)}
        title="Delete this conversation?"
        description={`“${name}” and its messages will be deleted for everyone. This can't be undone.`}
        confirmLabel="Delete"
        destructive
        onConfirm={async () => {
          await actions.chatDeleteThread({ threadId: thread.id }).result();
          actions.shellNewChat({});
          toast("Conversation deleted.");
          return true;
        }}
      />
    </>
  );
}

/** The bar above main: where you are, who is here, and what you can do. */
const view: ViewDefinition<unknown, React.ReactNode, BrowserViewContext> =
  defineView<unknown, React.ReactNode, BrowserViewContext>({
    id: "ui.header",
    shows: "shellHeader",
    renderer: "react",
    modes: ["full"],
    render(_value, ctx) {
      const nav = shellState(ctx.collections.shell.get("main").value);
      const thread = nav.threadId
        ? ctx.collections.thread.get(nav.threadId).value
        : undefined;
      const spaces = readSpaces(ctx).value;
      const openSpace = nav.spaceId
        ? spaces.find((space) => space.id === nav.spaceId) ??
          ctx.collections.space?.get(nav.spaceId).value
        : undefined;
      const threadSpaceId = typeof thread?.spaceId === "string"
        ? thread.spaceId
        : null;
      const threadSpace = threadSpaceId
        ? spaces.find((space) => space.id === threadSpaceId)
        : undefined;
      const items = menuItems(ctx.resources.headerMenu);
      const shell = ctx.resources.shell as Record<string, unknown> | undefined;
      const branding = (shell?.branding ?? {}) as { title?: string };
      const pageItem = nav.page
        ? [...items, ...menuItems(ctx.resources.userMenu)].find((item) =>
          item.page === nav.page
        )
        : undefined;
      if (nav.page) {
        return (
          <header
            data-slot="shell-header"
            className="bg-background/95 supports-[backdrop-filter]:bg-background/80 relative z-20 flex h-14 shrink-0 items-center gap-1.5 border-b px-2 pt-[env(safe-area-inset-top)] backdrop-blur sm:px-3"
          >
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Close"
                  onClick={() => ctx.actions.shellOpenPage({ page: null })}
                >
                  <ArrowLeft />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Close</TooltipContent>
            </Tooltip>
            <div className="flex min-w-0 flex-1 items-center gap-2 pl-1">
              {pageItem?.icon && (
                <Icon
                  name={pageItem.icon}
                  className="text-muted-foreground size-4"
                />
              )}
              <h1 className="min-w-0 truncate text-sm font-semibold sm:text-[15px]">
                {pageItem?.label ?? branding.title ?? ""}
              </h1>
            </div>
          </header>
        );
      }
      const inSpace = Boolean(nav.spaceId);
      const title = inSpace
        ? String(openSpace?.name ?? "Space")
        : thread
        ? String(thread.name ?? "") || "New conversation"
        : nav.threadId
        ? "Conversation"
        : "New conversation";
      return (
        <header
          data-slot="shell-header"
          className="bg-background/95 supports-[backdrop-filter]:bg-background/80 relative z-20 flex h-14 shrink-0 items-center gap-1.5 border-b px-2 pt-[env(safe-area-inset-top)] backdrop-blur sm:px-3"
        >
          {inSpace && nav.threadId && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Back to the conversation"
                  onClick={() => ctx.actions.shellCloseSpace({})}
                >
                  <ArrowLeft />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Back to the conversation</TooltipContent>
            </Tooltip>
          )}
          <div className="flex min-w-0 flex-1 items-center gap-2 pl-1">
            {inSpace && nav.spaceId && (
              <SpaceMark id={nav.spaceId} name={title} size="md" />
            )}
            <h1 className="min-w-0 truncate text-sm font-semibold sm:text-[15px]">
              {title}
            </h1>
            {!inSpace && threadSpace && threadSpaceId && (
              <button
                type="button"
                onClick={() =>
                  ctx.actions.shellOpenSpace({ spaceId: threadSpaceId })}
                className="text-muted-foreground hover:text-foreground hover:bg-accent focus-visible:ring-ring/45 hidden h-7 min-w-0 shrink items-center gap-1.5 rounded-md border px-2 text-xs outline-none focus-visible:ring-[3px] sm:inline-flex"
                aria-label={`Open ${String(threadSpace.name ?? "Space")}`}
              >
                <SpaceMark
                  id={threadSpaceId}
                  name={String(threadSpace.name ?? "")}
                />
                <span className="truncate">
                  {String(threadSpace.name ?? "Space")}
                </span>
              </button>
            )}
            {!inSpace && thread && (
              <div className="ml-1 min-w-0 shrink-0">
                {showSafely(
                  ctx,
                  { shows: "agentSelector", value: { threadId: thread.id } },
                  { mode: "full" },
                  "Agents",
                )}
              </div>
            )}
            {!inSpace && !thread && !nav.threadId && branding.title && (
              <span className="text-muted-foreground hidden truncate text-sm sm:inline">
                · {branding.title}
              </span>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-0.5">
            {inSpace && nav.spaceId &&
              items.filter((item) => item.requires === "space").map((item) => (
                <Tooltip key={item.id}>
                  <TooltipTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label={item.label}
                      onClick={() =>
                        runMenuItem(ctx, item, {
                          spaceId: nav.spaceId,
                          threadId: nav.threadId,
                        })}
                    >
                      <Icon name={item.icon} fallback={<MoreHorizontal />} />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>{item.label}</TooltipContent>
                </Tooltip>
              ))}
            {!inSpace && thread && (
              <>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label={nav.panel
                        ? "Hide the side panel"
                        : "Show the side panel"}
                      aria-pressed={nav.panel}
                      aria-controls="shell-panel"
                      onClick={() =>
                        ctx.actions.shellPanel({ open: !nav.panel })}
                      className={cn(nav.panel && "bg-accent")}
                    >
                      <PanelRight />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>
                    {nav.panel ? "Hide panel" : "Show panel"}
                    <Kbd className="ml-2">⌘.</Kbd>
                  </TooltipContent>
                </Tooltip>
                <ThreadMenu
                  ctx={ctx}
                  thread={thread}
                  spaces={spaces}
                  items={items}
                  spaceId={threadSpaceId}
                />
              </>
            )}
          </div>
        </header>
      );
    },
  });

export default view;
