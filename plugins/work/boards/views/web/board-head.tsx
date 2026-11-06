/// <reference lib="dom" />
/**
 * A board's head, as its page and a space's tab show it: its name, renamed
 * in place by editors; its description, written in place; its menu (rename,
 * describe, add a column, archive or restore, delete, after a question that
 * says its cards go too). And a new board, named in a small form.
 */
import { type ReactNode, useEffect, useRef, useState } from "react";
import {
  Button,
  go,
  IconButton,
  InlineEdit,
  Input,
  Kbd,
  type MenuItem,
  message,
  Textarea,
} from "../../../../../hosts/web/mod.ts";
import type { Board } from "../../contract.ts";
import { boardPath, boardsTab } from "../../contract.ts";
import { MOD, Sheet } from "./card-sheet.tsx";
import { Glyph } from "./glyphs.tsx";

type Call = <R = unknown>(action: string, input?: unknown) => Promise<R>;

/** A board's name: a button that turns into a field, for editors. */
export function BoardName(
  { board, can, renaming, onRenaming, call }: {
    board: Board;
    can: boolean;
    renaming: boolean;
    onRenaming(on: boolean): void;
    call: Call;
  },
): ReactNode {
  if (renaming) {
    return (
      <InlineEdit
        label="The board's name"
        value={board.name}
        maxLength={80}
        save={(name) => call("board.update", { board: board._id, name })}
        done={() => onRenaming(false)}
      />
    );
  }
  if (!can) return <>{board.name}</>;
  return (
    <button
      type="button"
      className="board-name"
      title="Rename"
      onClick={() => onRenaming(true)}
    >
      {board.name}
    </button>
  );
}

/** What a board is for: a line or two, written in place by editors. */
export function BoardAbout(
  { board, can, writing, onWriting, call }: {
    board: Board;
    can: boolean;
    writing: boolean;
    onWriting(on: boolean): void;
    call: Call;
  },
): ReactNode {
  const [text, setText] = useState(board.description ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const field = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (writing) {
      setText(board.description ?? "");
      requestAnimationFrame(() => field.current?.focus());
    }
  }, [writing]);
  if (writing) {
    const save = async () => {
      setBusy(true);
      setError(undefined);
      try {
        await call("board.update", { board: board._id, description: text.trim() || null });
        onWriting(false);
      } catch (e) {
        setError(message(e));
      } finally {
        setBusy(false);
      }
    };
    return (
      <span className="board-about-edit">
        <Textarea
          ref={field}
          autoGrow
          rows={2}
          maxLength={2000}
          aria-label="What the board is for"
          placeholder="What this board is for, and what done looks like"
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              void save();
            } else if (event.key === "Escape") {
              event.preventDefault();
              onWriting(false);
            }
          }}
        />
        {error ? <span role="alert" className="board-error">{error}</span> : null}
        <span className="board-about-edit-end">
          <span className="board-quick-hint board-grow">
            <Kbd>{MOD}</Kbd>
            <Kbd>Enter</Kbd> saves
          </span>
          <Button size="sm" variant="ghost" onClick={() => onWriting(false)}>Cancel</Button>
          <Button size="sm" variant="primary" loading={busy} onClick={() => void save()}>
            Save
          </Button>
        </span>
      </span>
    );
  }
  if (!board.description && !can) return null;
  if (!can) return <span className="board-about">{board.description}</span>;
  return (
    <button
      type="button"
      className="board-about"
      data-empty={!board.description || undefined}
      onClick={() => onWriting(true)}
    >
      {board.description || "Add a description: what this board is for"}
    </button>
  );
}

/** A board's menu: what an editor does with it, and opening its page from elsewhere. */
export function boardMenu(
  { board, can, inline, onRename, onDescribe, onAddColumn, onDelete, onNewBoard, call }: {
    board: Board;
    can: boolean;
    /** Shown in a space's tab or a side panel: it offers the board's page. */
    inline?: { space: string };
    onRename(): void;
    onDescribe(): void;
    onAddColumn(): void;
    onDelete(): void;
    onNewBoard?(): void;
    call: Call;
  },
): (MenuItem | "separator")[] {
  return [
    ...(inline
      ? [{
        label: "Open its page",
        icon: "external" as const,
        href: boardPath(board._id, inline.space),
      }]
      : []),
    ...(can
      ? [
        { label: "Rename", icon: "pencil" as const, onSelect: onRename },
        {
          label: board.description ? "Edit the description" : "Add a description",
          icon: "note" as const,
          onSelect: onDescribe,
        },
        { label: "Add a column", icon: "plus" as const, onSelect: onAddColumn },
        ...(onNewBoard
          ? [{ label: "New board…", icon: "plus" as const, onSelect: onNewBoard }]
          : []),
        "separator" as const,
        board.archived
          ? {
            label: "Restore",
            icon: "restore" as const,
            onSelect: () => void call("board.update", { board: board._id, archived: false }),
          }
          : {
            label: "Archive",
            icon: "archive" as const,
            onSelect: () => void call("board.update", { board: board._id, archived: true }),
          },
        {
          label: "Delete board…",
          icon: "trash" as const,
          tone: "destructive" as const,
          onSelect: onDelete,
        },
      ]
      : []),
  ];
}

/** Deleting a board, once its editor has read that its cards go too. */
export function DeleteBoard(
  { board, cards, onClose, call, after }: {
    board: Board;
    cards: number;
    onClose(): void;
    call: Call;
    /** Where to go once it's gone. */
    after?: string;
  },
): ReactNode {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  return (
    <Sheet open onClose={onClose} label={`Delete ${board.name}`}>
      <div className="card-sheet">
        <header className="card-sheet-head">
          <span className="card-sheet-where">
            <Glyph name="board" size={15} />
            Delete “{board.name}”?
          </span>
          <span className="card-sheet-head-end">
            <IconButton icon="close" label="Close" size="sm" onClick={onClose} />
          </span>
        </header>
        <div className="card-sheet-body">
          <p className="card-sheet-say">
            {cards
              ? `Its ${cards} card${cards === 1 ? "" : "s"} go with it, for everyone in the space.`
              : "It has no cards."}{" "}
            It can't be brought back. Conversations that mention it keep what they said.
          </p>
          {error ? <p role="alert" className="card-sheet-error">{error}</p> : null}
        </div>
        <footer className="card-sheet-foot">
          <span className="card-sheet-end">
            <Button variant="ghost" onClick={onClose}>Keep it</Button>
            <Button
              variant="destructive"
              icon="trash"
              loading={busy}
              onClick={async () => {
                setBusy(true);
                setError(undefined);
                try {
                  await call("board.delete", { board: board._id });
                  onClose();
                  if (after) go(after);
                } catch (e) {
                  setError(message(e));
                  setBusy(false);
                }
              }}
            >
              Delete board
            </Button>
          </span>
        </footer>
      </div>
    </Sheet>
  );
}

/** A new board in a space: its name, and what it's for; then it opens. */
export function NewBoard(
  { space, where, onClose, call, open = true }: {
    space: string;
    /** The space's name, as it's shown. */
    where: string;
    onClose(): void;
    call: Call;
    /** Whether it goes to the board once made (else it shows where it is). */
    open?: boolean;
  },
): ReactNode {
  const [name, setName] = useState("");
  const [about, setAbout] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const named = useRef<HTMLInputElement>(null);
  // Past the sheet's own first focus (its close button): the name.
  useEffect(() => void requestAnimationFrame(() => named.current?.focus()), []);
  const make = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      const { board } = await call<{ board: string }>("board.create", {
        in: space,
        name: name.trim(),
        ...(about.trim() ? { description: about.trim() } : {}),
      });
      onClose();
      if (open) go(boardPath(board, space));
    } catch (e) {
      setError(message(e));
      setBusy(false);
    }
  };
  return (
    <Sheet open onClose={onClose} label={`New board in ${where}`}>
      <form
        className="card-sheet"
        onSubmit={(event) => {
          event.preventDefault();
          void make();
        }}
      >
        <header className="card-sheet-head">
          <span className="card-sheet-where">
            <Glyph name="board" size={15} />
            New board in {where}
          </span>
          <span className="card-sheet-head-end">
            <IconButton icon="close" label="Close" size="sm" onClick={onClose} />
          </span>
        </header>
        <div className="card-sheet-body">
          <Input
            ref={named}
            maxLength={80}
            placeholder="Launch plan"
            aria-label="The board's name"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
          <Textarea
            autoGrow
            rows={2}
            maxLength={2000}
            placeholder="What it's for, and what done looks like (optional)"
            aria-label="What the board is for"
            value={about}
            onChange={(event) => setAbout(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                void make();
              }
            }}
          />
          <p className="board-quick-hint card-sheet-say">
            It starts with Backlog, To do, Doing, Blocked, In review and Done; change them anytime.
          </p>
          {error ? <p role="alert" className="card-sheet-error">{error}</p> : null}
        </div>
        <footer className="card-sheet-foot">
          <span className="card-sheet-end">
            <Button variant="ghost" onClick={onClose}>Cancel</Button>
            <Button type="submit" variant="primary" loading={busy} disabled={!name.trim()}>
              Make the board
            </Button>
          </span>
        </footer>
      </form>
    </Sheet>
  );
}

export { boardsTab };
