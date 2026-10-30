/// <reference lib="dom" />
/**
 * Files in a space's folder: a folder at a time, with breadcrumbs back up;
 * folders first, then files, each with its size and when it changed, and a
 * filter for big folders. A file opens beside the list (over it, on a
 * phone): text to read and edit, an image to look at, anything to download.
 * A new file starts empty, in the folder shown, and is written when saved.
 */
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import {
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

/** A file open: where it is, and what the listing said of it (a new one has none yet). */
export type Opened = { path: string[]; entry?: Entry };

const join = (path: string[]) => path.join("/");

const sorted = (entries: Entry[]) =>
  [...entries].sort((a, b) =>
    Number(b.type === "directory") - Number(a.type === "directory") ||
    a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" })
  );

export function FilesTab(
  { work, folder, computer }: { work: Work; folder: string; computer: string },
): ReactNode {
  const [path, setPath] = useState<string[]>([]);
  const [entries, setEntries] = useState<Entry[]>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState("");
  const [opened, setOpened] = useState<Opened>();
  const [naming, setNaming] = useState(false);
  const [saving, setSaving] = useState<string>();
  const asked = useRef("");

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

  const words = filter.trim().toLowerCase();
  const shown = (entries ?? []).filter((e) => !words || e.name.toLowerCase().includes(words));
  const openPath = opened ? join(opened.path) : undefined;

  return (
    <div className="files" data-open={opened ? "" : undefined}>
      <div className="files-bar">
        <nav className="files-crumbs" aria-label="Where in the folder">
          <ol>
            <li>
              <button
                type="button"
                className="files-crumb"
                aria-current={path.length ? undefined : "location"}
                onClick={() => go([])}
                title={`${folder}, on ${computer}`}
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
                aria-label="Filter this folder"
                placeholder="Filter"
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
              />
            )
            : null}
          <IconButton
            icon="refresh"
            label="Refresh"
            size="sm"
            loading={loading && entries !== undefined}
            onClick={() => void load(path)}
          />
          <Button size="sm" icon="plus" onClick={() => setNaming(true)}>New file</Button>
        </div>
      </div>
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
      <div className="files-body">
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
              <ul className="files-list" aria-label={`In ${[folder, ...path].join("/")}`}>
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
                          Up to {path.length > 1 ? path.at(-2) : folder}
                        </span>
                      </button>
                    </li>
                  )
                  : null}
                {shown.map((entry) => {
                  const at = join([...path, entry.name]);
                  const dir = entry.type === "directory";
                  return (
                    <li
                      key={entry.name}
                      className="file-row"
                      data-current={at === openPath || undefined}
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
                        <span className="file-name">{entry.name}</span>
                        <span className="file-meta">
                          {dir ? null : <span className="file-size">{bytes(entry.size)}</span>}
                          <Time at={entry.mtime} />
                        </span>
                      </button>
                      {entry.type === "file"
                        ? (
                          <IconButton
                            icon="download"
                            label={`Download ${entry.name}`}
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
                      <EmptyState icon="folder" title="Nothing here yet">
                        What you and your agents make in this folder shows up here.
                      </EmptyState>
                    </li>
                  )
                  : !shown.length
                  ? <li className="files-none">Nothing here matches “{filter.trim()}”.</li>
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
      <label className="copilotz-sr" htmlFor={id}>The new file's name</label>
      <Input
        id={id}
        size="sm"
        icon="file"
        value={name}
        autoFocus
        autoComplete="off"
        autoCapitalize="none"
        spellCheck={false}
        placeholder="notes.md, or src/new.ts"
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
              label="Make the file"
              size="sm"
              disabled={!name.trim() || bad}
            />
            <IconButton icon="close" label="Cancel" size="sm" onClick={done} />
          </>
        }
      />
    </form>
  );
}
