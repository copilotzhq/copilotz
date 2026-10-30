/// <reference lib="dom" />
/**
 * A file, open: its name, size and when it changed; text with its lines
 * numbered, an image to look at (an SVG too, its text a tap away), or, for
 * anything else, a way to download it. Text edits in place and saves with
 * the button or ⌘S / Ctrl+S (`files.write`); if the file changed on the
 * computer since it opened (an agent wrote it), saving says so first and
 * offers to load what's there. A file too big to read whole shows its start,
 * and isn't edited (saving would cut it short). A new file opens to write.
 */
import { type ReactNode, useEffect, useState } from "react";
import {
  Badge,
  Button,
  bytes,
  CodeBlock,
  EmptyState,
  Icon,
  IconButton,
  message,
  Notice,
  Spinner,
  Textarea,
  Time,
} from "../../../../../hosts/web/mod.ts";
import type { Entry, FilesRead, Written } from "../../shared/workloads.ts";
import { listOf } from "./calls.ts";
import type { Work } from "./names.ts";
import { imageType, MOST } from "./transfer.ts";

type Shown =
  | { kind: "loading" }
  | { kind: "failed"; error: string }
  | { kind: "text"; content: string; truncated: boolean; size: number; image?: string }
  | { kind: "image"; src: string; size: number }
  | { kind: "binary"; size: number };

const svg = (text: string) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(text)}`;

export function FileView(
  { work, path, entry, close, saved, download, downloading }: {
    work: Work;
    path: string[];
    /** What the folder's listing said of it; a new file has none. */
    entry?: Entry;
    close(): void;
    /** It's written: what the listing says of it now. */
    saved(entry: Entry): Promise<void>;
    download?(): void;
    downloading?: boolean;
  },
): ReactNode {
  const name = path[path.length - 1];
  const where = path.join("/");
  const type = imageType(name);
  const [shown, setShown] = useState<Shown>(
    entry ? { kind: "loading" } : { kind: "text", content: "", truncated: false, size: 0 },
  );
  const [draft, setDraft] = useState<string | undefined>(entry ? undefined : "");
  const [source, setSource] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [changed, setChanged] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    if (!entry) return;
    let gone = false;
    setShown({ kind: "loading" });
    work<FilesRead>("files.read", {
      path: where,
      ...(type && type !== "image/svg+xml"
        ? { length: Math.min(Math.max(entry.size, 1), MOST) }
        : {}),
    }).then(
      (read) => {
        if (gone) return;
        if (read.encoding === "base64") {
          setShown(
            type
              ? { kind: "image", src: `data:${type};base64,${read.content}`, size: read.size }
              : { kind: "binary", size: read.size },
          );
        } else {
          setShown({
            kind: "text",
            content: read.content,
            truncated: read.truncated,
            size: read.size,
            ...(type === "image/svg+xml" ? { image: svg(read.content) } : {}),
          });
        }
      },
      (e) => !gone && setShown({ kind: "failed", error: message(e) }),
    );
    return () => void (gone = true);
  }, [where, reload]);

  const editing = draft !== undefined;
  const dirty = editing && shown.kind === "text" && draft !== shown.content;

  /** Writes the draft, unless the file changed on the computer since it opened (`anyway`: even so). */
  const write = async (anyway = false) => {
    if (draft === undefined) return;
    setBusy(true);
    setError(undefined);
    try {
      const folder = path.slice(0, -1).join("/");
      const listed = async () =>
        listOf<Entry>(await work("files.list", folder ? { path: folder } : {}), "entries")
          .find((e) => e.name === name);
      if (!anyway) {
        const now = await listed().catch(() => undefined);
        if (entry ? now?.mtime !== entry.mtime : now !== undefined) {
          setChanged(true);
          return;
        }
      }
      await work<Written>("files.write", { path: where, content: draft });
      const now = await listed();
      setChanged(false);
      setShown({ kind: "text", content: draft, truncated: false, size: now?.size ?? draft.length });
      setDraft(undefined);
      if (now) await saved(now);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };

  const leave = () => dirty ? setLeaving(true) : close();
  const size = shown.kind === "loading" || shown.kind === "failed" ? entry?.size : shown.size;

  return (
    <section className="file-view" aria-label={name}>
      <header className="file-view-head">
        <IconButton
          icon="chevron-left"
          label="Back to the folder"
          size="sm"
          className="file-view-back"
          onClick={leave}
        />
        <div className="file-view-title">
          <h3 title={where}>{name}</h3>
          <p>
            {entry ? null : <Badge tone="primary">new</Badge>}
            {size !== undefined && entry ? <span>{bytes(size)}</span> : null}
            {entry
              ? (
                <>
                  changed <Time at={entry.mtime} long />
                </>
              )
              : <span>Not written yet</span>}
            {dirty ? <Badge tone="warning">unsaved</Badge> : null}
          </p>
        </div>
        <div className="file-view-actions">
          {editing
            ? (
              <>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => entry ? setDraft(undefined) : close()}
                  disabled={busy}
                >
                  Cancel
                </Button>
                <Button
                  size="sm"
                  variant="primary"
                  icon="check"
                  loading={busy}
                  onClick={() => void write()}
                >
                  Save
                </Button>
              </>
            )
            : (
              <>
                {shown.kind === "text" && !shown.truncated
                  ? (
                    <Button size="sm" icon="pencil" onClick={() => setDraft(shown.content)}>
                      Edit
                    </Button>
                  )
                  : null}
                {download
                  ? (
                    <IconButton
                      icon="download"
                      label={`Download ${name}`}
                      size="sm"
                      variant="outline"
                      loading={downloading}
                      onClick={download}
                    />
                  )
                  : null}
                <IconButton
                  icon="close"
                  label="Close"
                  size="sm"
                  className="file-view-close"
                  onClick={leave}
                />
              </>
            )}
        </div>
      </header>
      {leaving
        ? (
          <Notice
            tone="warning"
            className="file-view-notice"
            action={
              <>
                <Button size="sm" variant="ghost" onClick={() => setLeaving(false)}>
                  Keep editing
                </Button>
                <Button size="sm" variant="destructive" onClick={close}>Discard</Button>
              </>
            }
          >
            Your changes to {name} aren't saved.
          </Notice>
        )
        : null}
      {changed
        ? (
          <Notice
            tone="warning"
            className="file-view-notice"
            title={entry
              ? "It changed on the computer since you opened it"
              : "There's a file by that name"}
            action={
              <>
                {entry
                  ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setChanged(false);
                        setDraft(undefined);
                        setReload((n) => n + 1);
                      }}
                    >
                      Load it
                    </Button>
                  )
                  : null}
                <Button
                  size="sm"
                  variant="destructive"
                  loading={busy}
                  onClick={() => void write(true)}
                >
                  Save anyway
                </Button>
              </>
            }
          >
            Saving replaces what's there with yours.
          </Notice>
        )
        : null}
      {error
        ? <Notice tone="destructive" role="alert" className="file-view-notice">{error}</Notice>
        : null}
      <div className="file-view-body">
        {editing
          ? (
            <Textarea
              className="file-edit"
              aria-label={`${name}, editing`}
              value={draft}
              autoFocus
              spellCheck={false}
              autoCapitalize="none"
              autoComplete="off"
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
                  event.preventDefault();
                  void write();
                }
              }}
            />
          )
          : shown.kind === "loading"
          ? (
            <p className="file-view-wait" role="status">
              <Spinner size={15} /> Opening {name}…
            </p>
          )
          : shown.kind === "failed"
          ? (
            <Notice tone="destructive" role="alert" title={`Couldn't open ${name}`}>
              {shown.error}
            </Notice>
          )
          : shown.kind === "image"
          ? (
            <figure className="file-picture">
              <img src={shown.src} alt={name} />
            </figure>
          )
          : shown.kind === "binary"
          ? (
            <EmptyState
              icon="file"
              title="This file isn't text"
              action={download
                ? (
                  <Button icon="download" loading={downloading} onClick={download}>
                    Download it
                  </Button>
                )
                : null}
            >
              It's {bytes(shown.size)} of something else: download it to open it on your device.
            </EmptyState>
          )
          : (
            <>
              {shown.truncated
                ? (
                  <Notice tone="info" className="file-view-notice">
                    It's {bytes(shown.size)}: this is its start. Download it to see it all.
                  </Notice>
                )
                : null}
              {shown.image && !source
                ? (
                  <figure className="file-picture">
                    <img src={shown.image} alt={name} />
                    <figcaption>
                      <Button size="sm" variant="link" icon="file" onClick={() => setSource(true)}>
                        Its text
                      </Button>
                    </figcaption>
                  </figure>
                )
                : (
                  <CodeBlock
                    title={<Lines text={shown.content} />}
                    code={shown.content}
                    numbers
                    copy
                    lines={400}
                    empty="It's empty."
                    label={`${name}'s text`}
                    className="file-text"
                  />
                )}
            </>
          )}
      </div>
      {editing
        ? (
          <p className="file-view-hint">
            <Icon name="info" size={13} /> ⌘S or Ctrl+S saves.
          </p>
        )
        : null}
    </section>
  );
}

/** How many lines text has, as a file's header says it. */
function Lines({ text }: { text: string }): ReactNode {
  const n = text ? text.replace(/\n$/, "").split("\n").length : 0;
  return <span className="file-lines">{n} line{n === 1 ? "" : "s"}</span>;
}
