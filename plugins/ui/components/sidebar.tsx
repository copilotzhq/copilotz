/** @jsxRuntime classic */
/** @jsx React.createElement */
/** @jsxFrag React.Fragment */
"use client";
/**
 * The shell sidebar: brand, New chat, search, conversations by Space (or by
 * recency), row menus, drag into a Space, and the user menu. In the icon rail
 * the same component shows its compact marks; container queries choose.
 * @module
 */
// deno-lint-ignore verbatim-module-syntax -- classic JSX requires this runtime import.
import * as React from "react";
import { useEffect, useRef, useState } from "react";
import {
  Archive,
  ArchiveRestore,
  ArrowRightLeft,
  ChevronRight,
  GripVertical,
  MessageSquarePlus,
  MoreHorizontal,
  PanelLeft,
  Pencil,
  Plus,
  Search,
  SquarePen,
  Trash2,
} from "lucide-react";
import type { Row } from "@copilotz/copilotz/web";
import {
  Button,
  cn,
  ConfirmDialog,
  dom,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Input,
  Kbd,
  NameDescriptionDialog,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  transfer,
} from "@copilotz/copilotz/web/kit";
import {
  groupThreadsByRecency,
  groupThreadsBySpace,
  type ThreadGroup,
} from "../model.ts";
import { SpaceDot, SpaceMark, ThreadMark } from "./space-mark.tsx";
import { MovePicker } from "./move-picker.tsx";
import { useTouchSpaceDrag } from "./touch-drag.ts";

export interface SidebarLabels {
  newChat?: string;
  search?: string;
  spaces?: string;
  recent?: string;
  noSpace?: string;
  newSpace?: string;
  emptyChats?: string;
}

export interface SidebarHandlers {
  onNewChat(spaceId?: string): void;
  onOpenThread(threadId: string): void;
  onOpenSpace(spaceId: string): void;
  onToggleSpace(spaceId: string, open: boolean): void;
  onGroupBy(groupBy: "space" | "date"): void;
  onShowArchived(show: boolean): void;
  onToggleSidebar(): void;
  onOpenSearch(): void;
  onRename?(threadId: string, name: string): Promise<unknown>;
  onArchive?(threadId: string, archived: boolean): Promise<unknown>;
  onDelete?(threadId: string): Promise<unknown>;
  onMove?(
    threadId: string,
    spaceId: string | null,
    fromSpaceId: string | null,
  ): Promise<unknown>;
  onCreateSpace?(value: { name: string; description: string }): Promise<
    string | undefined
  >;
  onUpdateSpace?(
    spaceId: string,
    value: { name: string; description: string },
  ): Promise<unknown>;
  onDeleteSpace?(spaceId: string): Promise<unknown>;
}

export interface SidebarProps extends SidebarHandlers {
  brand: Readonly<{ title?: string; subtitle?: string; logoUrl?: string }>;
  threads: readonly Row[];
  spaces: readonly Row[];
  currentThreadId: string | null;
  currentSpaceId: string | null;
  groupBy: "space" | "date";
  showArchived: boolean;
  /** Spaces whose conversations are shown. */
  expanded: ReadonlySet<string>;
  spacesEnabled: boolean;
  labels?: SidebarLabels;
  /** The rendered user menu, pinned at the bottom. */
  footer?: React.ReactNode;
  /** A notice for the polite live region (moves, failures). */
  announce?(text: string, tone?: "info" | "error"): void;
  /** The New Space dialog, when another control (⌘K) opens it. */
  creatingSpace?: boolean;
  onCreatingSpace?(open: boolean): void;
}

const title = (thread: Row) => String(thread.name ?? "") || "New conversation";
const spaceName = (space: Row | undefined) =>
  String(space?.name ?? "") || "Space";
const DRAG_TYPE = "application/x-copilotz-thread";

/** A compact icon button with a tooltip and an accessible name. */
function IconButton(
  { label, onClick, children, className, shortcut }: {
    label: string;
    onClick(): void;
    children: React.ReactNode;
    className?: string;
    shortcut?: string;
  },
): React.ReactElement {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={label}
          className={cn("text-sidebar-foreground/80", className)}
          onClick={onClick}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="right">
        {label}
        {shortcut && <Kbd className="ml-2">{shortcut}</Kbd>}
      </TooltipContent>
    </Tooltip>
  );
}

function ThreadRow(
  {
    thread,
    selected,
    showSpace,
    space,
    props,
    onPickSpace,
    touch,
  }: {
    thread: Row;
    selected: boolean;
    showSpace: boolean;
    space?: Row;
    props: SidebarProps;
    onPickSpace(thread: Row): void;
    touch: ReturnType<typeof useTouchSpaceDrag>;
  },
): React.ReactElement {
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [name, setName] = useState(title(thread));
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (editing && input.current) {
      dom(input.current).focus();
      dom(input.current).select?.();
    }
  }, [editing]);
  const archived = thread.status === "archived";
  const save = () => {
    const next = name.trim();
    setEditing(false);
    if (!next || next === title(thread) || !props.onRename) return;
    setBusy(true);
    props.onRename(thread.id, next).catch((cause) =>
      props.announce?.(
        cause instanceof Error ? cause.message : "Not renamed.",
        "error",
      )
    ).finally(() => setBusy(false));
  };
  if (editing) {
    return (
      <li className="px-1 py-0.5">
        <Input
          ref={input}
          value={name}
          aria-label="Conversation name"
          className="h-8 text-sm"
          onChange={(event) =>
            setName((event.target as unknown as { value: string }).value)}
          onBlur={save}
          onKeyDown={(event) => {
            if (event.key === "Enter") save();
            if (event.key === "Escape") {
              setName(title(thread));
              setEditing(false);
            }
          }}
        />
      </li>
    );
  }
  const spaceId = typeof thread.spaceId === "string" ? thread.spaceId : null;
  return (
    <li
      className={cn(
        "group/row relative flex items-center rounded-md",
        selected
          ? "bg-sidebar-accent text-sidebar-accent-foreground"
          : "hover:bg-sidebar-accent/60",
        busy && "opacity-60",
      )}
    >
      <button
        type="button"
        draggable={Boolean(props.onMove)}
        aria-current={selected ? "page" : undefined}
        onClick={() => props.onOpenThread(thread.id)}
        onDragStart={(event) => {
          transfer(event.dataTransfer).setData(DRAG_TYPE, thread.id);
          transfer(event.dataTransfer).effectAllowed = "move";
        }}
        className="focus-visible:ring-sidebar-ring/50 flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md pr-8 pl-2 text-left text-sm outline-none focus-visible:ring-2"
      >
        <ThreadMark title={title(thread)} />
        <span
          className={cn(
            "min-w-0 flex-1 truncate",
            selected && "font-medium",
            archived && "text-muted-foreground",
          )}
        >
          {title(thread)}
        </span>
        {showSpace && spaceId && space && (
          <SpaceDot id={spaceId} name={spaceName(space)} />
        )}
        {archived && (
          <Archive
            aria-label="Archived"
            className="text-muted-foreground size-3.5 shrink-0"
          />
        )}
      </button>
      {props.onMove && (
        <button
          type="button"
          aria-label={`Move ${title(thread)} to a Space`}
          className="text-muted-foreground/60 hover:bg-sidebar-accent absolute right-8 hidden size-7 touch-none items-center justify-center rounded-md [@media(pointer:coarse)]:flex"
          onPointerDown={(event) => touch.start(event, thread.id, spaceId)}
          onContextMenu={(event) => event.preventDefault()}
          onClick={(event) => {
            event.stopPropagation();
            if (event.detail === 0 || !touch.consumeClick()) {
              onPickSpace(thread);
            }
          }}
        >
          <GripVertical aria-hidden="true" className="size-4" />
        </button>
      )}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={`Options for ${title(thread)}`}
            className={cn(
              "text-muted-foreground hover:text-foreground hover:bg-sidebar-accent focus-visible:ring-sidebar-ring/50 data-[state=open]:bg-sidebar-accent absolute right-1 flex size-7 items-center justify-center rounded-md opacity-0 outline-none group-focus-within/row:opacity-100 group-hover/row:opacity-100 focus-visible:ring-2 data-[state=open]:opacity-100 [@media(pointer:coarse)]:opacity-100",
              selected && "opacity-100",
            )}
          >
            <MoreHorizontal aria-hidden="true" className="size-4" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="right" align="start" className="w-48">
          {props.onRename && (
            <DropdownMenuItem onSelect={() => setEditing(true)}>
              <Pencil /> Rename
            </DropdownMenuItem>
          )}
          {props.onMove && (
            <DropdownMenuItem onSelect={() => onPickSpace(thread)}>
              <ArrowRightLeft /> Move to Space…
            </DropdownMenuItem>
          )}
          {props.onArchive && (
            <DropdownMenuItem
              onSelect={() =>
                void props.onArchive!(thread.id, !archived).catch((cause) =>
                  props.announce?.(
                    cause instanceof Error ? cause.message : "Not changed.",
                    "error",
                  )
                )}
            >
              {archived ? <ArchiveRestore /> : <Archive />}
              {archived ? "Restore" : "Archive"}
            </DropdownMenuItem>
          )}
          {props.onDelete && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                destructive
                onSelect={() => setConfirming(true)}
              >
                <Trash2 /> Delete…
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      {props.onDelete && (
        <ConfirmDialog
          open={confirming}
          onOpenChange={setConfirming}
          title="Delete this conversation?"
          description={`“${
            title(thread)
          }” and its messages will be deleted for everyone. This can't be undone.`}
          confirmLabel="Delete"
          destructive
          onConfirm={async () => {
            await props.onDelete!(thread.id);
            return true;
          }}
        />
      )}
    </li>
  );
}

function SpaceGroup(
  {
    group,
    open,
    props,
    children,
    dropTarget,
    setDropTarget,
  }: {
    group: ThreadGroup;
    open: boolean;
    props: SidebarProps;
    children: React.ReactNode;
    dropTarget: string | null;
    setDropTarget(id: string | null): void;
  },
): React.ReactElement {
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const space = group.space;
  const id = group.spaceId;
  const key = id ?? "none";
  const selected = Boolean(id && props.currentSpaceId === id);
  const listId = `space-${key}`;
  const droppable = Boolean(props.onMove) && !group.unavailable;
  return (
    <li
      className="grid gap-0.5"
      onDragOver={(event) => {
        if (
          !droppable ||
          !Array.from(transfer(event.dataTransfer).types).includes(DRAG_TYPE)
        ) return;
        event.preventDefault();
        transfer(event.dataTransfer).dropEffect = "move";
        setDropTarget(key);
      }}
      onDragLeave={(event) => {
        if (!dom(event.currentTarget).contains(event.relatedTarget)) {
          setDropTarget(null);
        }
      }}
      onDrop={(event) => {
        const threadId = transfer(event.dataTransfer).getData(DRAG_TYPE);
        setDropTarget(null);
        if (!droppable || !threadId) return;
        event.preventDefault();
        const thread = props.threads.find((value) => value.id === threadId);
        const from = typeof thread?.spaceId === "string"
          ? thread.spaceId
          : null;
        if (!thread || from === id) return;
        const destination = id ? spaceName(space) : "No Space";
        props.announce?.(`Moving to ${destination}…`);
        props.onMove!(threadId, id, from).then(
          () => props.announce?.(`Moved to ${destination}.`),
          (cause) =>
            props.announce?.(
              cause instanceof Error ? cause.message : "Not moved.",
              "error",
            ),
        );
      }}
    >
      <div
        className={cn(
          "group/space flex h-8 items-center gap-0.5 rounded-md pr-1",
          selected && "bg-sidebar-accent text-sidebar-accent-foreground",
          dropTarget === key && "ring-sidebar-ring bg-sidebar-accent/60 ring-2",
        )}
      >
        <button
          type="button"
          aria-expanded={open}
          aria-controls={listId}
          aria-label={`${
            open ? "Hide" : "Show"
          } conversations in ${group.label}`}
          onClick={() => id && props.onToggleSpace(id, !open)}
          disabled={!id}
          className="text-muted-foreground hover:text-foreground hover:bg-sidebar-accent focus-visible:ring-sidebar-ring/50 flex size-7 shrink-0 items-center justify-center rounded-md outline-none focus-visible:ring-2 disabled:pointer-events-none"
        >
          <ChevronRight
            aria-hidden="true"
            className={cn(
              "size-3.5 transition-transform",
              open && "rotate-90",
              !id && "opacity-0",
            )}
          />
        </button>
        {id && space && !group.unavailable
          ? (
            <button
              type="button"
              aria-current={selected ? "page" : undefined}
              onClick={() => props.onOpenSpace(id)}
              className="focus-visible:ring-sidebar-ring/50 hover:bg-sidebar-accent/70 flex h-7 min-w-0 flex-1 items-center gap-2 rounded-md px-1.5 text-left text-sm font-medium outline-none focus-visible:ring-2"
            >
              <SpaceMark id={id} name={group.label} />
              <span className="min-w-0 flex-1 truncate">{group.label}</span>
            </button>
          )
          : (
            <span
              className={cn(
                "flex h-7 min-w-0 flex-1 items-center gap-2 px-1.5 text-sm",
                id
                  ? "text-muted-foreground italic"
                  : "text-muted-foreground font-medium",
              )}
            >
              <span className="min-w-0 flex-1 truncate">{group.label}</span>
            </span>
          )}
        {!open && group.threads.length > 0 && (
          <span className="text-muted-foreground px-1 text-[11px] tabular-nums group-focus-within/space:hidden group-hover/space:hidden">
            {group.threads.length}
          </span>
        )}
        {id && space && !group.unavailable && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label={`Options for ${group.label}`}
                className={cn(
                  "text-muted-foreground hover:text-foreground hover:bg-sidebar-accent focus-visible:ring-sidebar-ring/50 data-[state=open]:bg-sidebar-accent flex size-7 shrink-0 items-center justify-center rounded-md opacity-0 outline-none group-focus-within/space:opacity-100 group-hover/space:opacity-100 focus-visible:ring-2 data-[state=open]:opacity-100 [@media(pointer:coarse)]:opacity-100",
                  selected && "opacity-100",
                )}
              >
                <MoreHorizontal aria-hidden="true" className="size-4" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent side="right" align="start" className="w-48">
              <DropdownMenuItem onSelect={() => props.onNewChat(id)}>
                <MessageSquarePlus /> New chat here
              </DropdownMenuItem>
              {props.onUpdateSpace && (
                <DropdownMenuItem onSelect={() => setEditing(true)}>
                  <Pencil /> Edit Space…
                </DropdownMenuItem>
              )}
              {props.onDeleteSpace && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    destructive
                    onSelect={() => setConfirming(true)}
                  >
                    <Trash2 /> Delete Space…
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
      {id && props.onDeleteSpace && (
        <ConfirmDialog
          open={confirming}
          onOpenChange={setConfirming}
          title={`Delete ${group.label}?`}
          description={group.threads.length
            ? `Its ${group.threads.length} conversation${
              group.threads.length === 1 ? "" : "s"
            } move to No Space. This can't be undone.`
            : "This can't be undone."}
          confirmLabel="Delete Space"
          destructive
          onConfirm={async () => {
            await props.onDeleteSpace!(id);
            return true;
          }}
        />
      )}
      {editing && props.onUpdateSpace && space && (
        <NameDescriptionDialog
          open={editing}
          onOpenChange={setEditing}
          title="Edit Space"
          initial={{
            name: String(space.name ?? ""),
            description: String(space.description ?? ""),
          }}
          onSubmit={(value) => props.onUpdateSpace!(id!, value)}
        />
      )}
      {open && (
        <ul id={listId} className="grid gap-0.5 pl-4">
          {children}
        </ul>
      )}
    </li>
  );
}

export function Sidebar(props: SidebarProps): React.ReactElement {
  const {
    brand,
    threads,
    spaces,
    groupBy,
    showArchived,
    expanded,
    labels = {},
  } = props;
  const [query, setQuery] = useState("");
  const [picking, setPicking] = useState<Row | null>(null);
  const [localCreating, setLocalCreating] = useState(false);
  const creating = props.creatingSpace ?? localCreating;
  const setCreating = props.onCreatingSpace ?? setLocalCreating;
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const spacesById = new Map(spaces.map((space) => [space.id, space]));
  const active = spaces.filter((space) => space.status !== "archived");
  const needle = query.trim().toLowerCase();
  const matches = (thread: Row) => {
    if (!needle) return true;
    const space = typeof thread.spaceId === "string"
      ? spacesById.get(thread.spaceId)
      : undefined;
    return title(thread).toLowerCase().includes(needle) ||
      spaceName(space).toLowerCase().includes(needle);
  };
  const hasArchived = threads.some((thread) => thread.status === "archived");
  const visible = threads.filter((thread) =>
    (showArchived || thread.status !== "archived") && matches(thread)
  );
  const bySpace = props.spacesEnabled && groupBy === "space";
  const groups = bySpace
    ? groupThreadsBySpace(
      visible,
      needle
        ? active.filter((space) =>
          spaceName(space).toLowerCase().includes(needle) ||
          visible.some((thread) => thread.spaceId === space.id)
        )
        : spaces,
      labels.noSpace ?? "No Space",
    )
    : groupThreadsByRecency(visible);
  const touch = useTouchSpaceDrag({
    enabled: Boolean(props.onMove),
    eligible: (threadId) => {
      const thread = threads.find((value) => value.id === threadId);
      return active.map((space) => space.id).filter((id) =>
        id !== thread?.spaceId
      );
    },
    onMove: (threadId, spaceId) => {
      const thread = threads.find((value) => value.id === threadId);
      const from = typeof thread?.spaceId === "string" ? thread.spaceId : null;
      const destination = spaceName(spacesById.get(spaceId));
      props.announce?.(`Moving to ${destination}…`);
      props.onMove?.(threadId, spaceId, from).then(
        () => props.announce?.(`Moved to ${destination}.`),
        (cause) =>
          props.announce?.(
            cause instanceof Error ? cause.message : "Not moved.",
            "error",
          ),
      );
    },
    onCancel: () => props.announce?.("Move cancelled."),
  });
  const rows = (group: ThreadGroup) =>
    group.threads.map((thread) => (
      <ThreadRow
        key={thread.id}
        thread={thread}
        selected={props.currentThreadId === thread.id && !props.currentSpaceId}
        showSpace={!bySpace}
        space={typeof thread.spaceId === "string"
          ? spacesById.get(thread.spaceId)
          : undefined}
        props={props}
        onPickSpace={setPicking}
        touch={touch}
      />
    ));
  const newSpace = (
    <li key="new-space">
      <button
        type="button"
        onClick={() => setCreating(true)}
        className="text-muted-foreground hover:text-foreground hover:bg-sidebar-accent/60 focus-visible:ring-sidebar-ring/50 flex h-8 w-full items-center gap-2 rounded-md pr-2 pl-2.5 text-left text-sm outline-none focus-visible:ring-2"
      >
        <Plus aria-hidden="true" className="size-4" />
        {labels.newSpace ?? "New Space"}
      </button>
    </li>
  );
  const isOpen = (group: ThreadGroup) =>
    !group.spaceId || Boolean(needle) || expanded.has(group.spaceId);
  return (
    <div
      data-slot="sidebar"
      className="bg-sidebar text-sidebar-foreground @container/sidebar relative flex h-full w-full flex-col"
    >
      {/* Brand and the collapse control. */}
      <div className="flex h-14 shrink-0 items-center gap-2 px-3 @max-[12rem]/sidebar:justify-center @max-[12rem]/sidebar:px-0">
        <button
          type="button"
          aria-label={brand.title ? `${brand.title} home` : "Home"}
          onClick={() => props.onNewChat()}
          className="focus-visible:ring-sidebar-ring/50 flex min-w-0 flex-1 items-center gap-2.5 rounded-md text-left outline-none focus-visible:ring-2 @max-[12rem]/sidebar:flex-none"
        >
          {brand.logoUrl
            ? (
              <img
                src={brand.logoUrl}
                alt=""
                className="size-8 shrink-0 rounded-lg object-cover"
              />
            )
            : (
              <span className="bg-primary text-primary-foreground flex size-8 shrink-0 items-center justify-center rounded-lg text-sm font-bold">
                {(brand.title ?? "C").slice(0, 1).toUpperCase()}
              </span>
            )}
          <span className="grid min-w-0 @max-[12rem]/sidebar:hidden">
            <span className="truncate text-sm font-semibold">
              {brand.title ?? "Chat"}
            </span>
            {brand.subtitle && (
              <span className="text-muted-foreground truncate text-xs">
                {brand.subtitle}
              </span>
            )}
          </span>
        </button>
        <span className="@max-[12rem]/sidebar:hidden">
          <IconButton
            label="Collapse sidebar"
            shortcut="⌘B"
            onClick={props.onToggleSidebar}
          >
            <PanelLeft />
          </IconButton>
        </span>
      </div>

      {/* The icon rail. */}
      <div className="hidden flex-col items-center gap-1 pb-2 @max-[12rem]/sidebar:flex">
        <IconButton
          label="Expand sidebar"
          shortcut="⌘B"
          onClick={props.onToggleSidebar}
        >
          <PanelLeft />
        </IconButton>
        <IconButton
          label={labels.newChat ?? "New chat"}
          onClick={() => props.onNewChat()}
        >
          <SquarePen />
        </IconButton>
        <IconButton
          label={labels.search ?? "Search"}
          shortcut="⌘K"
          onClick={props.onOpenSearch}
        >
          <Search />
        </IconButton>
      </div>
      {props.spacesEnabled && active.length > 0 && (
        <ul
          aria-label={labels.spaces ?? "Spaces"}
          className="hidden min-h-0 flex-1 flex-col items-center gap-1 overflow-y-auto border-t py-2 @max-[12rem]/sidebar:flex"
        >
          {active.map((space) => (
            <li key={space.id}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    aria-label={`Open ${spaceName(space)}`}
                    aria-current={props.currentSpaceId === space.id
                      ? "page"
                      : undefined}
                    onClick={() => props.onOpenSpace(space.id)}
                    className={cn(
                      "focus-visible:ring-sidebar-ring/50 flex size-9 items-center justify-center rounded-lg outline-none focus-visible:ring-2",
                      props.currentSpaceId === space.id
                        ? "bg-sidebar-accent"
                        : "hover:bg-sidebar-accent/60",
                    )}
                  >
                    <SpaceMark
                      id={space.id}
                      name={spaceName(space)}
                      size="md"
                    />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="right">{spaceName(space)}</TooltipContent>
              </Tooltip>
            </li>
          ))}
        </ul>
      )}

      {/* The full list. */}
      <div className="flex min-h-0 flex-1 flex-col @max-[12rem]/sidebar:hidden">
        <div className="grid gap-2 px-3 pb-2">
          <Button
            type="button"
            variant="outline"
            className="bg-background justify-start gap-2"
            onClick={() => props.onNewChat()}
          >
            <SquarePen /> {labels.newChat ?? "New chat"}
          </Button>
          <label className="relative">
            <span className="sr-only">{labels.search ?? "Search"}</span>
            <Search
              aria-hidden="true"
              className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2"
            />
            <Input
              type="search"
              value={query}
              placeholder={labels.search ?? "Search"}
              className="bg-background h-8 pr-12 pl-8"
              onChange={(event) =>
                setQuery((event.target as unknown as { value: string }).value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") setQuery("");
              }}
            />
            <Kbd className="absolute top-1/2 right-2 -translate-y-1/2">⌘K</Kbd>
          </label>
          {props.spacesEnabled && (
            <div
              role="group"
              aria-label="Group conversations"
              className="bg-sidebar-accent/70 grid grid-cols-2 gap-0.5 rounded-lg p-0.5"
            >
              {(["space", "date"] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={groupBy === value}
                  onClick={() => props.onGroupBy(value)}
                  className={cn(
                    "focus-visible:ring-sidebar-ring/50 h-7 rounded-md text-xs font-medium outline-none focus-visible:ring-2",
                    groupBy === value
                      ? "bg-background text-foreground shadow-soft"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {value === "space"
                    ? labels.spaces ?? "Spaces"
                    : labels.recent ?? "Recent"}
                </button>
              ))}
            </div>
          )}
        </div>
        <nav
          aria-label="Conversations"
          className="min-h-0 flex-1 overflow-y-auto px-2 pb-3"
        >
          {groups.length === 0
            ? (
              <div className="grid justify-items-center gap-3 px-3 py-8 text-center">
                <p className="text-muted-foreground text-sm">
                  {needle
                    ? `Nothing matches “${query.trim()}”.`
                    : labels.emptyChats ?? "No conversations yet."}
                </p>
                {!needle && (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => props.onNewChat()}
                  >
                    <SquarePen /> {labels.newChat ?? "New chat"}
                  </Button>
                )}
              </div>
            )
            : bySpace
            ? (
              <ul className="grid gap-0.5">
                {groups.map((group) => [
                  group.key === "space:none" && props.onCreateSpace
                    ? newSpace
                    : null,
                  <SpaceGroup
                    key={group.key}
                    group={group}
                    open={isOpen(group)}
                    props={props}
                    dropTarget={dropTarget}
                    setDropTarget={setDropTarget}
                  >
                    {group.threads.length
                      ? rows(group)
                      : (
                        <li className="text-muted-foreground py-1 pl-2 text-xs">
                          No conversations yet.{" "}
                          <button
                            type="button"
                            className="text-foreground underline-offset-2 hover:underline"
                            onClick={() =>
                              props.onNewChat(group.spaceId ?? undefined)}
                          >
                            Start one
                          </button>
                        </li>
                      )}
                  </SpaceGroup>,
                ])}
                {!groups.some((group) => group.key === "space:none") &&
                  props.onCreateSpace && newSpace}
              </ul>
            )
            : (
              <div className="grid gap-3">
                {groups.map((group) => (
                  <section key={group.key} aria-label={group.label}>
                    <h2 className="text-muted-foreground px-2.5 pb-1 text-xs font-medium">
                      {group.label}
                    </h2>
                    <ul className="grid gap-0.5">{rows(group)}</ul>
                  </section>
                ))}
              </div>
            )}
          {hasArchived && (
            <button
              type="button"
              aria-pressed={showArchived}
              onClick={() => props.onShowArchived(!showArchived)}
              className="text-muted-foreground hover:text-foreground focus-visible:ring-sidebar-ring/50 mt-3 flex h-7 items-center gap-2 rounded-md px-2.5 text-xs outline-none focus-visible:ring-2"
            >
              <Archive aria-hidden="true" className="size-3.5" />
              {showArchived ? "Hide archived" : "Show archived"}
            </button>
          )}
        </nav>
      </div>

      {touch.drag && (
        <div
          className="bg-sidebar absolute inset-0 z-20 flex flex-col"
          data-touch-destinations=""
        >
          <p className="border-b px-4 py-3 text-xs font-medium">
            {touch.drag.targetId
              ? `Release to move to ${
                spaceName(spacesById.get(touch.drag.targetId))
              }`
              : "Drag onto a Space. Release elsewhere to cancel."}
          </p>
          <div
            ref={touch.targets}
            className="min-h-0 flex-1 overflow-y-auto p-2"
          >
            {active.map((space) => {
              const source = threads.find((thread) =>
                thread.id === touch.drag?.threadId
              );
              const eligible = space.id !== source?.spaceId;
              return (
                <div
                  key={space.id}
                  data-drop-space={eligible ? space.id : undefined}
                  aria-disabled={!eligible || undefined}
                  className={cn(
                    "mb-1 flex min-h-11 items-center gap-2 rounded-lg border px-3 text-sm",
                    !eligible && "opacity-50",
                    touch.drag?.targetId === space.id &&
                      "border-sidebar-ring bg-sidebar-accent",
                  )}
                >
                  <SpaceMark id={space.id} name={spaceName(space)} />
                  <span className="min-w-0 flex-1 truncate">
                    {spaceName(space)}
                  </span>
                  {!eligible && (
                    <span className="text-muted-foreground text-xs">
                      Current
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      <div className="border-sidebar-border shrink-0 border-t p-2">
        {props.footer}
      </div>

      {picking && props.onMove && (
        <MovePicker
          open
          onOpenChange={(open) => !open && setPicking(null)}
          title={title(picking)}
          current={typeof picking.spaceId === "string" ? picking.spaceId : null}
          spaces={active.map((space) => ({
            id: space.id,
            name: spaceName(space),
          }))}
          onMove={(spaceId) =>
            props.onMove!(
              picking.id,
              spaceId,
              typeof picking.spaceId === "string" ? picking.spaceId : null,
            )}
          onCreate={props.onCreateSpace
            ? (name) => props.onCreateSpace!({ name, description: "" })
            : undefined}
        />
      )}
      {creating && props.onCreateSpace && (
        <NameDescriptionDialog
          open={creating}
          onOpenChange={setCreating}
          title="New Space"
          description="A Space holds related conversations and their resources."
          submitLabel="Create Space"
          onSubmit={async (value) => {
            const id = await props.onCreateSpace!(value);
            if (id) props.onOpenSpace(id);
          }}
        />
      )}
    </div>
  );
}
