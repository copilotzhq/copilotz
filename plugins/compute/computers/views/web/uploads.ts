/**
 * Files onto a computer, from the browser, in plain functions: each file in
 * parts of up to 8 MiB (what proxies in front of an app let through: Cloud
 * Run takes 32 MiB a request, Cloudflare 100 MB), each part a `PUT` of its
 * bytes to the upload route (routes/upload.ts), under the app's base, in
 * order, one at a time, all of one attempt under one id; with
 * XMLHttpRequest (fetch says nothing of a body's progress). A part that
 * isn't the last answers what's been received; the last, where the file is:
 * only then is it there. And the uploads of a Files tab, a few files at a
 * time, as one list that changes.
 *
 * A file whose name is taken in its folder (the listing says so, or the
 * computer answers `exists`) waits for the person: replaced (`replace=1`),
 * kept beside the one there under a free name ("report 2.pdf"), or skipped;
 * a choice can go for the rest of its batch. One too large for the route
 * fails before a byte is sent. A part refused fails its file, saying why;
 * one the computer lost track of means starting again. Tried again (or sent
 * again to replace), a file starts over, under a new id; cancelled, the part
 * on its way stops and no more go (the computer drops what it kept, later).
 * What comes of each (done, failed and why, cancelled) stays in the list
 * until it's cleared, or another batch starts once it's over (what failed
 * stays then too).
 *
 * While a file goes up, its bytes show it's moving: the parts done and the
 * one on its way. A computer that sleeps (a cloud computer) is woken by the
 * upload, and takes no bytes until it's up: what was sent stops a moment
 * after it starts, so that's "waking" (or waiting for the computer) until
 * bytes move again; all sent and no answer yet, it's finishing there.
 */
import type { Entry } from "../../shared/workloads.ts";
import { MOST_PUT } from "../../shared/workloads.ts";

/** Where files go up (routes/upload.ts), under the app's base. */
export const UPLOAD_PATH = "/computers/upload";

/** The most a file put on a computer may be (2 GiB). */
export const MOST = MOST_PUT;

/** How many files go at once (each a part at a time). */
const AT_ONCE = 3;
/** The most a part holds: 8 MiB. */
export const PART = 8 * 1024 * 1024;
/** Bytes moving past this long after the start: the computer is taking them. */
const FLOWING_MS = 1000;
/** Nothing moving this long: it's waiting on the computer. */
const STALLED_MS = 1500;
/** How often progress is told, at most, to those listening. */
const TELL_MS = 100;

/**
 * The route's address for a part of a file: the desk, the path in the
 * space's folder, the attempt's id, where the part starts, the whole file's
 * size, and whether it replaces the file there.
 */
export function uploadUrl(
  base: string,
  desk: string,
  path: string,
  part: { upload: string; offset: number; total: number; replace?: boolean },
): string {
  const query = new URLSearchParams({
    desk,
    path,
    upload: part.upload,
    offset: String(part.offset),
    total: String(part.total),
  });
  if (part.replace) query.set("replace", "1");
  return `${base}${UPLOAD_PATH}?${query}`;
}

/** An attempt's id: a UUID (made by hand where the page isn't a secure context, which has none). */
export function uploadId(): string {
  const made = globalThis.crypto?.randomUUID?.();
  if (made) return made;
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const hex = [...b].map((n) => n.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${
    hex.slice(20)
  }`;
}

/**
 * What the route answered a part: received so far (a part before the last),
 * where the file is and its size (the last), or its refusal (`status` 0: no
 * answer).
 */
export type Answer =
  | { ok: true; path: string; size: number }
  | { ok: true; received: number }
  | Refusal;

export type Refusal = { ok: false; status: number; code?: string; message?: string };

/** The codes a status means, when a refusal doesn't say (a proxy's page, not the route's JSON). */
const CODES: Record<number, string> = {
  401: "unauthorized",
  403: "forbidden",
  404: "not_found",
  409: "exists",
  411: "length_required",
  413: "too_large_here",
  501: "outdated",
  503: "unavailable",
  507: "full",
};

/** A response, read: the route's JSON, or a status alone. */
export function answerOf(status: number, text: string): Answer {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch { /* Not the route's: a proxy's page, or nothing. */ }
  const said = body as
    | {
      path?: unknown;
      size?: unknown;
      received?: unknown;
      error?: { message?: unknown; code?: unknown };
    }
    | undefined;
  if (status >= 200 && status < 300 && typeof said?.path === "string") {
    return { ok: true, path: said.path, size: Number(said.size) || 0 };
  }
  if (status >= 200 && status < 300 && typeof said?.received === "number") {
    return { ok: true, received: said.received };
  }
  const error = said?.error;
  const code = typeof error?.code === "string" ? error.code : CODES[status];
  return {
    ok: false,
    status,
    ...(code ? { code } : {}),
    ...(typeof error?.message === "string" && error.message ? { message: error.message } : {}),
  };
}

/** A request on its way: told how far its bytes went; `abort` stops it. */
export type Sending = { abort(): void; answer: Promise<Answer> };

/** Sends bytes (a part of a file) to an address, saying how far they went. */
export type Send = (
  to: { url: string; file: Blob; progress(loaded: number, total: number): void },
) => Sending;

/** With XMLHttpRequest: the part is the body, and the browser says its length. */
export const xhrSend: Send = ({ url, file, progress }) => {
  const xhr = new XMLHttpRequest();
  const answer = new Promise<Answer>((resolve) => {
    xhr.upload.onprogress = (event) =>
      progress(event.loaded, event.lengthComputable ? event.total : file.size);
    xhr.onload = () => resolve(answerOf(xhr.status, xhr.responseText));
    xhr.onerror = () => resolve({ ok: false, status: 0, code: "network" });
    xhr.ontimeout = () => resolve({ ok: false, status: 0, code: "network" });
    xhr.onabort = () => resolve({ ok: false, status: 0, code: "cancelled" });
  });
  xhr.open("PUT", url);
  xhr.send(file);
  return { abort: () => xhr.abort(), answer };
};

/** What a name is taken by, in its folder: a file (replaced, if the person says) or a folder (never). */
export type There = { type: "file" | "directory"; size?: number; mtime?: string };

/** One file going up, and how far it is. */
export type Upload = {
  id: string;
  /** The files added together: a choice for one can go for the rest. */
  batch: number;
  file: File;
  /** The name it takes there: its own, or a free one beside the file there. */
  name: string;
  /** Where, in the space's folder. */
  folder: string[];
  state: "queued" | "sending" | "asking" | "done" | "failed" | "cancelled" | "skipped";
  /** Its bytes sent (the parts received, and the one on its way), of its size. */
  loaded: number;
  total: number;
  /** Sending: this attempt's id, and where its part on the way starts (what the computer has). */
  attempt?: string;
  offset?: number;
  /** When its first part started, and when its bytes last moved. */
  started?: number;
  moved?: number;
  /** Its bytes kept moving past the start: the computer is taking them. */
  flowing?: boolean;
  /** It goes in place of the file there. */
  replace?: boolean;
  /** Asking: what has its name there. */
  there?: There;
  /** Failed: what the route (or the browser) said. */
  refused?: Refusal;
  /** Done: its size there. */
  size?: number;
};

/** How a sending upload is going: its bytes moving, the computer waking (or awaited), or finishing there. */
export type Phase = "sending" | "waking" | "finishing";

export function phaseOf(u: Upload, now: number): Phase {
  const since = now - (u.moved ?? u.started ?? now);
  if (since < STALLED_MS) return "sending";
  if (!u.flowing) return "waking";
  return u.loaded >= u.total ? "finishing" : "sending";
}

/** Whether it's still to do: queued, on its way, or waiting for the person. */
export const active = (u: Upload): boolean =>
  u.state === "queued" || u.state === "sending" || u.state === "asking";

/** What a person makes of a name that's taken. */
export type Choice = "replace" | "keep" | "skip";

/**
 * A free name beside those `taken` (in any case: some disks don't tell
 * `A.txt` from `a.txt`): "report.pdf" is "report 2.pdf", then "report
 * 3.pdf"; "report 2.pdf" is "report 3.pdf"; "site.tar.gz" is "site 2.tar.gz".
 */
export function freeName(name: string, taken: Iterable<string>): string {
  const used = new Set([...taken].map((n) => n.toLowerCase()));
  const dot = name.lastIndexOf(".");
  let stem = dot > 0 ? name.slice(0, dot) : name;
  let ext = dot > 0 ? name.slice(dot) : "";
  if (/.\.tar$/i.test(stem)) [stem, ext] = [stem.slice(0, -4), stem.slice(-4) + ext];
  const numbered = /^(.*\S) (\d+)$/.exec(stem);
  let n = numbered ? Number(numbered[2]) + 1 : 2;
  if (numbered) stem = numbered[1];
  for (;; n++) {
    const next = `${stem} ${n}${ext}`;
    if (!used.has(next.toLowerCase())) return next;
  }
}

/** Whether a drag carries files (not text, not a link). */
export const carriesFiles = (types: Iterable<string> | undefined): boolean =>
  !!types && [...types].includes("Files");

/**
 * What was dropped: its files, and the names of its folders (which aren't
 * uploaded). Read while the drop's event lasts: its items are gone after.
 */
export function droppedOf(data: Pick<DataTransfer, "files"> & { items?: DataTransferItemList }): {
  files: File[];
  folders: string[];
} {
  const items = [...(data.items ?? [])].filter((item) => item.kind === "file");
  if (!items.length) return { files: [...data.files], folders: [] };
  const files: File[] = [];
  const folders: string[] = [];
  for (const item of items) {
    const entry = item.webkitGetAsEntry?.();
    if (entry?.isDirectory) {
      folders.push(entry.name);
      continue;
    }
    const file = item.getAsFile();
    if (file) files.push(file);
  }
  return { files, folders };
}

/** A Files tab's uploads: added, sent a few at a time, answered, cancelled, tried again, cleared. */
export type Uploader = {
  /** The list as it is now (a new array each time it changes). */
  uploads(): Upload[];
  /** Hears each change; returns how to stop. */
  subscribe(listener: () => void): () => void;
  /** Files to put in `folder`, which the listing says holds `listed` (to ask about names taken first). */
  add(files: File[], folder: string[], listed?: Entry[]): void;
  cancel(id: string): void;
  cancelAll(): void;
  /** One failed, cancelled or skipped, again. */
  retry(id: string): void;
  /** What to do with a name that's taken; `all`, for the rest of its batch too. */
  answer(id: string, choice: Choice, all?: boolean): void;
  /** The name keeping both would give it. */
  keepAs(id: string): string;
  /** Takes away what's over (done, failed, cancelled, skipped). */
  clear(): void;
};

export function uploader(
  { desk, base = () => "", send = xhrSend, now = () => Date.now(), atOnce = AT_ONCE, finished }: {
    /** The desk: the computer, in the space. */
    desk: string;
    /** The app's base, for the route's address (`appBase()`). */
    base?: () => string;
    send?: Send;
    now?: () => number;
    atOnce?: number;
    /** One is there: the listing shows it now. */
    finished?(upload: Upload): void;
  },
): Uploader {
  let list: Upload[] = [];
  let made = 0;
  let batches = 0;
  const listeners = new Set<() => void>();
  const inflight = new Map<string, Sending>();
  /** Names known taken, by folder: the listing's, the computer's `exists`, and those uploaded. */
  const taken = new Map<string, Set<string>>();
  /** A choice made for the rest of a batch. */
  const decided = new Map<number, Choice>();
  let telling: ReturnType<typeof setTimeout> | undefined;

  const tell = () => {
    if (telling) clearTimeout(telling), telling = undefined;
    for (const listener of [...listeners]) listener();
  };
  /** Progress, told at most every so often. */
  const tellSoon = () => telling ??= setTimeout(tell, TELL_MS);

  const takenIn = (folder: string[]) => {
    const key = folder.join("/");
    let names = taken.get(key);
    if (!names) taken.set(key, names = new Set());
    return names;
  };
  const find = (id: string) => list.find((u) => u.id === id);
  const change = (id: string, to: Partial<Upload>) => {
    list = list.map((u) => u.id === id ? { ...u, ...to } : u);
  };

  /** A free name for one, beside what's there and what's on its way there. */
  const keepAs = (u: Upload) => {
    const going = list.filter((o) => o.id !== u.id && o.folder.join("/") === u.folder.join("/"))
      .filter((o) => active(o) || o.state === "done").map((o) => o.name);
    return freeName(u.file.name, [...takenIn(u.folder), ...going]);
  };

  /** A choice, made for one: what it can be (a folder there is never replaced). */
  const choose = (u: Upload, choice: Choice) => {
    if (choice === "skip") return change(u.id, { state: "skipped" });
    if (choice === "replace") {
      if (u.there?.type === "directory") return;
      return change(u.id, { state: "queued", replace: true, there: undefined });
    }
    change(u.id, { state: "queued", name: keepAs(u), replace: false, there: undefined });
  };

  /** Its bytes moved to `loaded`: when, and whether the computer is taking them yet. */
  const movedTo = (u: Upload, loaded: number, taking = false) => {
    const t = now();
    change(u.id, {
      loaded,
      moved: t,
      flowing: taking || !!u.flowing || t - (u.started ?? t) >= FLOWING_MS,
    });
  };

  /** What came of a part of an attempt; any other's answer (cancelled, tried again since) is old. */
  const settle = (id: string, attempt: string, offset: number, answer: Answer) => {
    const u = find(id);
    if (!u || u.state !== "sending" || u.attempt !== attempt || u.offset !== offset) return;
    inflight.delete(id);
    if (answer.ok && "received" in answer) {
      // A part before the last: the computer has it (it's up), and the next goes.
      if (answer.received <= offset || answer.received >= u.total) {
        change(id, { state: "failed", refused: { ok: false, status: 200, code: "restart" } });
        tell();
        return pump();
      }
      movedTo(u, answer.received, true);
      change(id, { offset: answer.received });
      tellSoon();
      return part(id);
    }
    if (answer.ok) {
      takenIn(u.folder).add(u.name);
      change(id, { state: "done", loaded: u.total, size: answer.size });
      tell();
      finished?.(find(id)!);
      return pump();
    }
    if (answer.code === "cancelled") change(id, { state: "cancelled" });
    else if (answer.code === "exists") {
      takenIn(u.folder).add(u.name);
      // Sent to replace it, and still there: it's a folder.
      const there: There = { type: u.replace ? "directory" : u.there?.type ?? "file" };
      change(id, { state: "asking", there, replace: false, loaded: 0, attempt: undefined });
      const choice = decided.get(u.batch);
      if (choice) choose(find(id)!, choice);
    } else if (answer.code === "invalid" && offset > 0) {
      // A later part the computer won't take (it lost track of the upload): it starts again.
      change(id, { state: "failed", refused: { ...answer, code: "restart" } });
    } else change(id, { state: "failed", refused: answer });
    tell();
    pump();
  };

  /** The part of an attempt where the computer is: sent, then the next, until the last. */
  function part(id: string) {
    const u = find(id);
    if (!u || u.state !== "sending" || !u.attempt) return;
    const { attempt, total } = u;
    const offset = u.offset ?? 0;
    const end = Math.min(offset + PART, total);
    const sending = send({
      url: uploadUrl(base(), desk, [...u.folder, u.name].join("/"), {
        upload: attempt,
        offset,
        total,
        ...(u.replace ? { replace: true } : {}),
      }),
      file: u.file.slice(offset, end),
      progress: (loaded) => {
        const was = find(id);
        if (!was || was.state !== "sending" || was.attempt !== attempt || was.offset !== offset) {
          return;
        }
        const sent = Math.min(offset + loaded, end);
        if (sent <= was.loaded) return;
        movedTo(was, sent);
        tellSoon();
      },
    });
    inflight.set(id, sending);
    sending.answer.then(
      (answer) => settle(id, attempt, offset, answer),
      () => settle(id, attempt, offset, { ok: false, status: 0, code: "network" }),
    );
  }

  /** An attempt, from its start: a new id, from the first byte. */
  const start = (u: Upload) => {
    const at = now();
    change(u.id, {
      state: "sending",
      attempt: uploadId(),
      offset: 0,
      loaded: 0,
      started: at,
      moved: at,
      flowing: false,
      refused: undefined,
    });
    part(u.id);
  };

  function pump() {
    let going = list.filter((u) => u.state === "sending").length;
    for (const u of list) {
      if (going >= atOnce) break;
      if (u.state !== "queued") continue;
      start(u);
      going++;
    }
    tell();
  }

  return {
    uploads: () => list,
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    add(files, folder, listed) {
      if (!files.length) return;
      const batch = ++batches;
      // A new batch after the last is over starts the list again: only what failed stays.
      if (!list.some(active)) list = list.filter((u) => u.state === "failed");
      const names = takenIn(folder);
      for (const e of listed ?? []) names.add(e.name);
      const there = new Map((listed ?? []).map((e) => [e.name, e]));
      for (const file of files) {
        const known = there.get(file.name);
        list = [...list, {
          id: `upload-${++made}`,
          batch,
          file,
          name: file.name,
          folder,
          loaded: 0,
          total: file.size,
          ...(file.size > MOST
            ? { state: "failed", refused: { ok: false, status: 413, code: "too_large" } }
            : known
            ? {
              state: "asking",
              there: { type: known.type === "directory" ? "directory" : "file", ...seen(known) },
            }
            : { state: "queued" }),
        } as Upload];
      }
      pump();
    },
    cancel(id) {
      const u = find(id);
      if (!u || !active(u)) return;
      change(id, { state: "cancelled" });
      // The part on its way stops; no more go (the computer drops what it kept, later).
      inflight.get(id)?.abort();
      inflight.delete(id);
      tell();
      pump();
    },
    cancelAll() {
      const going = list.filter(active);
      list = list.map((u) => active(u) ? { ...u, state: "cancelled" } : u);
      for (const u of going) {
        inflight.get(u.id)?.abort();
        inflight.delete(u.id);
      }
      tell();
    },
    retry(id) {
      const u = find(id);
      if (!u || active(u) || u.state === "done") return;
      if (u.file.size > MOST) return;
      // Skipped, it asks again: the name is still taken.
      change(
        id,
        u.state === "skipped"
          ? { state: "asking", refused: undefined }
          : { state: "queued", loaded: 0, refused: undefined },
      );
      pump();
    },
    answer(id, choice, all) {
      const u = find(id);
      if (!u || u.state !== "asking") return;
      choose(u, choice);
      if (all) {
        decided.set(u.batch, choice);
        for (const other of list) {
          if (other.batch === u.batch && other.state === "asking") choose(other, choice);
        }
      }
      pump();
    },
    keepAs(id) {
      const u = find(id);
      return u ? keepAs(u) : "";
    },
    clear() {
      list = list.filter(active);
      tell();
    },
  };
}

/** What the listing says of the file there, for the question. */
const seen = (e: Entry) => ({
  ...(e.type === "file" ? { size: e.size } : {}),
  ...(e.mtime ? { mtime: e.mtime } : {}),
});

/** The uploads, counted: to do, done, failed; and their bytes sent and to send. */
export function countOf(uploads: Upload[]): {
  going: number;
  done: number;
  failed: number;
  asking: number;
  loaded: number;
  total: number;
} {
  let [going, done, failed, asking, loaded, total] = [0, 0, 0, 0, 0, 0];
  for (const u of uploads) {
    if (u.state === "done") done++;
    if (u.state === "failed") failed++;
    if (u.state === "asking") asking++;
    if (u.state === "queued" || u.state === "sending") {
      going++;
      loaded += u.loaded;
      total += u.total;
    }
  }
  return { going, done, failed, asking, loaded, total };
}
