/**
 * A card's details, over the board: a dialog, or a sheet from the bottom on
 * a phone. Its title (changed in place), its column, owner (the space's
 * people and agents), labels and due date, each saved as it's chosen; its
 * description, Markdown, written and previewed; who made it and who changed
 * it last; deleting it, after a question. Live: what others change shows at
 * once, and what you're writing stays yours until you save it.
 *
 * Making a card is the same sheet with nothing saved until "Create card".
 */
import { type ReactNode, useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  Button,
  Dialog,
  Drawer,
  Icon,
  IconButton,
  Input,
  Kbd,
  Markdown,
  Menu,
  type MenuItem,
  message,
  Tabs,
  Textarea,
  Time,
} from "../../../../../hosts/web/mod.ts";
import type { Board, Card, Column } from "../../contract.ts";
import { boardPath } from "../../contract.ts";
import { stageOf } from "../../shared/columns.ts";
import { Glyph, StageMark } from "./glyphs.tsx";
import { AssigneePicker, Face, LabelPicker } from "./pickers.tsx";
import { dayOf, dueShown, hueOf, type Names, type Someone, someoneOf, type Team } from "./shown.ts";

type Call = <R = unknown>(action: string, input?: unknown) => Promise<R>;

/** The key that sends with Enter: ⌘ on Apple's, Ctrl elsewhere. */
export const MOD = /Mac|iP(hone|ad|od)/.test(globalThis.navigator?.platform ?? "") ? "⌘" : "Ctrl";

const PHONE = "(max-width: 640px)";
const phone = {
  subscribe(changed: () => void) {
    const query = matchMedia(PHONE);
    query.addEventListener("change", changed);
    return () => query.removeEventListener("change", changed);
  },
  matches: () => matchMedia(PHONE).matches,
};

/** Whether the screen is a phone's: sheets come from the bottom there. */
export const usePhone = () => useSyncExternalStore(phone.subscribe, phone.matches, () => false);

/** A dialog, or on a phone a sheet from the bottom. */
export function Sheet(
  { open, onClose, label, children }: {
    open: boolean;
    onClose(): void;
    label: string;
    children: ReactNode;
  },
): ReactNode {
  const narrow = usePhone();
  return narrow
    ? (
      <Drawer open={open} onClose={onClose} side="bottom" label={label}>
        {children}
      </Drawer>
    )
    : (
      <Dialog open={open} onClose={onClose} label={label} size="lg" bare>
        {children}
      </Dialog>
    );
}

/** What a card's sheet edits: its fields, as a new card's draft or a card's. */
type Draft = {
  title: string;
  column: string;
  description: string;
  assignee?: string;
  labels: string[];
  due?: string;
};

const draftOf = (card: Card): Draft => ({
  title: card.title,
  column: card.column,
  description: card.description ?? "",
  ...(card.assignee ? { assignee: card.assignee } : {}),
  labels: card.labels ?? [],
  ...(card.due ? { due: card.due } : {}),
});

export function CardSheet(
  {
    board,
    card,
    column: startIn,
    people,
    team,
    names,
    me,
    labels,
    today,
    can,
    space,
    call,
    onClose,
    onMove,
  }: {
    board: Board;
    /** The card, live; none to make one. */
    card?: Card;
    /** Where a new card starts. */
    column?: string;
    people: Someone[];
    team?: Team;
    /** People's names by id (their profiles'): who made and changed it, too. */
    names?: Names;
    me?: string;
    /** The board's labels, to choose from. */
    labels: string[];
    today: string;
    can: boolean;
    space?: string;
    call: Call;
    onClose(): void;
    /** Moves the card to a column, the way the board does it (at its bottom). */
    onMove(card: Card, column: string, at?: "top" | "bottom"): Promise<void>;
  },
): ReactNode {
  const making = !card;
  const [draft, setDraft] = useState<Draft>(() =>
    card ? draftOf(card) : {
      title: "",
      column: startIn ?? board.columns[0]?.id ?? "",
      description: "",
      labels: [],
    }
  );
  const [writing, setWriting] = useState(false);
  const [tab, setTab] = useState<"write" | "preview">("write");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const titleRef = useRef<HTMLTextAreaElement>(null);
  /** Escape in the title puts it back: the blur that follows saves nothing. */
  const reverting = useRef(false);

  // Others' changes show at once, except in what's being written here.
  const live = card ? draftOf(card) : undefined;
  const shown: Draft = live
    ? {
      ...live,
      title: titleRef.current === document.activeElement ? draft.title : live.title,
      description: writing ? draft.description : live.description,
    }
    : draft;
  useEffect(() => {
    if (live && titleRef.current !== document.activeElement) {
      setDraft((d) => ({ ...d, title: live.title }));
    }
  }, [live?.title]);
  useEffect(() => {
    // Drawn before its dialog opened, the title measured nothing: it grows to its text once shown.
    requestAnimationFrame(() => {
      const field = titleRef.current;
      if (!field) return;
      field.style.height = "auto";
      field.style.height = `${field.scrollHeight}px`;
      if (making) field.focus();
    });
  }, []);

  const column = board.columns.find((c) => c.id === shown.column) ?? board.columns[0];
  const owner = shown.assignee
    ? people.find((p) => p.key === shown.assignee) ??
      someoneOf(shown.assignee, team, me, names)
    : undefined;

  /** Saves a change to a card at once; a new card keeps it in its draft. */
  const save = async (change: Partial<Record<keyof Draft, unknown>>) => {
    setError(undefined);
    if (making) return setDraft((d) => ({ ...d, ...change }) as Draft);
    try {
      await call("card.update", { card: card!._id, ...change });
    } catch (e) {
      setError(message(e));
      throw e;
    }
  };
  const set = (change: Partial<Record<keyof Draft, unknown>>) => void save(change).catch(() => {});

  const saveTitle = async () => {
    const title = draft.title.trim();
    if (reverting.current) {
      reverting.current = false;
      return;
    }
    if (making || !card) return;
    if (!title) return setDraft((d) => ({ ...d, title: card.title }));
    if (title !== card.title) await save({ title }).catch(() => {});
  };

  const create = async () => {
    const title = draft.title.trim();
    if (!title || busy) {
      titleRef.current?.focus();
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      await call("card.create", {
        board: board._id,
        title,
        column: draft.column,
        ...(draft.description.trim() ? { description: draft.description } : {}),
        ...(draft.assignee ? { assignee: draft.assignee } : {}),
        ...(draft.labels.length ? { labels: draft.labels } : {}),
        ...(draft.due ? { due: draft.due } : {}),
      });
      onClose();
    } catch (e) {
      setError(message(e));
      setBusy(false);
    }
  };

  const saveDescription = async () => {
    if (making) return setWriting(false);
    setBusy(true);
    try {
      await save({ description: draft.description.trim() ? draft.description : null });
      setWriting(false);
    } catch {
      // Said already.
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!card) return;
    setBusy(true);
    try {
      await call("card.delete", { card: card._id });
      onClose();
    } catch (e) {
      setError(message(e));
      setBusy(false);
    }
  };

  const moveTo = (to: Column) => {
    if (making) return setDraft((d) => ({ ...d, column: to.id }));
    if (to.id === card!.column) return;
    void onMove(card!, to.id).catch((e) => setError(message(e)));
  };

  const columnItems: (MenuItem | "separator")[] = board.columns.map((c) => ({
    label: c.name,
    ...(c.id === shown.column ? { icon: "check" as const } : {}),
    onSelect: () => moveTo(c),
  }));
  const more: (MenuItem | "separator")[] = card
    ? [
      {
        label: "Copy link",
        icon: "copy",
        onSelect: () =>
          void navigator.clipboard?.writeText(
            new URL(boardPath(board._id, space, card._id), location.href).href,
          ),
      },
      ...(can
        ? [
          {
            label: "Move to the top",
            icon: "send" as const,
            onSelect: () => void onMove(card, card.column, "top"),
          },
          {
            label: "Move to the bottom",
            icon: "down" as const,
            onSelect: () => void onMove(card, card.column, "bottom"),
          },
          "separator" as const,
          {
            label: "Delete card…",
            icon: "trash" as const,
            tone: "destructive" as const,
            onSelect: () => setDeleting(true),
          },
        ]
        : []),
    ]
    : [];

  const due = shown.due ? dueShown(shown.due, today, stageOf(column) === "done") : undefined;
  const editable = can;

  return (
    <div className="card-sheet">
      <header className="card-sheet-head">
        <span className="card-sheet-where">
          <Glyph name="board" size={15} />
          <a href={boardPath(board._id, space)}>{board.name}</a>
          {making ? <span>· New card</span> : null}
        </span>
        <span className="card-sheet-head-end">
          {card ? <Menu label="This card: more" align="end" size="sm" items={more} /> : null}
          <IconButton icon="close" label="Close" size="sm" onClick={onClose} />
        </span>
      </header>
      <div className="card-sheet-body">
        <Textarea
          ref={titleRef}
          bare
          autoGrow
          rows={1}
          maxLength={300}
          className="card-sheet-title"
          aria-label="The card's title"
          placeholder={making ? "What's the outcome?" : "Title"}
          readOnly={!editable}
          value={shown.title}
          onChange={(event) =>
            setDraft((d) => ({ ...d, title: event.target.value.replace(/\n/g, " ") }))}
          onBlur={() => void saveTitle()}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              if (making && (event.metaKey || event.ctrlKey)) void create();
              else if (making) {
                document.querySelector<HTMLElement>(".card-props .card-prop")?.focus();
              } else event.currentTarget.blur();
            }
            if (event.key === "Escape" && !making && card && draft.title !== card.title) {
              event.preventDefault();
              event.stopPropagation();
              reverting.current = true;
              setDraft((d) => ({ ...d, title: card.title }));
              event.currentTarget.blur();
            }
          }}
        />
        <dl className="card-props">
          <dt>
            <StageMark stage={stageOf(column)} size={14} />
            Column
          </dt>
          <dd>
            {editable
              ? (
                <Menu
                  label="Column"
                  items={columnItems}
                  trigger={(props) => (
                    <button type="button" className="card-prop" {...props}>
                      <span>{column?.name}</span>
                      <Icon name="chevron-down" size={14} />
                    </button>
                  )}
                />
              )
              : <span>{column?.name}</span>}
          </dd>
          <dt>
            <Icon name="person" size={15} />
            Owner
          </dt>
          <dd>
            {editable
              ? (
                <AssigneePicker
                  people={people}
                  value={shown.assignee}
                  onChange={(key) => set({ assignee: key })}
                  trigger={(props) => (
                    <button
                      type="button"
                      className="card-prop"
                      data-empty={!owner || undefined}
                      {...props}
                    >
                      <Face someone={owner} size={22} />
                      <span>{owner?.name ?? "Nobody yet"}</span>
                    </button>
                  )}
                />
              )
              : (
                <span className="card-prop">
                  <Face someone={owner} size={22} />
                  <span>{owner?.name ?? "Nobody yet"}</span>
                </span>
              )}
          </dd>
          <dt>
            <Glyph name="label" size={15} />
            Labels
          </dt>
          <dd>
            <span className="card-prop-labels">
              {shown.labels.map((label) => (
                <span key={label} className="board-label" data-hue={hueOf(label)}>
                  <span>{label}</span>
                  {editable
                    ? (
                      <button
                        type="button"
                        className="card-label-x"
                        aria-label={`Take off “${label}”`}
                        onClick={() =>
                          set({
                            labels: shown.labels.filter((l) => l !== label).length
                              ? shown.labels.filter((l) =>
                                l !== label
                              )
                              : making
                              ? []
                              : null,
                          })}
                      >
                        <Icon name="close" size={11} />
                      </button>
                    )
                    : null}
                </span>
              ))}
              {editable
                ? (
                  <LabelPicker
                    known={labels}
                    value={shown.labels}
                    onChange={(next) => set({ labels: next.length ? next : making ? [] : null })}
                    trigger={(props) => (
                      <button
                        type="button"
                        className="card-prop"
                        data-empty={!shown.labels.length || undefined}
                        aria-label={shown.labels.length ? "Change labels" : "Add labels"}
                        {...props}
                      >
                        <Icon name="plus" size={14} />
                        {shown.labels.length ? null : <span>Add labels</span>}
                      </button>
                    )}
                  />
                )
                : shown.labels.length
                ? null
                : <span className="card-due-said">None</span>}
            </span>
          </dd>
          <dt>
            <Glyph name="calendar" size={15} />
            Due
          </dt>
          <dd className="card-due">
            {editable
              ? (
                <Input
                  type="date"
                  size="sm"
                  aria-label="Due date"
                  value={shown.due ?? ""}
                  onChange={(event) =>
                    set({ due: event.target.value || (making ? undefined : null) })}
                  end={shown.due
                    ? (
                      <IconButton
                        icon="close"
                        label="Clear the due date"
                        size="sm"
                        onClick={() => set({ due: making ? undefined : null })}
                      />
                    )
                    : undefined}
                />
              )
              : <span>{shown.due ? dayOf(shown.due, today) : "None"}</span>}
            {due ? <span className="card-due-said" data-tone={due.tone}>{due.title}</span> : null}
          </dd>
        </dl>
        <section className="card-desc" aria-labelledby="card-desc-title">
          <div className="card-desc-head">
            <h3 id="card-desc-title">Description</h3>
            {writing
              ? (
                <Tabs
                  label="Write or preview"
                  value={tab}
                  onChange={setTab}
                  tabs={[{ value: "write", label: "Write" }, {
                    value: "preview",
                    label: "Preview",
                  }]}
                />
              )
              : null}
          </div>
          {writing || (making && editable)
            ? (
              <>
                {tab === "write" || !writing
                  ? (
                    <Textarea
                      autoGrow
                      maxHeight={420}
                      rows={making ? 3 : 6}
                      maxLength={20000}
                      aria-label="The card's description"
                      placeholder="What's the outcome? How will we know it's done? What blocks it? (Markdown)"
                      value={draft.description}
                      autoFocus={!making}
                      onFocus={() => making && setWriting(true)}
                      onChange={(event) => {
                        const description = event.target.value;
                        setDraft((d) => ({ ...d, description }));
                      }}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                          event.preventDefault();
                          if (making) void create();
                          else void saveDescription();
                        }
                        if (event.key === "Escape" && !making) {
                          event.preventDefault();
                          event.stopPropagation();
                          setDraft((d) => ({ ...d, description: card?.description ?? "" }));
                          setWriting(false);
                        }
                      }}
                    />
                  )
                  : (
                    <div className="card-desc-preview">
                      {draft.description.trim()
                        ? <Markdown text={draft.description} />
                        : <p className="card-due-said">Nothing to preview yet.</p>}
                    </div>
                  )}
                {!making
                  ? (
                    <div className="card-desc-end">
                      <span className="board-quick-hint">
                        <Kbd>{MOD}</Kbd>
                        <Kbd>Enter</Kbd> saves · Markdown works
                      </span>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          setDraft((d) => ({ ...d, description: card?.description ?? "" }));
                          setWriting(false);
                        }}
                      >
                        Cancel
                      </Button>
                      <Button
                        size="sm"
                        variant="primary"
                        loading={busy}
                        onClick={() => void saveDescription()}
                      >
                        Save
                      </Button>
                    </div>
                  )
                  : null}
              </>
            )
            : (
              <button
                type="button"
                className="card-desc-view"
                data-empty={!shown.description.trim() || undefined}
                disabled={!editable}
                onClick={() => {
                  setDraft((d) => ({ ...d, description: card?.description ?? "" }));
                  setTab("write");
                  setWriting(true);
                }}
              >
                {shown.description.trim()
                  ? <Markdown text={shown.description} />
                  : editable
                  ? "Add a description: the outcome, how we'll know it's done, any blocker…"
                  : "No description."}
              </button>
            )}
        </section>
        {error ? <p role="alert" className="card-sheet-error">{error}</p> : null}
      </div>
      <footer className="card-sheet-foot">
        {making
          ? (
            <>
              <span className="card-sheet-meta">
                <span className="board-quick-hint">
                  <Kbd>{MOD}</Kbd>
                  <Kbd>Enter</Kbd> creates it
                </span>
              </span>
              <span className="card-sheet-end">
                <Button variant="ghost" onClick={onClose}>Cancel</Button>
                <Button
                  variant="primary"
                  loading={busy}
                  disabled={!draft.title.trim()}
                  onClick={() => void create()}
                >
                  Create card
                </Button>
              </span>
            </>
          )
          : deleting
          ? (
            <>
              <span className="card-sheet-meta">
                Delete “{card!.title}”? It can't be brought back.
              </span>
              <span className="card-sheet-end">
                <Button size="sm" variant="ghost" onClick={() => setDeleting(false)}>
                  Keep it
                </Button>
                <Button
                  size="sm"
                  variant="destructive"
                  icon="trash"
                  loading={busy}
                  onClick={() => void remove()}
                >
                  Delete
                </Button>
              </span>
            </>
          )
          : (
            <>
              <span className="card-sheet-meta">
                <span>
                  Made by {who(card!.by, team, me, names)} <Time at={card!.at} />
                </span>
                {card!.updated && card!.updatedBy
                  ? (
                    <span>
                      changed by {who(card!.updatedBy, team, me, names)} <Time at={card!.updated} />
                    </span>
                  )
                  : null}
              </span>
              {can
                ? (
                  <span className="card-sheet-end">
                    <Button
                      size="sm"
                      variant="ghost"
                      icon="trash"
                      onClick={() => setDeleting(true)}
                    >
                      Delete
                    </Button>
                  </span>
                )
                : null}
            </>
          )}
      </footer>
    </div>
  );
}

/** Who did something, as a sentence says it: "you", "North", "bob". */
function who(key: string | undefined, team: Team | undefined, me?: string, names?: Names): string {
  if (!key || key === "system") return "the app";
  if (key === `person:${me}`) return "you";
  return someoneOf(key, team, undefined, names).name;
}
