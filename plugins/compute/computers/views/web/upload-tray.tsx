/**
 * Uploading, as a Files tab shows it: what's going up (each file's bytes
 * and share, or that the computer is waking, or finishing; cancel one, or
 * all), what came of each (uploaded, opened with a click; why one didn't
 * go, in plain words, and trying it again), and the batch's progress over
 * them; the question when a name is taken (replace, keep both, skip, for
 * the rest too); where files dragged over the tab go, and that folders
 * dropped there aren't uploaded. Leaving the page while files are going up
 * asks first.
 */
import { type ReactNode, useEffect, useState, useSyncExternalStore } from "react";
import {
  Button,
  bytes,
  Checkbox,
  Dialog,
  formatNumber,
  Icon,
  IconButton,
  Notice,
  Spinner,
  Time,
} from "../../../../../hosts/web/mod.ts";
import {
  active,
  type Choice,
  countOf,
  MOST,
  phaseOf,
  type Upload,
  type Uploader,
} from "./uploads.ts";
import { say } from "./words.ts";

/** The toolkit has no glyph for going up: an arrow up out of a tray, as `download`'s goes in. */
export function UploadGlyph({ size = 16 }: { size?: number }): ReactNode {
  return (
    <svg
      className="files-glyph"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 16V4.5M7 9.5l5-5 5 5M5 20h14" />
    </svg>
  );
}

/** The uploads as they are now, drawn again as they change. */
export const useUploads = (uploader: Uploader): Upload[] =>
  useSyncExternalStore(uploader.subscribe, uploader.uploads, uploader.uploads);

/** Drawn again every half second while `on`: a stalled upload's words follow the clock. */
function useTicking(on: boolean): void {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!on) return;
    const timer = setInterval(() => setTick((n) => n + 1), 500);
    return () => clearInterval(timer);
  }, [on]);
}

/** Leaving the page (closing it, reloading) while files go up asks first: they'd stop. */
function useLeaving(uploader: Uploader): void {
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (!uploader.uploads().some((u) => u.state === "sending" || u.state === "queued")) return;
      event.preventDefault();
      event.returnValue = "";
    };
    globalThis.addEventListener?.("beforeunload", warn);
    return () => globalThis.removeEventListener?.("beforeunload", warn);
  }, [uploader]);
}

/** Where it's going, as people say it: the space's folder, then the path in it. */
const shown = (folder: string, path: string[]) => [folder, ...path].join("/");

/** A size as short as it goes: "2 GB", not "2.0 GB". */
const short = (n: number) => bytes(n).replace(/\.0 /, " ");

/** How far, as a share people read: "74%", never 100% before it's there. */
const share = (loaded: number, total: number) => total ? Math.floor((loaded / total) * 100) : 0;
const percent = (n: number) => formatNumber(n / 100, { style: "percent" });

/**
 * Why an upload didn't go, said plainly, and whether trying again may work.
 * The route's own words where they say more than a code (who may change what,
 * why a computer couldn't wake); these words otherwise.
 */
export function failureOf(
  u: Upload,
  { computer, sleeps }: { computer: string; sleeps?: boolean },
): { text: string; retry: boolean } {
  const refused = u.refused;
  const theirs = refused?.message;
  switch (refused?.code) {
    case "too_large":
      return {
        text: say("uploadTooLarge", { size: short(u.total), most: short(MOST) }),
        retry: false,
      };
    case "too_large_here":
      return { text: say("uploadTooLargeHere", { size: short(u.total) }), retry: false };
    case "unauthorized":
      return { text: say("uploadSignedOut"), retry: true };
    case "forbidden":
    case "denied":
      return { text: theirs ?? say("uploadForbidden"), retry: false };
    case "not_found":
      return { text: say("uploadNotFound"), retry: false };
    case "exists":
      return { text: say("uploadFolderThere"), retry: false };
    case "invalid":
    case "invalid_path":
      return { text: say("uploadInvalid"), retry: false };
    case "restart":
      return { text: say("uploadRestart"), retry: true };
    case "length_required":
      return { text: say("uploadNoLength"), retry: true };
    case "outdated":
      return { text: say("uploadOutdated", { computer }), retry: true };
    case "offline":
      return { text: say(sleeps ? "uploadNoWake" : "uploadOffline", { computer }), retry: true };
    case "unavailable":
      return { text: theirs ?? say("uploadUnavailable", { computer }), retry: true };
    case "full":
      return { text: say("uploadFull", { computer }), retry: true };
    case "network":
      return { text: say("uploadNetwork"), retry: true };
    default:
      return { text: theirs ?? say("uploadFailed"), retry: true };
  }
}

/** What a row says under its name. */
function metaOf(
  u: Upload,
  now: number,
  at: { computer: string; sleeps?: boolean },
): { text: string; tone?: "bad" | "good" } {
  switch (u.state) {
    case "queued":
      return { text: `${say("uploadQueued")} · ${short(u.total)}` };
    case "sending": {
      const phase = phaseOf(u, now);
      if (phase === "waking") {
        return {
          text: say(at.sleeps ? "uploadWaking" : "uploadWaiting", { computer: at.computer }),
        };
      }
      if (phase === "finishing") return { text: say("uploadFinishing", { computer: at.computer }) };
      return {
        text: `${say("uploadProgress", { done: short(u.loaded), total: short(u.total) })} · ${
          percent(share(u.loaded, u.total))
        }`,
      };
    }
    case "done": {
      const said = u.name !== u.file.name
        ? say("uploadDoneAs", { name: u.name })
        : u.replace
        ? say("uploadReplaced")
        : say("uploadDone");
      return { text: `${said} · ${short(u.size ?? u.total)}`, tone: "good" };
    }
    case "asking":
      return { text: say("uploadAsking") };
    case "failed":
      return { text: failureOf(u, at).text, tone: "bad" };
    case "cancelled":
      return { text: say("uploadCancelled") };
    case "skipped":
      return { text: say("uploadSkipped") };
  }
}

/**
 * The uploads of a Files tab, over its listing: a line for the batch (how
 * many are going up and what's left, or what came of them), its progress,
 * and a row per file. Nothing, with none.
 */
export function UploadTray(
  { uploader, computer, sleeps, folder, path, open, hide, clock = Date.now }: {
    uploader: Uploader;
    /** The computer's name, and whether it sleeps (a cloud computer: an upload wakes it). */
    computer: string;
    sleeps?: boolean;
    /** The space's folder's name, and the folder shown in it. */
    folder: string;
    path: string[];
    /** How to open one that's there, when the folder shown lists it. */
    open?(u: Upload): (() => void) | undefined;
    /** Its rows were cleared. */
    hide?(): void;
    clock?: () => number;
  },
): ReactNode {
  const uploads = useUploads(uploader);
  const count = countOf(uploads);
  const going = count.going > 0;
  useTicking(going);
  useLeaving(uploader);
  if (!uploads.length) return null;
  const now = clock();
  const at = { computer, ...(sleeps ? { sleeps } : {}) };
  const here = path.join("/");
  const said = [
    going
      ? say("uploading", { count: count.going })
      : count.done
      ? say("uploadsDone", { count: count.done })
      : "",
    count.failed ? say("uploadsFailed", { count: count.failed }) : "",
    count.asking ? say("uploadsAsking", { count: count.asking }) : "",
  ].filter(Boolean);
  const total = share(count.loaded, count.total);
  const left = uploads.filter(active).length;
  return (
    <section
      className="uploads"
      aria-label={say("uploads")}
      data-going={going || undefined}
      data-failed={count.failed || undefined}
    >
      <header className="uploads-head">
        <span className="uploads-mark" aria-hidden="true">
          {going
            ? <Spinner size={14} />
            : count.failed
            ? <Icon name="alert" size={15} />
            : count.asking
            ? <UploadGlyph size={15} />
            : <Icon name="check-circle" size={15} />}
        </span>
        <p className="uploads-title" role="status">
          {said.length ? said.join(" · ") : say("uploads")}
        </p>
        {going
          ? (
            <span className="uploads-left">
              {say("uploadsLeft", { size: short(Math.max(0, count.total - count.loaded)) })}
              {" · "}
              {percent(total)}
            </span>
          )
          : null}
        <span className="uploads-actions">
          {left > 1
            ? (
              <Button size="xs" variant="ghost" onClick={() => uploader.cancelAll()}>
                {say("uploadsCancelAll")}
              </Button>
            )
            : null}
          {!going
            ? (
              <IconButton
                icon="close"
                label={say("uploadsHide")}
                size="sm"
                onClick={() => {
                  uploader.clear();
                  hide?.();
                }}
              />
            )
            : null}
        </span>
      </header>
      {going
        ? (
          <span
            className="uploads-bar"
            role="progressbar"
            aria-label={say("uploads")}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={total}
          >
            <span style={{ width: `${total}%` }} />
          </span>
        )
        : null}
      <ul className="uploads-list">
        {uploads.map((u) => {
          const meta = metaOf(u, now, at);
          const phase = u.state === "sending" ? phaseOf(u, now) : undefined;
          const opening = u.state === "done" ? open?.(u) : undefined;
          const elsewhere = u.folder.join("/") !== here;
          const failure = u.state === "failed" ? failureOf(u, at) : undefined;
          const again = u.state === "cancelled" || u.state === "skipped" || !!failure?.retry;
          const name = u.file.name;
          return (
            <li key={u.id} className="upload" data-state={u.state} data-phase={phase}>
              <span className="upload-icon" aria-hidden="true">
                <Icon
                  name={u.state === "done"
                    ? "check-circle"
                    : u.state === "failed" || u.state === "asking"
                    ? "alert"
                    : u.state === "cancelled" || u.state === "skipped"
                    ? "ban"
                    : "file"}
                  size={15}
                />
              </span>
              <span className="upload-text">
                {opening
                  ? (
                    <button
                      type="button"
                      className="upload-name upload-open"
                      onClick={opening}
                      title={say("uploadOpen", { name: u.name })}
                    >
                      {name}
                    </button>
                  )
                  : <span className="upload-name" title={name}>{name}</span>}
                <span className="upload-meta" data-tone={meta.tone}>
                  {meta.text}
                  {elsewhere
                    ? <span>{" · "}{say("uploadIn", { folder: shown(folder, u.folder) })}</span>
                    : null}
                </span>
              </span>
              <span className="upload-end">
                {active(u)
                  ? (
                    <IconButton
                      icon="close"
                      label={say("uploadCancel", { name })}
                      size="sm"
                      onClick={() => uploader.cancel(u.id)}
                    />
                  )
                  : again
                  ? (
                    <Button
                      size="xs"
                      variant="ghost"
                      icon="retry"
                      onClick={() => uploader.retry(u.id)}
                    >
                      {say("tryAgain")}
                    </Button>
                  )
                  : null}
              </span>
              {u.state === "sending"
                ? (
                  <span
                    className="upload-bar"
                    role="progressbar"
                    aria-label={say("uploadProgressLabel", { name })}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={share(u.loaded, u.total)}
                    data-waiting={phase === "waking" || undefined}
                  >
                    <span style={{ width: `${share(u.loaded, u.total)}%` }} />
                  </span>
                )
                : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/**
 * The question when a name is taken, one file at a time (the first that
 * waits): a file there is replaced, or kept with yours beside it under a
 * free name, or yours is skipped; a folder there is never replaced. What's
 * chosen can go for the rest of the batch that waits. Closing it skips that
 * one (it can be tried again from its row).
 */
export function AskReplace(
  { uploader, folder }: { uploader: Uploader; folder: string },
): ReactNode {
  const uploads = useUploads(uploader);
  const asking = uploads.filter((u) => u.state === "asking");
  const u = asking[0];
  if (!u) return null;
  const others = asking.filter((o) => o !== u && o.batch === u.batch).length;
  return (
    <Question
      key={u.id}
      upload={u}
      others={others}
      folder={shown(folder, u.folder)}
      keepAs={uploader.keepAs(u.id)}
      answer={(choice, all) => uploader.answer(u.id, choice, all)}
    />
  );
}

function Question(
  { upload: u, others, folder, keepAs, answer }: {
    upload: Upload;
    others: number;
    folder: string;
    keepAs: string;
    answer(choice: Choice, all: boolean): void;
  },
): ReactNode {
  const [all, setAll] = useState(false);
  const name = u.file.name;
  const folderThere = u.there?.type === "directory";
  const there = u.there;
  return (
    <Dialog
      open
      size="sm"
      onClose={() => answer("skip", false)}
      title={folderThere ? say("replaceFolderTitle", { name }) : say("replaceTitle", { name })}
      footer={
        <>
          <Button variant="ghost" onClick={() => answer("skip", all)}>{say("skip")}</Button>
          <Button variant={folderThere ? "primary" : "outline"} onClick={() => answer("keep", all)}>
            {say("keepBoth")}
          </Button>
          {folderThere
            ? null
            : (
              <Button variant="destructive" onClick={() => answer("replace", all)}>
                {say("replace")}
              </Button>
            )}
        </>
      }
    >
      <div className="upload-ask">
        <p>{folderThere ? say("replaceFolderText") : say("replaceText", { folder, name })}</p>
        {!folderThere && there?.mtime
          ? (
            <ul className="upload-ask-sides">
              <li>
                <Icon name="file" size={14} />
                <span>
                  {say.nodes("replaceThere", {
                    size: short(there.size ?? 0),
                    time: <Time at={there.mtime} long />,
                  })}
                </span>
              </li>
              <li>
                <UploadGlyph size={14} />
                <span>
                  {say.nodes("replaceYours", {
                    size: short(u.total),
                    time: <Time at={new Date(u.file.lastModified).toISOString()} long />,
                  })}
                </span>
              </li>
            </ul>
          )
          : null}
        <p className="upload-ask-keep">{say("replaceKeepAs", { name: keepAs })}</p>
        {others
          ? (
            <Checkbox
              checked={all}
              onChange={(event) => setAll(event.target.checked)}
              label={say("replaceAll", { count: others })}
            />
          )
          : null}
      </div>
    </Dialog>
  );
}

/** Where files dragged over the tab go: the folder shown. Only while files are dragged. */
export function DropTarget({ folder, computer }: { folder: string; computer: string }): ReactNode {
  return (
    <div className="files-drop" aria-hidden="true">
      <span className="files-drop-mark">
        <UploadGlyph size={22} />
      </span>
      <strong>{say("dropTitle")}</strong>
      <span className="files-drop-to">{say("dropTo", { folder, computer })}</span>
    </div>
  );
}

/** Folders dropped on the tab, which aren't uploaded: said plainly, with what to do instead. */
export function FoldersDropped({ names, close }: { names: string[]; close(): void }): ReactNode {
  return (
    <Notice
      tone="warning"
      role="alert"
      className="files-error"
      action={<IconButton icon="close" label={say("close")} size="sm" onClick={close} />}
    >
      {names.length === 1
        ? say("folderDropped", { name: names[0] })
        : say("foldersDropped", { count: names.length })}
    </Notice>
  );
}
