/// <reference lib="dom" />
/**
 * A board's column: its stage mark, its name (renamed in place by editors),
 * how many cards it has (and how many show, when filtered), its menu (add a
 * card, rename, move it left or right, remove it: at once when it's empty,
 * or saying where its cards go), its cards, and a quick add at its foot. In
 * a side panel it folds. And the board's last column: one to add.
 */
import { type FormEvent, type ReactNode, useEffect, useRef, useState } from "react";
import {
  Button,
  Icon,
  IconButton,
  InlineEdit,
  Input,
  Kbd,
  Menu,
  type MenuItem,
  message,
  Select,
  Textarea,
} from "../../../../../hosts/web/mod.ts";
import type { Column } from "../../contract.ts";
import { stageOf } from "../../shared/columns.ts";
import { Sheet } from "./card-sheet.tsx";
import { StageMark } from "./glyphs.tsx";

type Call = <R = unknown>(action: string, input?: unknown) => Promise<R>;

export function ColumnView(
  {
    column,
    index,
    columns,
    total,
    shown,
    can,
    compact,
    over,
    folded,
    onFold,
    adding,
    onAdding,
    onAdd,
    onChange,
    onRemove,
    children,
  }: {
    column: Column;
    index: number;
    columns: Column[];
    /** Its cards, and how many of them the filters show. */
    total: number;
    shown: number;
    can: boolean;
    compact: boolean;
    /** A dragged card would land here. */
    over: boolean;
    folded: boolean;
    onFold(): void;
    /** The quick add at its foot is open. */
    adding: boolean;
    onAdding(open: boolean): void;
    onAdd(title: string): Promise<void>;
    /** The board's columns, changed: renamed or moved. */
    onChange(columns: Column[]): Promise<unknown>;
    /** Removes it, its cards going `into` another column. */
    onRemove(into?: string): Promise<unknown>;
    children: ReactNode;
  },
): ReactNode {
  const [renaming, setRenaming] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState<string>();
  const counted = shown === total ? `${total}` : `${shown} of ${total}`;
  const swap = (by: number) => {
    const next = [...columns];
    const [moved] = next.splice(index, 1);
    next.splice(index + by, 0, moved);
    void onChange(next).catch((e) => setError(message(e)));
  };
  const items: (MenuItem | "separator")[] = [
    { label: "Add a card", icon: "plus", onSelect: () => onAdding(true) },
    { label: "Rename", icon: "pencil", onSelect: () => setRenaming(true) },
    ...(index > 0
      ? [{
        label: compact ? "Move up" : "Move left",
        icon: "chevron-left" as const,
        onSelect: () => swap(-1),
      }]
      : []),
    ...(index < columns.length - 1
      ? [{
        label: compact ? "Move down" : "Move right",
        icon: "chevron" as const,
        onSelect: () => swap(1),
      }]
      : []),
    ...(columns.length > 1
      ? [
        "separator" as const,
        {
          label: total ? "Remove column…" : "Remove column",
          icon: "trash" as const,
          tone: "destructive" as const,
          onSelect: () =>
            total ? setRemoving(true) : void onRemove().catch((e) => setError(message(e))),
        },
      ]
      : []),
  ];
  return (
    <section
      className="board-column"
      data-column={column.id}
      data-over={over || undefined}
      aria-label={`${column.name}, ${counted} card${total === 1 ? "" : "s"}`}
    >
      <header className="board-column-head">
        {compact
          ? (
            <button
              type="button"
              className="board-fold"
              aria-expanded={!folded}
              aria-label={folded ? `Show ${column.name}` : `Fold ${column.name}`}
              onClick={onFold}
            >
              <Icon name="chevron-down" size={15} />
            </button>
          )
          : null}
        <StageMark stage={stageOf(column)} />
        {renaming
          ? (
            <InlineEdit
              className="board-column-rename"
              label="The column's name"
              value={column.name}
              maxLength={40}
              size="sm"
              save={(name) => onChange(columns.map((c) => c.id === column.id ? { ...c, name } : c))}
              done={() => setRenaming(false)}
            />
          )
          : can
          ? (
            <button
              type="button"
              className="board-column-name"
              title="Rename"
              onClick={() => setRenaming(true)}
            >
              {column.name}
            </button>
          )
          : <h3 className="board-column-name">{column.name}</h3>}
        {renaming ? null : <span className="board-column-count">{counted}</span>}
        {can && !renaming
          ? (
            <span className="board-column-tools">
              <IconButton
                icon="plus"
                label={`Add a card to ${column.name}`}
                size="sm"
                onClick={() => onAdding(true)}
              />
              <Menu label={`${column.name}: more`} align="end" size="sm" items={items} />
            </span>
          )
          : null}
      </header>
      {error ? <p role="alert" className="board-error board-column-error">{error}</p> : null}
      {children}
      {can && !folded
        ? (
          <div className="board-column-foot">
            {adding
              ? <QuickAdd column={column} onAdd={onAdd} onClose={() => onAdding(false)} />
              : (
                <button type="button" className="board-add" onClick={() => onAdding(true)}>
                  <Icon name="plus" size={15} />
                  Add a card
                </button>
              )}
          </div>
        )
        : null}
      {removing
        ? (
          <RemoveColumn
            column={column}
            columns={columns}
            total={total}
            onClose={() => setRemoving(false)}
            onRemove={onRemove}
          />
        )
        : null}
    </section>
  );
}

/** A card's title typed at a column's foot: Enter adds it and keeps the field for the next. */
function QuickAdd(
  { column, onAdd, onClose }: {
    column: Column;
    onAdd(title: string): Promise<void>;
    onClose(): void;
  },
): ReactNode {
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const field = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    field.current?.focus();
    field.current?.scrollIntoView({ block: "nearest" });
  }, []);
  const add = async () => {
    const text = title.trim();
    if (!text || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      await onAdd(text);
      setTitle("");
      requestAnimationFrame(() => field.current?.scrollIntoView({ block: "nearest" }));
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
      field.current?.focus();
    }
  };
  return (
    <div className="board-quick">
      <Textarea
        ref={field}
        bare
        autoGrow
        rows={2}
        maxLength={300}
        aria-label={`A new card in ${column.name}`}
        placeholder="What's the outcome?"
        value={title}
        onChange={(event) => setTitle(event.target.value.replace(/\n/g, " "))}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            void add();
          } else if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            onClose();
          }
        }}
        onBlur={(event) => {
          // Leaving it empty, for somewhere else on the page, closes it.
          const to = event.relatedTarget as HTMLElement | null;
          if (!title.trim() && !event.currentTarget.closest(".board-quick")?.contains(to)) {
            onClose();
          }
        }}
      />
      {error ? <p role="alert" className="board-error">{error}</p> : null}
      <div className="board-quick-end">
        <span className="board-quick-hint">
          <Kbd>Enter</Kbd> adds · <Kbd>Esc</Kbd> closes
        </span>
        <span className="board-quick-buttons">
          <IconButton icon="close" label="Close" size="sm" onClick={onClose} />
          <Button
            size="sm"
            variant="primary"
            loading={busy}
            disabled={!title.trim()}
            onClick={() => void add()}
          >
            Add
          </Button>
        </span>
      </div>
    </div>
  );
}

/** Removing a column that has cards: where they go first. */
function RemoveColumn(
  { column, columns, total, onClose, onRemove }: {
    column: Column;
    columns: Column[];
    total: number;
    onClose(): void;
    onRemove(into?: string): Promise<unknown>;
  },
): ReactNode {
  const others = columns.filter((c) => c.id !== column.id);
  const [into, setInto] = useState(others[0]?.id ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  return (
    <Sheet open onClose={onClose} label={`Remove ${column.name}`}>
      <form
        className="card-sheet"
        onSubmit={async (event: FormEvent) => {
          event.preventDefault();
          setBusy(true);
          setError(undefined);
          try {
            await onRemove(into);
            onClose();
          } catch (e) {
            setError(message(e));
            setBusy(false);
          }
        }}
      >
        <header className="card-sheet-head">
          <span className="card-sheet-where">
            <StageMark stage={stageOf(column)} />
            Remove “{column.name}”
          </span>
          <span className="card-sheet-head-end">
            <IconButton icon="close" label="Close" size="sm" onClick={onClose} />
          </span>
        </header>
        <div className="card-sheet-body">
          <p className="card-sheet-say">
            It has {total} card{total === 1 ? "" : "s"}. Move {total === 1 ? "it" : "them"} to:
          </p>
          <Select
            value={into}
            onChange={(event) => setInto(event.target.value)}
            aria-label="Where its cards go"
          >
            {others.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
          {error ? <p role="alert" className="card-sheet-error">{error}</p> : null}
        </div>
        <footer className="card-sheet-foot">
          <span className="card-sheet-meta">
            {total === 1 ? "It goes" : "They go"} to the bottom, in the order they're in.
          </span>
          <span className="card-sheet-end">
            <Button variant="ghost" onClick={onClose}>Cancel</Button>
            <Button type="submit" variant="destructive" loading={busy}>Move and remove</Button>
          </span>
        </footer>
      </form>
    </Sheet>
  );
}

/** The board's last column: a new one, named and added. */
export function NewColumn(
  { open, onOpen, onAdd }: {
    open: boolean;
    onOpen(open: boolean): void;
    onAdd(name: string): Promise<unknown>;
  },
): ReactNode {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (open) box.current?.scrollIntoView({ inline: "end", block: "nearest", behavior: "smooth" });
  }, [open]);
  return (
    <div className="board-new-column" ref={box}>
      {open
        ? (
          <form
            onSubmit={async (event) => {
              event.preventDefault();
              if (!name.trim() || busy) return;
              setBusy(true);
              setError(undefined);
              try {
                await onAdd(name.trim());
                setName("");
              } catch (e) {
                setError(message(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            <Input
              size="sm"
              autoFocus
              maxLength={40}
              placeholder="The column's name"
              aria-label="The new column's name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  onOpen(false);
                }
              }}
            />
            {error ? <p role="alert" className="board-error">{error}</p> : null}
            <div className="board-new-column-end">
              <Button size="sm" variant="ghost" onClick={() => onOpen(false)}>Cancel</Button>
              <Button
                size="sm"
                variant="primary"
                type="submit"
                loading={busy}
                disabled={!name.trim()}
              >
                Add column
              </Button>
            </div>
          </form>
        )
        : (
          <button type="button" onClick={() => onOpen(true)}>
            <Icon name="plus" size={16} />
            Add a column
          </button>
        )}
    </div>
  );
}
