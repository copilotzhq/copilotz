/**
 * The shapes the computer's engines share: an ACP agent as the client sees
 * it (`Peer`: a native agent's process, or one of our adapters, which drive
 * a CLI that doesn't speak ACP and answer as an agent would), how one is
 * started, and an engine of the registry (engines.ts).
 *
 * ACP is the Agent Client Protocol, v1: JSON-RPC 2.0, one JSON object per
 * line. The client (acp.ts) asks `initialize`, `session/new` or
 * `session/load`, then `session/prompt`, hearing `session/update`s as it
 * goes; `session/cancel` stops a prompt. What it passes and expects beyond
 * ACP's own is under `_meta.copilotz`.
 */

/** How a peer went: its exit code (a process's), and why, when it broke. */
export type Ended = { code: number | null; error?: string };

/** A JSON-RPC peer: an ACP agent as the client sees it (a native process, or one of our adapters). */
export type Peer = {
  request<R = unknown>(method: string, params?: unknown): Promise<R>;
  notify(method: string, params?: unknown): void;
  /** What the agent sends the client: notifications (`session/update`). */
  // deno-lint-ignore no-explicit-any
  onNotification(handler: (method: string, params: any) => void): void;
  /** What the agent asks the client (`session/request_permission`): answer, or throw. */
  // deno-lint-ignore no-explicit-any
  onRequest(handler: (method: string, params: any) => Promise<unknown>): void;
  /** When it's gone, and why. */
  closed: Promise<Ended>;
  close(): Promise<void>;
};

export type LaunchOptions = {
  /** The CLI's executable, as found. */
  command: string;
  /** The engine's own home on this computer: its config dir, sign-in and sessions live here, never the person's own. */
  home: string;
  /** The environment it runs with: the computer's, minus providers' credentials, plus the engine's home variable. */
  env: Record<string, string>;
  log: (line: string) => void;
};

/** An adapter: starts the CLI and answers as an ACP agent would. */
export type Adapter = (options: LaunchOptions) => Peer;

/**
 * Why an agent's request failed, as its JSON-RPC error's `data.code` says:
 * `signed_out`, `limit` (the plan's usage or rate limit), `model` (one the
 * plan doesn't have), or `failed`.
 */
export type AgentFailure = "signed_out" | "limit" | "model" | "failed";

/** The MCP server a session's tools come from, as `session/new` passes it. */
export type McpServerParams = {
  type: "http";
  name: string;
  url: string;
  headers: { name: string; value: string }[];
};

/** `session/new`'s params; `session/load`'s add `sessionId`. */
export type NewSessionParams = {
  /** The session's own folder (empty, but for a native agent's rules). */
  cwd: string;
  mcpServers: McpServerParams[];
  /** The agent's instructions, which replace the CLI's own, and the model, for our adapters. */
  _meta?: { copilotz?: { instructions: string; model: string } };
};

export type LoadSessionParams = NewSessionParams & { sessionId: string };

/** `session/prompt`'s params: new input, as ACP content blocks (`{ type: "text", text }`…). */
export type PromptParams = { sessionId: string; prompt: unknown[] };

/** Tokens a prompt used, as an adapter says (`_meta.copilotz.usage`). */
export type Usage = { input: number; output: number; cached?: number; cacheWrite?: number };

/** `session/prompt`'s answer. */
export type PromptResponse = {
  stopReason: "end_turn" | "cancelled" | "max_tokens" | "max_turn_requests" | "refusal";
  _meta?: { copilotz?: { usage?: Usage } };
};

/** What `session/update` carries: one `SessionUpdate`, told by `sessionUpdate`. */
export type SessionUpdate = { sessionUpdate: string; [field: string]: unknown };

/** A command's run: how it ended and what it wrote. */
export type Ran = { code: number | null; stdout: string; stderr: string };

/** Runs an engine's CLI with `args` in its home and environment (and `stdin`, when given). */
export type Run = (args: string[], stdin?: string) => Promise<Ran>;

/**
 * An engine of the registry (engines.ts): a plan's CLI, where it's found,
 * the home it runs in, how it speaks ACP (an adapter of ours, or itself),
 * and how it signs in.
 */
export type Engine = {
  /** Its name in the contract: `claude`, `codex`, `antigravity`, `grok`, `cursor`. */
  name: string;
  /** Its executable's name, looked for on the PATH. */
  binary: string;
  /** Where else it installs, given the person's home folder. */
  places(user: string): string[];
  /** The variables that point it at its own home. */
  homeEnv(home: string): Record<string, string>;
  /** Our adapter, when it doesn't speak ACP itself. */
  adapter?: Adapter;
  /** A native ACP agent's arguments. */
  args?: string[];
  /** Readies its home before it starts: its settings. */
  prepare?(home: string): Promise<void>;
  /**
   * A file its home must have for it to be installed, beside its binary:
   * Cursor's SDK, which Sign in installs there (`ENGINE_HOME`, to its installer).
   */
  needs?: string;
  /** Its arguments that print its version (`--version`). */
  version?: string[];
  /** Whether its instructions go as rules in the session's folder (`AGENTS.md`): no prompt of its own to replace. */
  rules?: boolean;
  /** Its CLI's arguments for signing in. */
  login: string[];
  /**
   * Its CLI's arguments for signing out, run in its home: its sign-in is
   * kept there, so when they fail its home goes instead. Without them, it
   * can't be signed out from here (its sign-in may be the system keyring's).
   */
  logout?: string[];
  /**
   * Whether it's signed in, as whom, and the models its plan runs, when it
   * lists them: a native agent without this is asked for a session.
   */
  signedIn?(run: Run): Promise<{ signedIn: boolean; account?: string; models?: string[] }>;
};
