/**
 * Notes on the web: the app's own tab on a space's page (and beside a chat),
 * which shows that an app adds tabs as features do (spaces' `spaceTabs`).
 * The space's notes, newest first, whoever wrote them (people, or agents
 * with `write_note`); writing one (`note.write`; ⌘/Ctrl+Enter); and each
 * one's menu: moving it to another space (`note.move`, through spaces'
 * picker in the command palette, `space.pick`), removing it. In the palette
 * too (the web shell's `palette`): "Move a note…", where a space has notes.
 */
import { type ReactNode, useState } from "react";
import { definePlugin, type Plugin, type ViewContext } from "../../runtime/mod.ts";
import {
  Avatar,
  Button,
  Card,
  EmptyState,
  Kbd,
  Menu,
  message,
  openPalette,
  type PaletteGroup,
  type PaletteStep,
  Skeleton,
  Textarea,
  Time,
} from "../../hosts/web/mod.ts";
import type { Note } from "./notes.ts";

const STYLE = `
.notes { display: grid; gap: 16px; }
.notes-write { display: grid; gap: 8px; padding: 12px; }
.notes-write-row { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px; }
.notes-hint { display: inline-flex; align-items: center; gap: 4px; color: var(--muted-foreground); font-size: 12.5px; }
.notes-error { margin: 0; color: var(--destructive-text); font-size: 13px; }
.note-failed { grid-column: 2 / -1; }
.notes-list { list-style: none; display: grid; gap: 8px; margin: 0; padding: 0; }
.note { display: grid; grid-template-columns: 28px minmax(0, 1fr) auto; gap: 10px; padding: 12px 10px 12px 14px; }
.note-menu { opacity: 0; transition: opacity .12s; }
.note:is(:hover, :focus-within) .note-menu, .note-menu:has([aria-expanded=true]) { opacity: 1; }
@media (pointer: coarse) { .note-menu { opacity: 1; } }
.note-text { margin: 0; line-height: 1.55; white-space: pre-wrap; overflow-wrap: anywhere; }
.note-by { display: flex; align-items: center; gap: 6px; margin: 4px 0 0; color: var(--muted-foreground); font-size: 12.5px; }
.note-by .copilotz-time { font-size: 12.5px; }
.notes-empty { margin: 24px auto 8px; }
.notes-compact .note { padding: 10px 8px 10px 12px; font-size: 14px; }
`;

type Call = <R = unknown>(action: string, input?: unknown) => Promise<R>;

/** The key that sends with Enter: ⌘ on Apple's, Ctrl elsewhere. */
const MOD = /Mac|iP(hone|ad|od)/.test(globalThis.navigator?.platform ?? "") ? "⌘" : "Ctrl";

const notesView = (item: { _id?: string }, ctx: ViewContext<ReactNode>): ReactNode => {
  const space = item._id ?? (typeof ctx.hints.in === "string" ? ctx.hints.in : "");
  // Notes are shared like chats: the rules let a person read a space's directly.
  const notes = ctx.db.collection<Note>("note").find({ in: space }).value;
  const compact = ctx.hints.mode === "panel";
  return (
    <div className={`notes${compact ? " notes-compact" : ""}`}>
      <style href="notes-web" precedence="copilotz">{STYLE}</style>
      <Write space={space} call={ctx.call} />
      {notes === undefined
        ? <Skeleton height={60} radius="xl" />
        : notes.length
        ? (
          <ul className="notes-list">
            {[...notes].sort((a, b) => (b.at ?? "").localeCompare(a.at ?? "")).map((n) => (
              <NoteCard key={n._id} note={n} me={ctx.viewer?.name} call={ctx.call} />
            ))}
          </ul>
        )
        : (
          <EmptyState icon="note" title="No notes here yet" className="notes-empty">
            Write one above, or ask an agent here to note something down.
          </EmptyState>
        )}
    </div>
  );
};

function Write({ space, call }: { space: string; call: Call }): ReactNode {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const save = async () => {
    if (!text.trim() || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      await call("note.write", { in: space, text });
      setText("");
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card
      as="section"
      padding="none"
      className="notes-write"
      aria-label="Write a note"
    >
      <Textarea
        autoGrow
        bare
        rows={2}
        value={text}
        maxLength={4000}
        placeholder="Write a note for everyone here"
        aria-label="A new note"
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            void save();
          }
        }}
      />
      {error ? <p role="alert" className="notes-error">{error}</p> : null}
      <div className="notes-write-row">
        <span className="notes-hint">
          <Kbd>{MOD}</Kbd>
          <Kbd>Enter</Kbd> adds it
        </span>
        <Button
          size="sm"
          variant="primary"
          icon="plus"
          loading={busy}
          disabled={!text.trim()}
          onClick={() => void save()}
        >
          Add note
        </Button>
      </div>
    </Card>
  );
}

/** A note, short enough to say in a step's name. */
const gist = (text: string, most = 36) =>
  text.length > most ? `${text.slice(0, most - 1).trimEnd()}…` : text;

/** Moving a note to another space: spaces' picker, then `note.move`. */
const moveStep = (note: Note, call: Call): PaletteStep => ({
  title: `Move “${gist(note.text)}” to…`,
  placeholder: "Find a space",
  view: "space.pick",
  hints: { from: note.in },
  pick: (space) => call("note.move", { note: note._id, to: (space as { _id: string })._id }),
});

function NoteCard({ note: n, me, call }: { note: Note; me?: string; call: Call }): ReactNode {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const mine = n.by === me;
  return (
    <Card as="li" padding="none" className="note">
      <Avatar name={n.by || "?"} size={28} />
      <div>
        <p className="note-text">{n.text}</p>
        <p className="note-by">
          {mine ? "You" : n.by || "Someone"}
          {n.at
            ? (
              <>
                <span aria-hidden="true">·</span>
                <Time at={n.at} />
              </>
            )
            : null}
        </p>
      </div>
      <span className="note-menu" aria-busy={busy || undefined}>
        <Menu
          label="This note: more"
          align="end"
          size="sm"
          items={[
            {
              label: "Move to another space…",
              icon: "move",
              onSelect: () => openPalette(moveStep(n, call)),
            },
            "separator",
            {
              label: "Remove",
              icon: "trash",
              tone: "destructive",
              onSelect: async () => {
                setBusy(true);
                setError(undefined);
                try {
                  await call("note.remove", { note: n._id });
                } catch (e) {
                  setError(message(e));
                  setBusy(false);
                }
              },
            },
          ]}
        />
      </span>
      {error ? <p role="alert" className="notes-error note-failed">{error}</p> : null}
    </Card>
  );
}

/** A space's notes to pick one to move (a palette step, hints `{ in }`); then where it goes. */
const notePickView = (_: unknown, ctx: ViewContext<ReactNode>): PaletteGroup[] | null => {
  const notes = ctx.db.collection<Note>("note").find({ in: String(ctx.hints.in ?? "") }).value;
  if (!notes) return null;
  return [{
    title: "Notes",
    limit: 12,
    items: [...notes].sort((a, b) => (b.at ?? "").localeCompare(a.at ?? "")).map((n) => ({
      key: `note:${n._id}`,
      label: n.text,
      icon: "note" as const,
      description: n.by === ctx.viewer?.name ? "Yours" : n.by,
      step: moveStep(n, ctx.call),
    })),
  }];
};

/** In the command palette: moving a note, where the space the person is in has some. */
const notesPaletteView = (_: unknown, ctx: ViewContext<ReactNode>): PaletteGroup[] | null => {
  const here = typeof ctx.hints.in === "string" ? ctx.hints.in : undefined;
  const notes = here ? ctx.db.collection<Note>("note").find({ in: here }, { limit: 1 }).value : [];
  if (!here || !notes?.length) return null;
  return [{
    title: "This space",
    order: 10,
    items: [{
      key: "note:move-one",
      label: "Move a note to another space…",
      icon: "note",
      keywords: ["note", "notes", "space"],
      step: {
        title: "Move a note…",
        placeholder: "Find a note",
        view: "note.pick",
        hints: { in: here },
      },
    }],
  }];
};

export const notesWeb: Plugin = definePlugin({
  name: "notes-web",
  requires: ["web-shell"],
  views: {
    notes: { web: notesView },
    "note.pick": { web: notePickView },
    "notes.palette": { web: notesPaletteView },
  },
  resources: {
    spaceTabs: { notes: { title: "Notes", view: "notes", icon: "note", order: 50 } },
    palette: { notes: { view: "notes.palette", order: 50 } },
  },
});
