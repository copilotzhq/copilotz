/**
 * JSON-RPC 2.0 over a pair of streams, one JSON object per line: what ACP
 * agents speak on stdio (`agy acp`), and `codex app-server` too (without
 * the `jsonrpc` member: `bare`). Either side asks (`request`, answered by
 * id), tells (`notify`, unanswered), and hears the other's.
 *
 * `spawnPeer` runs a CLI as such a peer: in its own process group (see
 * processes.ts), its stderr kept (the last few KiB) to say why it went, and
 * closing it stops the whole tree.
 */
import { spawn } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { OWN, signalGroup } from "../workloads/processes.ts";
import type { Ended, Peer } from "./types.ts";

/** A JSON-RPC error: its numeric `code`, and `data` (ACP's agents: `{ code: "signed_out" }`…). */
export type RpcError = Error & { code: number; data?: unknown };

/** A JSON-RPC error to answer with, or that an answer carried. */
export function rpcError(message: string, data?: unknown, code = -32000): RpcError {
  return Object.assign(new Error(message), { code, ...(data === undefined ? {} : { data }) });
}

/** An agent's failure (`signed_out`, `limit`, `model`, `failed`), as ACP clients read it: `data.code`. */
export const agentError = (code: string, message: string): RpcError => rpcError(message, { code });

/** The `data.code` an error carries (an agent's failure), if it carries one. */
export function failureOf(error: unknown): string | undefined {
  const data = (error as { data?: { code?: unknown } })?.data;
  return typeof data?.code === "string" ? data.code : undefined;
}

export type RpcOptions = {
  /** Without the `jsonrpc` member (codex app-server's dialect). */
  bare?: boolean;
  /** Where lines that aren't JSON go. */
  log?: (line: string) => void;
};

type Message = {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};

/** The longest line it reads. */
const MOST = 64 * 1024 * 1024;

/**
 * A peer on `input` (what the other side writes) and `output` (what it
 * reads). It's closed when `input` ends; `ended` says how, when it's a
 * process's (see `spawnPeer`).
 */
export function streamPeer(
  input: Readable,
  output: Writable,
  options: RpcOptions & { ended?: Promise<Ended>; stop?: () => Promise<void> } = {},
): Peer {
  let next = 0;
  let gone: Ended | undefined;
  const pending = new Map<
    number,
    { resolve(value: unknown): void; reject(error: unknown): void }
  >();
  const notified = new Set<(method: string, params: unknown) => void>();
  let asked: ((method: string, params: unknown) => Promise<unknown>) | undefined;

  const send = (message: Message) => {
    if (gone) return;
    output.write(JSON.stringify(options.bare ? message : { jsonrpc: "2.0", ...message }) + "\n");
  };
  output.on("error", () => {});

  const answer = async (id: number | string, method: string, params: unknown) => {
    try {
      if (!asked) throw rpcError(`Method not found: ${method}`, undefined, -32601);
      send({ id, result: (await asked(method, params)) ?? null });
    } catch (error) {
      const code = (error as { code?: unknown })?.code;
      const data = (error as { data?: unknown })?.data;
      send({
        id,
        error: {
          code: typeof code === "number" ? code : -32603,
          message: error instanceof Error ? error.message : String(error),
          ...(data === undefined ? {} : { data }),
        },
      });
    }
  };

  const hear = (message: Message) => {
    if (message.method !== undefined) {
      if (message.id !== undefined && message.id !== null) {
        void answer(message.id, message.method, message.params);
      } else {
        for (const handler of notified) {
          try {
            handler(message.method, message.params);
          } catch (error) {
            options.log?.(`a notification's handler failed: ${(error as Error)?.message ?? error}`);
          }
        }
      }
      return;
    }
    const call = typeof message.id === "number" ? pending.get(message.id) : undefined;
    if (!call) return;
    pending.delete(message.id as number);
    if (message.error) {
      call.reject(
        rpcError(message.error.message ?? "Failed", message.error.data, message.error.code),
      );
    } else call.resolve(message.result);
  };

  let done!: (ended: Ended) => void;
  const closed = new Promise<Ended>((resolve) => done = resolve);
  const finish = (ended: Ended) => {
    if (gone) return;
    gone = ended;
    const error = rpcError(ended.error ?? "The agent is gone", { code: "failed" });
    for (const call of pending.values()) call.reject(error);
    pending.clear();
    done(ended);
  };

  let buffer = "";
  input.setEncoding("utf8");
  input.on("data", (chunk: string) => {
    buffer += chunk;
    for (let at = buffer.indexOf("\n"); at >= 0; at = buffer.indexOf("\n")) {
      const line = buffer.slice(0, at).trim();
      buffer = buffer.slice(at + 1);
      if (!line) continue;
      let message: Message;
      try {
        message = JSON.parse(line);
      } catch {
        options.log?.(`not JSON-RPC: ${line.slice(0, 200)}`);
        continue;
      }
      if (message && typeof message === "object") hear(message);
    }
    if (buffer.length > MOST) {
      buffer = "";
      options.log?.("a line too long to read; dropped");
    }
  });
  input.on("error", () => {});
  if (options.ended) void options.ended.then(finish);
  else input.on("close", () => finish({ code: null }));

  return {
    request<R>(method: string, params?: unknown) {
      if (gone) {
        return Promise.reject(rpcError(gone.error ?? "The agent is gone", { code: "failed" }));
      }
      const id = ++next;
      return new Promise<R>((resolve, reject) => {
        pending.set(id, { resolve: (value) => resolve(value as R), reject });
        send({ id, method, ...(params === undefined ? {} : { params }) });
      });
    },
    notify: (method, params) => send({ method, ...(params === undefined ? {} : { params }) }),
    onNotification: (handler) => void notified.add(handler),
    onRequest: (handler) => void (asked = handler),
    closed,
    async close() {
      if (options.stop) await options.stop();
      else {
        output.end();
        input.destroy();
      }
      finish(gone ?? { code: null });
    },
  };
}

/** How long a peer's process gets to go after SIGTERM, before SIGKILL. */
const GRACE = 2_000;

/**
 * `command args…` as a peer on its stdio, in `cwd` with `env` (given whole).
 * Closing it ends its stdin and stops its process group; `closed` says its
 * exit code, with the end of its stderr when it failed.
 */
export function spawnPeer(
  command: string,
  args: string[],
  options: RpcOptions & { cwd: string; env: Record<string, string> },
): Peer {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ["pipe", "pipe", "pipe"],
    ...OWN,
  });
  let stderr = "";
  child.stderr!.setEncoding("utf8");
  child.stderr!.on("data", (text: string) => stderr = (stderr + text).slice(-4096));
  child.stderr!.on("error", () => {});
  const ended = new Promise<Ended>((resolve) => {
    child.once("error", (error) => resolve({ code: null, error: error.message }));
    child.once("close", (code, signal) => {
      const why = stderr.trim().split("\n").slice(-3).join(" ").slice(0, 500);
      resolve(
        code === 0 ? { code } : { code, error: why || `${command} exited (${signal ?? code})` },
      );
    });
  });
  const stop = async () => {
    child.stdin!.end();
    if (child.exitCode !== null || child.signalCode !== null) return;
    signalGroup(child.pid, "SIGTERM");
    const timer = setTimeout(() => signalGroup(child.pid, "SIGKILL"), GRACE);
    await ended;
    clearTimeout(timer);
  };
  return streamPeer(child.stdout!, child.stdin!, { ...options, ended, stop });
}
