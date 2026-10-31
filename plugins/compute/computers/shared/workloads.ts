/**
 * What the plugin asks a computer, and what it answers: the work a computer
 * program serves (see program/), sent by the plugin's Actions through
 * `ctx.workers` (kind `computer`). Every input is JSON; every answer is one
 * JSON value, except where it says it streams.
 *
 * A computer is one machine. Each space it's used in has a folder of its own
 * under its root (`scope.folder`), and each agent (or person) a shell and jobs
 * of its own there (`scope.who`), so they never tread on each other. The
 * plugin sets the scope from what it trusts (the space, the agent): never
 * from what an agent asks.
 *
 * Work that fails answers `{ error: { message, code } }` (`Failed`) rather
 * than throwing: Oxian tells plugin code only that a worker's handler failed
 * (`handler_failed`), not why.
 */

/**
 * What failed work answers. `code`: `invalid` (bad input), `invalid_path` (a
 * path that leaves the space's folder), `not_found`, `ambiguous` (an edit's
 * text occurs more than once), `busy`, `blocked` (a search turned away),
 * `denied`, `stopping`, or `failed`.
 */
export type Failed = { error: { message: string; code: string } };

/** Where work happens: the space's folder, and whose shell, jobs and browser it is. */
export type Scope = {
  /** The space, by id. */
  space: string;
  /** Its folder's name under the computer's root: plain, one segment. */
  folder: string;
  /** Whose: `agent:<name>` or `person:<id>`. */
  who: string;
};

/** The work a computer serves, by name. */
export const WORK = {
  /** First connection: the computer's id and secret, to keep. */
  enrolled: "computer.enrolled",
  /** What the machine is. */
  info: "computer.info",
  /** A command in whose's shell (its own working directory, environment, history). */
  terminal: "computer.terminal",
  jobsStart: "computer.jobs.start",
  jobsList: "computer.jobs.list",
  jobsLogs: "computer.jobs.logs",
  jobsStop: "computer.jobs.stop",
  filesList: "computer.files.list",
  filesRead: "computer.files.read",
  filesWrite: "computer.files.write",
  filesEdit: "computer.files.edit",
  /** Actions in whose's browser (its own Chrome and profile in the space), hidden or shown. */
  browser: "computer.browser",
  /** A web search, from the computer. */
  search: "computer.search",
  /** One HTTP exchange with a port the computer serves (a job's), streamed both ways: `HttpRequestHead`. */
  http: "computer.http",
  /** A folder of a space, as a gzipped tar, streamed: `ArchiveInput`. */
  archive: "computer.archive",
} as const;

export type Enrolled = { id: string; secret: string };

export type Info = {
  os: string;
  arch: string;
  hostname: string;
  /** Where its spaces' folders are. */
  root: string;
  shell: string;
  /** The browser it drives, if it found one. */
  browser: string | null;
  version: string;
  /** What its person called it (`connect --name`), if they did. */
  name?: string;
  /** Whether its browser may open windows on its screen (`--windows`): allow unless never. */
  windows?: "allow" | "never";
};

/**
 * A command in a shell, as sandbox-lite's terminal has it: `stdin` starts one
 * when idle (or goes to the one running, by `commandId`); an empty `stdin`
 * polls; `interrupt` stops it. It answers within `yield` (about a second),
 * with what it wrote since the last answer, running or done.
 */
export type TerminalInput = {
  scope: Scope;
  /** Environment variables a new shell starts with (its space's, for computers). */
  env?: Record<string, string>;
  stdin?: string;
  commandId?: string;
  operation?: "interrupt";
};

export type TerminalResult = {
  state: "running" | "idle";
  commandId: string;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  exitCode: number | null;
  timedOut: boolean;
  interrupted?: boolean;
  durationMs: number;
  /** The shell's working directory after it, relative to the space's folder. */
  cwd: string;
};

/** A background job: a command that keeps running, with its output kept. */
export type Job = {
  id: string;
  /** Whose it is (`scope.who`). */
  who: string;
  name: string;
  command: string;
  pid: number | null;
  running: boolean;
  exitCode: number | null;
  startedAt: string;
  endedAt?: string;
  /** The port it said it serves (`JobsStartInput.port`). */
  port?: number;
  /** The TCP ports it (or what it started) listens on now, found by the program. */
  ports?: number[];
  /** Started again whenever the computer starts (a cloud computer's wake): a server, say. */
  keep?: boolean;
};

export type JobsStartInput = {
  scope: Scope;
  command: string;
  name?: string;
  /** The port it serves, when it's a server (for previews). */
  port?: number;
  /** Start it again whenever the computer starts. */
  keep?: boolean;
  /** Environment variables it runs with, over the computer's own (its space's, and the caller's). */
  env?: Record<string, string>;
};
/** `all`: every job in the space's folder, whoever's (for its person's panel); else only whose's. */
export type JobsListInput = { scope: Scope; all?: boolean };
export type JobsLogsInput = {
  scope: Scope;
  id: string;
  /** Characters from the end (default all kept, up to 256 KiB per stream). */
  tail?: number;
};
export type JobsLogs = { job: Job; stdout: string; stderr: string; truncated: boolean };
export type JobsStopInput = { scope: Scope; id: string };

/** A path under the space's folder: relative, never escaping it (`..`, absolute, symlinks out). */
export type Entry = {
  name: string;
  type: "file" | "directory" | "other";
  size: number;
  mtime: string;
};

/** A folder's entries (`path`, or the space's folder itself): answers `Entry[]`. */
export type FilesListInput = { scope: Scope; path?: string };
export type FilesReadInput = {
  scope: Scope;
  path: string;
  /** Bytes to skip, and the most to read (default 256 KiB). */
  offset?: number;
  length?: number;
};
export type FilesRead = {
  /** UTF-8 text, or base64 when it isn't text. */
  content: string;
  encoding: "utf8" | "base64";
  size: number;
  truncated: boolean;
};
export type FilesWriteInput = {
  scope: Scope;
  path: string;
  content: string;
  encoding?: "utf8" | "base64";
};
export type FilesEditInput = {
  scope: Scope;
  path: string;
  /** Text that occurs exactly once, and what replaces it. */
  old: string;
  new: string;
};

/** What a write or an edit answers: the file (relative to the space's folder) and its size after. */
export type Written = { path: string; size: number };

/**
 * Browser actions, sandbox-lite's sixteen and those added after (see
 * program/browser/schema.ts), 1–10 per request, done in order: stopping at
 * the first that fails unless `stopOnError` is false, all within `timeoutMs`
 * (240 s unless given). Each who has a Chrome of its own in a space, on a
 * profile of its own that outlasts it (cookies, sign-ins, site storage).
 */
export type BrowserInput = {
  scope: Scope;
  actions: Record<string, unknown>[];
  timeoutMs?: number;
  stopOnError?: boolean;
  /**
   * `hidden` (headless), or `shown`: a window on the person's screen, where
   * they can watch it and use it too. When who's browser is running in the
   * other, it starts again in this one, on the same profile, back on the
   * page it was on. Unless given, it stays as it is; a browser starts hidden.
   * `shown` fails (its action, `code`) with `denied` when the person turned
   * windows off on this computer, and `no_display` when it has no display.
   */
  window?: "hidden" | "shown";
};

/** What browser actions answer: each action's result, in order, and the page after. */
export type BrowserResult = {
  success: boolean;
  stoppedEarly: boolean;
  currentUrl?: string;
  title?: string;
  /** Who's browser after the request: hidden, or shown on the person's screen. */
  window: "hidden" | "shown";
  results: Record<string, unknown>[];
};

export type SearchInput = { scope: Scope; query: string; limit?: number };

/**
 * `computer.http`: one HTTP exchange with `127.0.0.1:<port>` on the computer.
 * Its input is a byte stream: the request's head (this, as one JSON line),
 * then its body, raw. Its output is the same: the response's head
 * (`HttpResponseHead`, one JSON line), then its body as it comes, so a
 * streamed answer streams. A port nothing listens on answers 502. Only ports
 * of the computer's own loopback; WebSocket upgrades aren't carried (yet).
 */
export type HttpRequestHead = {
  scope: Scope;
  port: number;
  method: string;
  /** Path and query, as asked (`/a/b?c=d`). */
  path: string;
  headers: [string, string][];
};
export type HttpResponseHead = { status: number; headers: [string, string][] };

/**
 * `computer.archive`: a folder under the space's folder (`path`, or the
 * folder itself) as a gzipped tar, streamed out, its paths relative to it.
 * `.git`, `node_modules` and other dependency and build caches are left out
 * unless `all`; it fails with `too_large` past `maxBytes` (default 512 MiB).
 */
export type ArchiveInput = { scope: Scope; path?: string; all?: boolean; maxBytes?: number };
export type SearchResult = { title: string; url: string; snippet: string };
