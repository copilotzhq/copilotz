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
  /** Answers once a job ends, or after a while still running: `JobsWaitInput`. */
  jobsWait: "computer.jobs.wait",
  filesList: "computer.files.list",
  filesRead: "computer.files.read",
  filesWrite: "computer.files.write",
  filesEdit: "computer.files.edit",
  /** A file's bytes, streamed in (an upload, of any size): `FilesPutHead`, then the bytes. */
  filesPut: "computer.files.put",
  /** Actions in whose's browser (its own Chrome and profile in the space), hidden or shown. */
  browser: "computer.browser",
  /** A web search, from the computer. */
  search: "computer.search",
  /** One HTTP exchange with a port the computer serves (a job's), streamed both ways: `HttpRequestHead`. */
  http: "computer.http",
  /** A folder of a space, as a gzipped tar, streamed: `ArchiveInput`. */
  archive: "computer.archive",
  /** Which plans' CLIs (engines) the computer has, and whether each is signed in: `EngineStatus[]`. */
  agentsStatus: "computer.agents.status",
  /** Signing an engine in, polled like the terminal: `LoginInput` → `LoginState`. */
  agentsLogin: "computer.agents.login",
  /** One step of a model call on an engine: `PromptInput`, its `PromptEvent`s streamed as JSON lines. */
  agentsPrompt: "computer.agents.prompt",
  /** Stops what an engine's session is doing: `{ session }` → `{ ok: true }`. */
  agentsCancel: "computer.agents.cancel",
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
  /**
   * The work it serves, by name (`WORK`'s): what the app may ask of it.
   * Absent from a program older than this list, which serves none of the
   * work added since (`computer.files.put`).
   */
  serves?: string[];
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
  /** It ended because it was stopped (`jobs.stop`), not on its own. */
  stopped?: true;
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
/**
 * Waits for a job of whose's to end, for `ms` at most (default and most: `WAIT_MS`); answers it,
 * with the end of what it wrote (`tail` characters of each stream, default 2,000) once it's ended.
 */
export type JobsWaitInput = { scope: Scope; id: string; ms?: number; tail?: number };
/** A job waited on: still running (after the wait), or ended, with the end of its output. */
export type JobsWaited = { job: Job; stdout?: string; stderr?: string };
/** The longest a wait for a job lasts before it answers that it's still running. */
export const WAIT_MS = 10 * 60_000;

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
 * `computer.files.put`: a file written from bytes streamed in, so its size
 * has no bound but the disk's (up to `MOST_PUT`), and nothing is held whole.
 * Its input is this head (one JSON line), then exactly `size` bytes; it
 * answers `Written` (or `Failed`, one JSON value). The bytes go to a
 * temporary file, renamed over it once all came, so a broken upload leaves
 * nothing. A file there already is kept unless `replace` (`exists`); a
 * folder there always is. Codes past `Failed`'s: `exists`, `too_large`,
 * `full` (no room left on the disk).
 *
 * A file too large for one request (a proxy's limit) comes in parts, in
 * order (`upload`): each its own put of `size` bytes at `offset`, of a file
 * of `total`, kept apart under the program's own folder until the last,
 * which puts the file in place. A part before the last answers `PutPart`.
 * Whether a file is there is asked at the first part and again at the
 * last; a part out of order fails (`invalid`), and the upload starts again.
 * Parts nobody finished go after a day.
 */
export type FilesPutHead = {
  scope: Scope;
  path: string;
  size: number;
  replace?: boolean;
  /** A part of a file sent in parts: the upload's id, where this part starts, and the file's size. */
  upload?: { id: string; offset: number; total: number };
};

/** What a part before the last answers: how many of the file's bytes are in. */
export type PutPart = { received: number };

/** The most a put takes: 2 GiB. */
export const MOST_PUT = 2 * 1024 ** 3;

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

/**
 * An engine: a plan's CLI on this computer (`claude`, `codex`,
 * `antigravity`), which an agent's model calls can run on. Each has a home of
 * its own on the computer (its sign-in, its sessions), apart from the
 * person's own use of it.
 */
export type EngineStatus = {
  engine: string;
  installed: boolean;
  version?: string;
  signedIn: boolean;
  /** Who it's signed in as, when it says. */
  account?: string;
};

/** `computer.agents.status`: these engines (every one unless given). */
export type StatusInput = { engines?: string[] };

/**
 * `computer.agents.login`: signs an engine in, polled like the terminal. The
 * first call starts its CLI's sign-in; `input` goes to it (a code pasted
 * after signing in elsewhere); an empty call polls; `stop` ends it.
 */
export type LoginInput = { engine: string; input?: string; stop?: boolean };

export type LoginState = {
  state: "running" | "done";
  /** What it wrote since the last answer. */
  output: string;
  signedIn: boolean;
  /** The sign-in link, once it's shown one. */
  url?: string;
};

/** A tool an engine's model may call, as MCP has it. */
export type EngineTool = { name: string; description?: string; inputSchema: unknown };

/** The answer to a call the model made (a `call` event's `id`): text, or an error's words. */
export type CallResult = { id: string; content: string; isError?: boolean };

/**
 * `computer.agents.prompt`: one step of a model call on an engine. Its
 * input is one JSON value; its output, `PromptEvent`s as JSON lines.
 *
 * A session is fixed to its engine, model, instructions and tools. A prompt
 * runs on until the engine's turn ends; a step's stream ends after the calls
 * the model makes (`call`), which the prompt waits on, held, and the next
 * step, the same `id` again, answers (`results`) and goes on from (`from`).
 * Cancelling a step's stream only leaves it: the prompt goes on.
 */
export type PromptInput = {
  engine: string;
  model: string;
  /** The engine's session to continue (from an earlier `session` event); a fresh one when absent. */
  session?: string;
  instructions: string;
  /** The agent's tools for this step, as MCP tools. */
  tools: EngineTool[];
  /** New input (ACP content blocks); empty when only answering held calls. */
  prompt: unknown[];
  /** The prompt's id: the same id again reattaches to it instead of prompting again. */
  id: string;
  /** Reattaching: the first event index to send (events before it were already received). */
  from?: number;
  /** Answers to held tool calls, settled before reattaching. */
  results?: CallResult[];
};

/** What a prompt's token use was, as its engine said. */
export type EngineUsage = { input: number; output: number; cached?: number; cacheWrite?: number };

/**
 * What a prompt streams, numbered (`i`) from 0 within it. A fresh session's
 * first event is `session`; a step ends with `call`s, `done` or `failed`.
 * `failed`'s `code`: `missing` (no CLI), `signed_out`, `limit` (the plan's
 * usage or rate limit), `model` (one the plan doesn't have), `stale` (the
 * session isn't this one anymore: start a fresh one), `lost` (its events
 * were dropped), `busy` (another prompt runs in it), or `failed`.
 */
export type PromptEvent =
  & { i: number }
  & (
    | { type: "session"; session: string }
    /** An ACP `SessionUpdate`: text, thinking, a tool call's progress. */
    | { type: "update"; update: unknown }
    | { type: "call"; call: { id: string; name: string; arguments: unknown } }
    | { type: "done"; stopReason: string; usage?: EngineUsage }
    | { type: "failed"; code: string; message: string }
  );

/** `computer.agents.cancel`: stops what the session is doing, and fails its held calls. */
export type CancelInput = { session: string };
