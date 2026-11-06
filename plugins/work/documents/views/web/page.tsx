/**
 * A document's page (kind `document`, at `/document/<id>`): the title in
 * place, then the writing surface (editor.tsx: Write, Preview or Split),
 * for those who may change it; for those who may only read it (viewers, an
 * archived space), the document as it reads.
 *
 * - **Saving** is explicit: ⌘S (Ctrl+S) or Save, each one a version. What's
 *   unsaved says so, honestly, and is kept in the browser as you type, so a
 *   closed tab loses nothing (it's there, and said, next time).
 * - **Live:** others' saves come in at once. With nothing unsaved, the page
 *   takes them; with something, it says who saved what, and whether saving
 *   will merge (changes to other lines) or clash (the same lines), and lets
 *   the person settle it before they save.
 * - **Who's here:** others with it open, and who's editing, in its header.
 * - **A clash** on saving (`conflict`): the conflict screen (conflict.tsx).
 * - **History** (a drawer, history.tsx): every version, its changes, and
 *   restoring one. Copying its link, downloading its Markdown, deleting it,
 *   from its menu.
 */
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import type { ViewContext } from "../../../../../runtime/mod.ts";
import {
  Badge,
  Button,
  Dialog,
  Drawer,
  EmptyState,
  go,
  Icon,
  Kbd,
  keep,
  kept,
  LazyView,
  Menu,
  type MenuItem,
  message,
  Notice,
  Page,
  Skeleton,
  Spinner,
  Time,
  Title,
  Tooltip,
} from "../../../../../hosts/web/mod.ts";
import type { Document, Presence } from "../../contract.ts";
import { merge, mergeField } from "../../shared/merge.ts";
import { documentsTab, kb, UNTITLED } from "../../shared/text.ts";
import { Conflict, type Sides } from "./conflict.tsx";
import { Diff } from "./changes.tsx";
import { draftOf, dropDraft, keepDraft } from "./draft.ts";
import { Editor, Glyph, type Mode, Toolbar, useWide } from "./editor.tsx";
import { wordsIn } from "./format.ts";
import { RESTORED } from "./history.tsx";
import {
  type Call,
  count,
  type Known,
  MOD,
  modded,
  type Place,
  placeName,
  said,
  shownAs,
  useNow,
  whoIn,
  writes,
} from "./people.tsx";
import { hereNow, named, Present, usePresence } from "./presence.tsx";
import { STYLE } from "./style.ts";

const style = <style href="documents-web" precedence="copilotz">{STYLE}</style>;

export const documentView = (item: { _id?: string }, ctx: ViewContext<ReactNode>): ReactNode => {
  const id = item._id ?? "";
  const query = (ctx.hints.query ?? {}) as Record<string, string>;
  const doc = ctx.db.collection<Document>("document").findOne({ _id: id }).value;
  const places = ctx.db.collection("space").query<Place[]>("reached", {}).value;
  const presence = ctx.db.collection<Presence>("documentPresence").find({ document: id }).value;
  const known = whoIn(ctx, [
    doc?.savedBy,
    doc?.createdBy,
    doc?.savedFor,
    ...(presence ?? []).map((p) => p.who),
  ]);
  const me = ctx.viewer?.name ?? ctx.actor?.id;
  if (doc === undefined || places === undefined) {
    return (
      <Page title={<Skeleton width={260} height={32} />}>
        {style}
        <div className="doc-loading" aria-busy="true">
          <Skeleton height={18} width="40%" />
          <Skeleton height={40} radius="lg" />
          <Skeleton height={320} radius="xl" />
        </div>
      </Page>
    );
  }
  if (!doc) return <Missing id={id} me={me} />;
  const place = places.find((p) => p._id === doc.in);
  return (
    <>
      {style}
      <DocumentPage
        key={id}
        doc={doc}
        place={place}
        me={me}
        presence={presence ?? []}
        known={known}
        query={query}
        call={ctx.call}
      />
    </>
  );
};

/** Where a draft started: a version, and its title and text. */
type Base = { version: number; text: string; title: string };

/** What happened last, said for a moment under the title. */
type Said = { tone: "success" | "info"; text: string };

function DocumentPage(
  { doc, place, me, presence, known, query, call }: {
    doc: Document;
    place?: Place;
    me?: string;
    presence: Presence[];
    known: Known;
    query: Record<string, string>;
    call: Call;
  },
): ReactNode {
  const viewer = me ?? "";
  const write = writes(place);
  const where = place ? placeName(place) : "its space";
  const shown = (key: string) => shownAs(key, known);
  const field = useRef<HTMLTextAreaElement>(null);
  const titleField = useRef<HTMLTextAreaElement>(null);
  const [page] = useState(() => crypto.randomUUID().slice(0, 18));

  // What was left unsaved here last time, if it's still unsaved.
  const [kept0] = useState(() => {
    const d = write ? draftOf(viewer, doc._id) : undefined;
    if (d && d.text === doc.text && d.title === doc.title) {
      dropDraft(viewer, doc._id);
      return undefined;
    }
    return d && (d.text !== d.baseText || d.title !== d.baseTitle) ? d : undefined;
  });
  const [base, setBase] = useState<Base>(() =>
    kept0
      ? { version: kept0.base, text: kept0.baseText, title: kept0.baseTitle }
      : { version: doc.version, text: doc.text, title: doc.title }
  );
  const [text, setText] = useState(() => kept0?.text ?? doc.text);
  const [title, setTitle] = useState(() => kept0?.title ?? doc.title);
  const [restoredDraft, setRestoredDraft] = useState(kept0?.at);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const [flash, setFlash] = useState<Said>();
  const [conflict, setConflict] = useState<{ base: Base; mine: Sides }>();
  const [conflictError, setConflictError] = useState<string>();
  const [aside, setAside] = useState<Sides>();
  const [showHistory, setHistory] = useState(query.history === "1");
  const [deleting, setDeleting] = useState(false);
  const [theirsOpen, setTheirsOpen] = useState(false);
  const wide = useWide();
  const [mode, setModeState] = useState<Mode>(() => {
    const k = kept(`copilotz-document-mode:${viewer}`);
    return k === "preview" || k === "split" ? k : "write";
  });
  const setMode = (m: Mode) => {
    setModeState(m);
    keep(`copilotz-document-mode:${viewer}`, m);
  };
  const shownMode: Mode = !write ? "preview" : mode === "split" && !wide ? "write" : mode;

  const dirty = text !== base.text || title !== base.title;
  const behind = doc.version > base.version;
  const latest = useRef({ text, title, base, dirty, saving });
  // A save in flight, known at once (state is known on the next render).
  const inFlight = useRef(false);
  latest.current = { text, title, base, dirty, saving };

  // Others' saves: taken at once when nothing's unsaved here; otherwise said, below.
  useEffect(() => {
    const now = latest.current;
    if (doc.version === now.base.version || now.saving || inFlight.current) return;
    if (!now.dirty && !conflict) {
      setBase({ version: doc.version, text: doc.text, title: doc.title });
      setText(doc.text);
      setTitle(doc.title);
      if (doc.version > now.base.version && doc.savedBy !== `person:${viewer}`) {
        setFlash({ tone: "info", text: `${shown(doc.savedBy).name} saved version ${doc.version}` });
      }
    }
  }, [doc.version]);

  // What's unsaved is kept in this browser as it's written.
  useEffect(() => {
    if (!write) return;
    const timer = setTimeout(() => {
      if (dirty) {
        keepDraft(viewer, doc._id, {
          base: base.version,
          baseText: base.text,
          baseTitle: base.title,
          text,
          title,
          at: new Date().toISOString(),
        });
      } else dropDraft(viewer, doc._id);
    }, 250);
    return () => clearTimeout(timer);
  }, [text, title, base, write]);

  // Leaving with something unsaved: the browser asks (it's kept here anyway).
  useEffect(() => {
    if (!dirty) return;
    const ask = (event: BeforeUnloadEvent) => event.preventDefault();
    globalThis.addEventListener("beforeunload", ask);
    return () => globalThis.removeEventListener("beforeunload", ask);
  }, [dirty]);

  // A moment's note under the title, then it goes.
  useEffect(() => {
    if (!flash) return;
    const timer = setTimeout(() => setFlash(undefined), 4000);
    return () => clearTimeout(timer);
  }, [flash]);

  // ⌘S anywhere on the page saves.
  useEffect(() => {
    if (!write) return;
    const pressed = (event: KeyboardEvent) => {
      if (modded(event) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void save();
      }
    };
    globalThis.addEventListener("keydown", pressed);
    return () => globalThis.removeEventListener("keydown", pressed);
  });

  // A version restored from History: the drawer closes, and the page says so.
  useEffect(() => {
    const restored = (event: Event) => {
      const { document, from, version } = (event as CustomEvent).detail ?? {};
      if (document !== doc._id) return;
      setHistory(false);
      setFlash({ tone: "success", text: `Brought back version ${from}, as version ${version}` });
    };
    globalThis.addEventListener(RESTORED, restored);
    return () => globalThis.removeEventListener(RESTORED, restored);
  }, [doc._id]);

  // Just made (`?new=1`): its title, ready to type over.
  useEffect(() => {
    if (query.new !== "1") return;
    if (write) {
      titleField.current?.focus();
      titleField.current?.select();
    }
    // Once: the address forgets it, so coming back doesn't select the title again.
    const url = new URL(location.href);
    url.searchParams.delete("new");
    globalThis.history.replaceState(globalThis.history.state, "", url);
  }, []);
  useEffect(() => {
    if (query.history === "1") setHistory(true);
  }, [query.history]);

  usePresence(call, doc._id, page, dirty ? "editing" : "open", true);
  const now = useNow(15_000);
  const here = hereNow(presence, now, me, shown);
  const editingToo = here.filter((h) => h.editing);

  // Before saving: would it merge with what's been saved since, or clash?
  const ahead = useMemo(() => {
    if (!behind || !dirty || conflict) return undefined;
    const lines = merge(base.text, text, doc.text);
    const titles = mergeField(base.title, title, doc.title);
    return { clash: lines.conflicts > 0 || titles === undefined };
  }, [behind, dirty, conflict, base.text, base.title, text, title, doc.text, doc.title]);

  /** Saves what's written (or `what`, over the version `from`), and takes what it came to. */
  async function save(what?: Sides, from?: number) {
    const now = latest.current;
    if (inFlight.current || (!what && !now.dirty)) return;
    inFlight.current = true;
    const sent = what ?? { text: now.text, title: now.title };
    const sentBase = from ?? now.base.version;
    setSaving(true);
    setError(undefined);
    setConflictError(undefined);
    try {
      const done = await call<
        { version: number; merged?: boolean; unchanged?: true; text?: string; title?: string }
      >("document.save", {
        document: doc._id,
        base: sentBase,
        text: sent.text,
        title: sent.title,
      });
      const saved = { text: done.text ?? sent.text, title: done.title ?? sent.title };
      setBase({ version: done.version, ...saved });
      if (what) {
        // Settled on the conflict screen: what was saved is what's written now.
        setText(saved.text);
        setTitle(saved.title);
      } else {
        // Typed while it saved: kept, on top of what was saved.
        setText((cur) =>
          cur === sent.text ? saved.text : merge(sent.text, cur, saved.text).text ?? cur
        );
        setTitle((cur) => cur === sent.title ? saved.title : cur);
      }
      setConflict(undefined);
      setAside(undefined);
      setRestoredDraft(undefined);
      setFlash(
        done.unchanged ? { tone: "info", text: "Nothing new to save" } : done.merged
          ? {
            tone: "success",
            text: `Merged with ${shown(doc.savedBy).name}'s changes · version ${done.version}`,
          }
          : { tone: "success", text: `Saved version ${done.version}` },
      );
      if (!done.unchanged) dropDraft(viewer, doc._id);
    } catch (e) {
      const code = (e as { code?: unknown })?.code;
      if (code === "conflict") {
        setConflict({ base: now.base, mine: sent });
        setConflictError(what ? message(e) : undefined);
      } else if (what) setConflictError(message(e));
      else setError(message(e));
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
  }

  const theirs = {
    text: doc.text,
    title: doc.title,
    version: doc.version,
    at: doc.savedAt,
    by: shown(doc.savedBy),
  };
  const savedBy = shown(doc.savedBy);
  const savedFor = doc.savedFor ? shown(doc.savedFor) : undefined;

  const copyLink = () =>
    void navigator.clipboard?.writeText(`${location.origin}/document/${doc._id}`).then(() =>
      setFlash({ tone: "success", text: "Link copied" })
    );
  const download = () => {
    const url = URL.createObjectURL(new Blob([text], { type: "text/markdown" }));
    const a = Object.assign(document.createElement("a"), {
      href: url,
      download: `${(title || UNTITLED).replace(/[\\/:*?"<>|]+/g, " ").trim()}.md`,
    });
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const more: (MenuItem | "separator")[] = [
    { label: "History", icon: "retry", onSelect: () => setHistory(true) },
    { label: "Copy link", icon: "copy", onSelect: copyLink },
    { label: "Download Markdown", icon: "download", onSelect: download },
    ...(write && dirty
      ? [{
        label: "Discard unsaved changes",
        icon: "close" as const,
        onSelect: () => {
          setAside({ text, title });
          setBase({ version: doc.version, text: doc.text, title: doc.title });
          setText(doc.text);
          setTitle(doc.title);
          setRestoredDraft(undefined);
        },
      }]
      : []),
    ...(place
      ? [{ label: `${where}'s documents`, icon: "file" as const, href: documentsTab(place._id) }]
      : []),
    ...(write
      ? [
        "separator" as const,
        {
          label: "Delete…",
          icon: "trash" as const,
          tone: "destructive" as const,
          onSelect: () => setDeleting(true),
        },
      ]
      : []),
  ];

  const status = saving
    ? (
      <span className="doc-status" data-state="saving">
        <Spinner size={12} /> Saving…
      </span>
    )
    : error
    ? (
      <span className="doc-status" data-state="failed">
        <Icon name="alert" size={13} /> Couldn't save: {error}
        <Button variant="link" size="sm" onClick={() => void save()}>Try again</Button>
      </span>
    )
    : flash
    ? (
      <span className="doc-status" data-state={flash.tone}>
        <Icon name={flash.tone === "success" ? "check" : "info"} size={13} /> {flash.text}
      </span>
    )
    : dirty
    ? (
      <span className="doc-status" data-state="dirty">
        <span className="doc-dot" aria-hidden="true" /> Unsaved changes
        <span className="doc-status-quiet">
          · <Kbd>{MOD}</Kbd>
          <Kbd>S</Kbd> to save
        </span>
      </span>
    )
    : (
      <span className="doc-status">
        Version {doc.version} · {said(savedBy, me)}
        {savedFor ? ` for ${said(savedFor, me, false)}` : ""} · <Time at={doc.savedAt} />
      </span>
    );

  const titleInput = write
    ? (
      <span className="doc-title-grow" data-value={`${title || UNTITLED} `}>
        <textarea
          ref={titleField}
          className="doc-title-input"
          rows={1}
          value={title}
          placeholder={UNTITLED}
          aria-label="Title"
          maxLength={200}
          spellCheck
          onChange={(event) => setTitle(event.target.value.replace(/\n/g, " "))}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              field.current?.focus();
            }
          }}
        />
      </span>
    )
    : doc.title;

  return (
    <Page
      className="doc-page"
      width={shownMode === "split" ? "full" : "md"}
      title={titleInput}
      back={place ? { href: documentsTab(place._id), label: `${where} · Documents` } : undefined}
      badges={!write
        ? <Badge variant="outline">{place?.archived ? "Archived" : "View only"}</Badge>
        : null}
      description={
        <span className="doc-under" role="status" aria-live="polite">
          {status}
          {editingToo.length && dirty
            ? (
              <span className="doc-status" data-state="warning">
                <Icon name="pencil" size={12} /> {named(editingToo)}{" "}
                {editingToo.length === 1 ? "is" : "are"} editing too
              </span>
            )
            : null}
        </span>
      }
      actions={
        <>
          <Present here={here} />
          <Tooltip text="Every version, and what changed" describe={false}>
            <Button
              variant="ghost"
              className="doc-history-button"
              aria-label="History"
              onClick={() => setHistory(true)}
            >
              <Glyph name="history" />
              <span className="doc-wide">History</span>
            </Button>
          </Tooltip>
          {write
            ? (
              <Tooltip
                text={
                  <>
                    Save a version <Kbd>{MOD}</Kbd>
                    <Kbd>S</Kbd>
                  </>
                }
                describe={false}
              >
                <Button
                  variant={dirty && !conflict ? "primary" : "outline"}
                  className="doc-save"
                  loading={saving}
                  disabled={!dirty || !!conflict}
                  onClick={() => void save()}
                >
                  {dirty || saving ? "Save" : "Saved"}
                </Button>
              </Tooltip>
            )
            : null}
          <Menu label="This document: more" align="end" items={more} />
        </>
      }
    >
      <Title text={doc.title} />
      <div className="doc-body">
        {restoredDraft && dirty && !conflict
          ? (
            <Notice
              tone="info"
              icon="refresh"
              className="doc-banner"
              action={
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setRestoredDraft(undefined);
                    setBase({ version: doc.version, text: doc.text, title: doc.title });
                    setText(doc.text);
                    setTitle(doc.title);
                    dropDraft(viewer, doc._id);
                  }}
                >
                  Discard them
                </Button>
              }
            >
              Your unsaved changes from <Time at={restoredDraft} long /> are back, as you left them.
            </Notice>
          )
          : null}
        {aside
          ? (
            <Notice
              tone="neutral"
              icon="restore"
              className="doc-banner"
              action={
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setText(aside.text);
                    setTitle(aside.title);
                    setAside(undefined);
                  }}
                >
                  Bring mine back
                </Button>
              }
            >
              Your changes are put aside.
            </Notice>
          )
          : null}
        {ahead
          ? (
            <Notice
              tone={ahead.clash ? "warning" : "info"}
              icon={ahead.clash ? "alert" : "info"}
              className="doc-banner"
              action={
                <span className="doc-banner-actions">
                  <Button size="sm" variant="ghost" onClick={() => setTheirsOpen(true)}>
                    What they changed
                  </Button>
                  {ahead.clash
                    ? (
                      <Button
                        size="sm"
                        onClick={() => setConflict({ base, mine: { text, title } })}
                      >
                        Settle it now
                      </Button>
                    )
                    : null}
                </span>
              }
            >
              <b>{theirs.by.name}</b> saved version {doc.version} while you were writing.{" "}
              {ahead.clash
                ? "Some of the same lines changed: saving will ask you which to keep."
                : "None of the same lines: saving keeps both."}
            </Notice>
          )
          : null}
        {conflict
          ? (
            <Conflict
              base={conflict.base}
              mine={conflict.mine}
              theirs={theirs}
              busy={saving}
              error={conflictError}
              onKeep={() => void save(conflict.mine, doc.version)}
              onTake={() => {
                setAside(conflict.mine);
                setBase({ version: doc.version, text: doc.text, title: doc.title });
                setText(doc.text);
                setTitle(doc.title);
                setConflict(undefined);
                setFlash({ tone: "info", text: `Took ${theirs.by.name}'s version ${doc.version}` });
              }}
              onSave={(merged) => void save(merged, doc.version)}
              onEdit={(merged) => {
                setBase({ version: doc.version, text: doc.text, title: doc.title });
                setText(merged.text);
                setTitle(merged.title);
                setConflict(undefined);
                requestAnimationFrame(() => field.current?.focus());
              }}
            />
          )
          : (
            <>
              {write
                ? (
                  <div className="doc-bar">
                    <Toolbar
                      field={field}
                      mode={shownMode}
                      onMode={setMode}
                      split={wide}
                      editing={shownMode !== "preview"}
                    />
                  </div>
                )
                : null}
              <Editor
                value={text}
                onChange={setText}
                field={field}
                mode={shownMode}
                placeholder={"Start writing. Markdown works: # a heading, - a list, **bold**, " +
                  "[a link](https://…)"}
                label="The document, in Markdown"
              />
              <footer className="doc-foot">
                <span>{count(wordsIn(text), "word")}</span>
                <span>{kb(new TextEncoder().encode(text).length)}</span>
                <span>
                  Made by {said(shown(doc.createdBy), me, false)} <Time at={doc.createdAt} long />
                </span>
                {!write
                  ? (
                    <span>
                      {place?.archived
                        ? `${where} is archived: what's in it reads as it is.`
                        : `You can read this. Editors of ${where} can change it.`}
                    </span>
                  )
                  : null}
              </footer>
            </>
          )}
      </div>
      <Drawer
        open={showHistory}
        onClose={() => setHistory(false)}
        side="right"
        title={`History · ${doc.title}`}
        className="doc-history"
      >
        {showHistory
          ? <LazyView kind="document.history" item={{ _id: doc._id }} hints={{ write }} />
          : null}
      </Drawer>
      <Dialog
        open={theirsOpen}
        onClose={() => setTheirsOpen(false)}
        size="lg"
        title={`What ${theirs.by.name} changed`}
        description={`Since version ${base.version}, which you started from.`}
      >
        {theirsOpen ? <Diff before={base.text} after={doc.text} /> : null}
      </Dialog>
      {write
        ? (
          <DeleteDialog
            open={deleting}
            onClose={() => setDeleting(false)}
            doc={doc}
            where={where}
            call={call}
            deleted={() => {
              dropDraft(viewer, doc._id);
              go(place ? documentsTab(place._id) : "/");
            }}
          />
        )
        : null}
    </Page>
  );
}

/** Deleting a document, once they've read what it means. */
export function DeleteDialog(
  { open, onClose, doc, where, call, deleted }: {
    open: boolean;
    onClose(): void;
    doc: Pick<Document, "_id" | "title" | "version">;
    where: string;
    call: Call;
    deleted?(): void;
  },
): ReactNode {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="sm"
      title={`Delete “${doc.title}”?`}
      description={`It goes for everyone in ${where}, with its ${
        count(doc.version, "version")
      }. This can't be undone.`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>Keep it</Button>
          <Button
            variant="destructive"
            icon="trash"
            loading={busy}
            onClick={async () => {
              setBusy(true);
              setError(undefined);
              try {
                await call("document.delete", { document: doc._id });
                onClose();
                deleted?.();
              } catch (e) {
                setError(message(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            Delete document
          </Button>
        </>
      }
    >
      {error ? <Notice tone="destructive" role="alert">{error}</Notice> : null}
    </Dialog>
  );
}

/** A document that isn't there: gone, or somewhere the person isn't; with their draft, if any. */
function Missing({ id, me }: { id: string; me?: string }): ReactNode {
  const draft = me ? draftOf(me, id) : undefined;
  return (
    <div className="doc-missing">
      {style}
      <Title text="No such document" />
      <EmptyState
        icon="file"
        heading="h1"
        title="This document isn't here"
        action={<Button variant="primary" icon="home" href="/">Go home</Button>}
      >
        It may have been deleted, or it's in a space you're not in.
      </EmptyState>
      {draft
        ? (
          <Notice
            tone="warning"
            title="You had unsaved changes in it"
            action={
              <Button
                size="sm"
                icon="copy"
                onClick={() => void navigator.clipboard?.writeText(draft.text)}
              >
                Copy them
              </Button>
            }
          >
            “{draft.title}”, {count(wordsIn(draft.text), "word")}: copy them before you go.
          </Notice>
        )
        : null}
    </div>
  );
}
