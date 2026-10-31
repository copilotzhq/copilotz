/**
 * What an agent's call to a computer tool came to, read from what the tool
 * returned (`output`, as the agent read it: JSON, or words): still running;
 * waiting for its person's yes; no computer to do it on; failed (a thrown
 * error, `Error: …`, or the computer's `{ error: { message } }`); or done,
 * with its value. And what a `terminal` call was: a new command, a look at
 * one running, input to it, or an interrupt.
 */
import type { ShownCall } from "../../../../agents/chat/contract.ts";
import type { TerminalResult } from "../../shared/workloads.ts";

export type Outcome =
  | { kind: "running" }
  | { kind: "waiting"; text: string }
  | { kind: "missing"; text: string }
  | { kind: "failed"; text: string }
  | { kind: "done"; value: unknown };

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function outcome(call: Pick<ShownCall, "output">): Outcome {
  if (call.output === undefined) return { kind: "running" };
  let value: unknown = call.output;
  try {
    value = JSON.parse(call.output);
  } catch { /* Words, not JSON. */ }
  if (typeof value === "string") {
    // "Waiting for ana's yes to run this…" (shared/ask.ts): its start is what stays.
    if (/^Waiting for \S/.test(value)) return { kind: "waiting", text: value };
    if (
      /has no computer connected|no person this work is for|^There's no computer|is offline[:,]|is still waking|^More than one of this space's computers/
        .test(value)
    ) {
      return { kind: "missing", text: value };
    }
    if (value.startsWith("Error: ")) return { kind: "failed", text: value.slice(7) };
  }
  if (record(value) && record(value.error) && typeof value.error.message === "string") {
    return { kind: "failed", text: value.error.message };
  }
  return { kind: "done", value };
}

/** A list the computer answered: the array itself, or the array under `key` (as older answers had it). */
export function listOf<T>(value: unknown, key: string): T[] {
  if (Array.isArray(value)) return value as T[];
  if (record(value) && Array.isArray(value[key])) return value[key] as T[];
  return [];
}

export type TerminalCall = {
  /** A new command, a look at the one running, input to it, or Ctrl+C. */
  mode: "run" | "poll" | "input" | "interrupt";
  /** The command, or the input. */
  text: string;
  result?: TerminalResult;
};

const isResult = (value: unknown): value is TerminalResult =>
  record(value) && (value.state === "running" || value.state === "idle") &&
  typeof value.commandId === "string";

export function terminalCall(call: Pick<ShownCall, "input" | "output">): TerminalCall {
  const input = call.input ?? {};
  const stdin = typeof input.stdin === "string" ? input.stdin : "";
  const mode = input.operation === "interrupt"
    ? "interrupt"
    : !input.commandId
    ? "run"
    : stdin
    ? "input"
    : "poll";
  const done = outcome(call);
  return {
    mode,
    text: stdin.replace(/\n$/, ""),
    ...(done.kind === "done" && isResult(done.value) ? { result: done.value } : {}),
  };
}

/** How long something took, briefly: "84 ms", "2.4 s", "1 m 12 s". */
export const took = (ms: number): string =>
  ms < 1000
    ? `${Math.round(ms)} ms`
    : ms < 60_000
    ? `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`
    : `${Math.floor(ms / 60_000)} m ${Math.round((ms % 60_000) / 1000)} s`;
