/**
 * Files in a space's folder: a folder at a time, with breadcrumbs back up;
 * folders first, then files, each with its size and when it changed, and a
 * filter for big folders. A file opens beside the list (over it, on a
 * phone): text to read and edit, an image to look at, anything to download.
 * A new file starts empty, in the folder shown, and is written when saved.
 *
 * Files go up to the folder shown from Upload, or dropped on the tab (only
 * while files are dragged over it does it say where they'd go; a folder
 * dropped isn't uploaded, and it says so). Their progress shows over the
 * listing (upload-tray.tsx), which shows each once it's there, marked.
 * Where its owner answers for the computer, only they change what's on it:
 * the others open and download, and it says why.
 */
import { type DragEvent, type ReactNode, useEffect, useId, useRef, useState } from "react";
import {
  appBase,
  Badge,
  Button,
  bytes,
  EmptyState,
  Icon,
  IconButton,
  Input,
  message,
  Notice,
  Skeleton,
  Time,
} from "../../../../../hosts/web/mod.ts";
import type { Entry } from "../../shared/workloads.ts";
import { listOf } from "./calls.ts";
import { FileView } from "./file-view.tsx";
import type { Work } from "./names.ts";
import { imageType, readAll, save } from "./transfer.ts";
import { AskReplace, DropTarget, FoldersDropped, UploadGlyph, UploadTray } from "./upload-tray.tsx";
import { active, carriesFiles, droppedOf, type Upload, uploader } from "./uploads.ts";
import { say } from "./words.ts";

/** A file open: where it is, and what the listing said of it (a new one has none yet). */
export type Opened = { path: string[]; entry?: Entry };

const join = (path: string[]) => path.join("/");

const sorted = (entries: Entry[]) =>
  [...entries].sort((a, b) =>
    Number(b.type === "directory") - Number(a.type === "directory") ||
    a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" })
  );

export function FilesTab(
  { work, folder, computer, desk, writes = true, owner, sleeps }: {
    work: Work;
    /** The space's folder on it, by name. */
    folder: string;
    /** The computer's name. */
    computer: string;
    /** The desk (the computer, in the space): where uploads go. */
    desk: string;
    /** Whether the person changes files here (uploads, new files, edits): not where its owner answers for it. */
    writes?: boolean;
    /** Whose it is, by name, when it isn't the person's. */
    owner?: string;
    /** It sleeps when it isn't used (a cloud computer): an upload wakes it. */
    sleeps?: boolean;
  },
): ReactNode {
  const [path, setPath] = useState<string[]>([]);
  const [entries, setEntries] = useState<Entry[]>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState("");
  const [opened, setOpened] = useState<Opened>();
  const [naming, setNaming] = useState(false);
  const [saving, setSaving] = useState<string>();
  /** Files are dragged over the tab. */
  const [over, setOver] = useState(false);
  /** Folders dropped, which weren't uploaded. */
  const [folders, setFolders] = useState<string[]>();
  /** Files just uploaded, by path: marked in the listing until the uploads are hidden. */
  const [fresh, setFresh] = useState<ReadonlySet<string>>(() => new Set());
  const asked = useRef("");
  const depth = useRef(0);
  const picker = useRef<HTMLInputElement>(null);

  const load = async (at: string[]) => {
    const key = join(at);
    asked.current = key;
    setLoading(true);
    try {
      const got = listOf<Entry>(
        await work("files.list", at.length ? { path: key } : {}),
        "entries",
      );
      if (asked.current !== key) return;
      setEntries(sorted(got));
      setError(undefined);
    } catch (e) {
      if (asked.current === key) setError(message(e));
    } finally {
      if (asked.current === key) setLoading(false);
    }
  };
  useEffect(() => {
    setEntries(undefined);
    setFilter("");
    void load(path);
  }, [join(path), work]);

  // Uploads outlive the folder shown: each, once there, marks its file and refreshes its folder if shown.
  const latest = useRef({ path, load });
  latest.current = { path, load };
  const reloading = useRef<ReturnType<typeof setTimeout>>(undefined);
  const [uploads] = useState(() =>
    uploader({
      desk,
      base: appBase,
      finished: (u) => {
        setFresh((was) => new Set(was).add(join([...u.folder, u.name])));
        if (join(u.folder) !== join(latest.current.path) || reloading.current) return;
        // Several finishing together refresh it once.
        reloading.current = setTimeout(() => {
          reloading.current = undefined;
          void latest.current.load(latest.current.path);
        }, 250);
      },
    })
  );
  useEffect(() => () => clearTimeout(reloading.current), []);

  const put = (files: File[]) => {
    setFolders(undefined);
    // A batch after the last is over starts afresh: the files it marked aren't new anymore.
    if (files.length && !uploads.uploads().some(active)) setFresh(new Set());
    uploads.add(files, path, entries);
  };

  const go = (to: string[]) => {
    setPath(to);
    setOpened(undefined);
  };
  const download = async (entry: Entry, at: string[]) => {
    const where = join([...at, entry.name]);
    setSaving(where);
    try {
      save(await readAll(work, where), entry.name, imageType(entry.name));
    } catch (e) {
      setError(message(e));
    } finally {
      setSaving(undefined);
    }
  };

  /** A finished upload opens beside the list when the folder shown lists it. */
  const openUpload = (u: Upload) => {
    if (join(u.folder) !== join(path)) return undefined;
    const entry = entries?.find((e) => e.name === u.name && e.type === "file");
    return entry ? () => setOpened({ path: [...path, u.name], entry }) : undefined;
  };

  // Files dragged over the tab: where they'd go shows (where the person changes files), and a
  // drop goes up. Elsewhere, a drop is refused rather than opened by the browser in this tab.
  const dragging = (event: DragEvent) => carriesFiles(event.dataTransfer?.types);
  const drops = {
    onDragEnter: (event: DragEvent) => {
      if (!dragging(event)) return;
      event.preventDefault();
      if (!writes) return;
      depth.current++;
      setOver(true);
    },
    onDragOver: (event: DragEvent) => {
      if (!dragging(event)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = writes ? "copy" : "none";
    },
    onDragLeave: (event: DragEvent) => {
      if (!dragging(event) || !writes) return;
      depth.current = Math.max(0, depth.current - 1);
      if (!depth.current) setOver(false);
    },
    onDrop: (event: DragEvent) => {
      if (!dragging(event)) return;
      event.preventDefault();
      depth.current = 0;
      setOver(false);
      if (!writes) return;
      // Read now: what was dropped is gone once the event is over.
      const dropped = droppedOf(event.dataTransfer);
      put(dropped.files);
      if (dropped.folders.length) setFolders(dropped.folders);
    },
  };

  const words = filter.trim().toLowerCase();
  const shown = (entries ?? []).filter((e) => !words || e.name.toLowerCase().includes(words));
  const openPath = opened ? join(opened.path) : undefined;
  const here = [folder, ...path].join("/");

  return (
    <div
      className="files"
      data-open={opened ? "" : undefined}
      data-drop={writes ? "" : undefined}
      data-over={over ? "" : undefined}
      {...drops}
    >
      <div className="files-bar">
        <nav className="files-crumbs" aria-label={say("filesWhere")}>
          <ol>
            <li>
              <button
                type="button"
                className="files-crumb"
                aria-current={path.length ? undefined : "location"}
                onClick={() => go([])}
                title={say("filesOn", { folder, computer })}
              >
                <Icon name="folder" size={15} />
                {folder}
              </button>
            </li>
            {path.map((part, i) => (
              <li key={i}>
                <span className="files-crumb-sep" aria-hidden="true">/</span>
                <button
                  type="button"
                  className="files-crumb"
                  aria-current={i === path.length - 1 ? "location" : undefined}
                  onClick={() => go(path.slice(0, i + 1))}
                >
                  {part}
                </button>
              </li>
            ))}
          </ol>
        </nav>
        <div className="files-tools">
          {(entries?.length ?? 0) > 8
            ? (
              <Input
                size="sm"
                icon="search"
                type="search"
                className="files-filter"
                aria-label={say("filesFilterLabel")}
                placeholder={say("filesFilter")}
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
              />
            )
            : null}
          <IconButton
            icon="refresh"
            label={say("filesRefresh")}
            size="sm"
            loading={loading && entries !== undefined}
            onClick={() => void load(path)}
          />
          {writes
            ? (
              <>
                <Button size="sm" icon="plus" onClick={() => setNaming(true)}>
                  {say("newFile")}
                </Button>
                <Button
                  size="sm"
                  icon={<UploadGlyph size={14} />}
                  className="files-upload"
                  onClick={() => picker.current?.click()}
                >
                  {say("upload")}
                </Button>
                <input
                  ref={picker}
                  type="file"
                  multiple
                  hidden
                  onChange={(event) => {
                    put([...event.target.files ?? []]);
                    event.target.value = "";
                  }}
                />
              </>
            )
            : null}
        </div>
      </div>
      {writes ? null : (
        <p className="files-view-only">
          <Icon name="lock" size={13} />
          <span>{say("filesViewOnly", { owner: owner ?? say("filesItsOwner"), computer })}</span>
        </p>
      )}
      {naming
        ? (
          <NewFile
            done={() => setNaming(false)}
            create={(name) => {
              const parts = name.split("/").filter(Boolean);
              setOpened({ path: [...path, ...parts] });
              setNaming(false);
            }}
          />
        )
        : null}
      {error
        ? <Notice tone="destructive" role="alert" className="files-error">{error}</Notice>
        : null}
      {folders ? <FoldersDropped names={folders} close={() => setFolders(undefined)} /> : null}
      <UploadTray
        uploader={uploads}
        computer={computer}
        {...(sleeps ? { sleeps } : {})}
        folder={folder}
        path={path}
        open={openUpload}
        hide={() => setFresh(new Set())}
      />
      <AskReplace uploader={uploads} folder={folder} />
      <div className="files-body">
        {over ? <DropTarget folder={here} computer={computer} /> : null}
        <div className="files-list-box">
          {entries === undefined
            ? (
              error ? null : (
                <ul className="files-list" aria-busy="true">
                  {[0, 1, 2, 3].map((i) => <Skeleton key={i} as="li" height={38} />)}
                </ul>
              )
            )
            : (
              <ul className="files-list" aria-label={say("filesIn", { folder: here })}>
                {path.length
                  ? (
                    <li className="file-row">
                      <button
                        type="button"
                        className="file-open"
                        onClick={() => go(path.slice(0, -1))}
                      >
                        <span className="file-icon" data-type="up">
                          <Icon name="chevron-left" size={15} />
                        </span>
                        <span className="file-name">..</span>
                        <span className="file-meta">
                          {say("filesUpTo", { folder: path.length > 1 ? path.at(-2)! : folder })}
                        </span>
                      </button>
                    </li>
                  )
                  : null}
                {shown.map((entry) => {
                  const at = join([...path, entry.name]);
                  const dir = entry.type === "directory";
                  const isNew = !dir && fresh.has(at);
                  return (
                    <li
                      key={entry.name}
                      className="file-row"
                      data-current={at === openPath || undefined}
                      data-fresh={isNew || undefined}
                    >
                      <button
                        type="button"
                        className="file-open"
                        onClick={() =>
                          dir
                            ? go([...path, entry.name])
                            : setOpened({ path: [...path, entry.name], entry })}
                        aria-current={at === openPath ? "true" : undefined}
                      >
                        <span
                          className="file-icon"
                          data-type={dir ? "folder" : imageType(entry.name) ? "image" : "file"}
                        >
                          <Icon
                            name={dir ? "folder" : imageType(entry.name) ? "image" : "file"}
                            size={15}
                          />
                        </span>
                        <span className="file-name">
                          <span className="file-name-text">{entry.name}</span>
                          {isNew ? <Badge tone="success">{say("filesJustUploaded")}</Badge> : null}
                        </span>
                        <span className="file-meta">
                          {dir ? null : <span className="file-size">{bytes(entry.size)}</span>}
                          <Time at={entry.mtime} />
                        </span>
                      </button>
                      {entry.type === "file"
                        ? (
                          <IconButton
                            icon="download"
                            label={say("filesDownload", { name: entry.name })}
                            size="sm"
                            className="file-save"
                            loading={saving === at}
                            onClick={() => void download(entry, path)}
                          />
                        )
                        : null}
                    </li>
                  );
                })}
                {!entries.length
                  ? (
                    <li className="files-empty">
                      <EmptyState
                        icon="folder"
                        title={say("filesEmpty")}
                        action={writes
                          ? (
                            <Button
                              size="sm"
                              icon={<UploadGlyph size={14} />}
                              onClick={() => picker.current?.click()}
                            >
                              {say("upload")}
                            </Button>
                          )
                          : null}
                      >
                        {say(writes ? "filesEmptyDrop" : "filesEmptyText")}
                      </EmptyState>
                    </li>
                  )
                  : !shown.length
                  ? <li className="files-none">{say("filesNoMatch", { filter: filter.trim() })}</li>
                  : null}
              </ul>
            )}
        </div>
        {opened
          ? (
            <FileView
              key={openPath}
              work={work}
              path={opened.path}
              entry={opened.entry}
              writes={writes}
              close={() => setOpened(undefined)}
              saved={async (entry) => {
                setOpened({ path: opened.path, entry });
                await load(path);
              }}
              download={opened.entry
                ? () => download(opened.entry!, opened.path.slice(0, -1))
                : undefined}
              downloading={saving === openPath}
            />
          )
          : null}
      </div>
    </div>
  );
}

/** Naming a new file, in place: Enter opens it (empty, to write), Escape doesn't. */
function NewFile({ create, done }: { create(name: string): void; done(): void }): ReactNode {
  const [name, setName] = useState("");
  const id = useId();
  const bad = /(^|\/)\.\.?(\/|$)|^\//.test(name.trim());
  return (
    <form
      className="files-new"
      onSubmit={(event) => {
        event.preventDefault();
        if (name.trim() && !bad) create(name.trim());
      }}
    >
      <label className="copilotz-sr" htmlFor={id}>{say("newFileName")}</label>
      <Input
        id={id}
        size="sm"
        icon="file"
        value={name}
        autoFocus
        autoComplete="off"
        autoCapitalize="none"
        spellCheck={false}
        placeholder={say("newFilePlaceholder")}
        invalid={bad}
        onChange={(event) => setName(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== "Escape") return;
          event.preventDefault();
          done();
        }}
        end={
          <>
            <IconButton
              type="submit"
              icon="check"
              label={say("newFileMake")}
              size="sm"
              disabled={!name.trim() || bad}
            />
            <IconButton icon="close" label={say("cancel")} size="sm" onClick={done} />
          </>
        }
      />
    </form>
  );
}
