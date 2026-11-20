/**
 * A prompt's events, kept until they're received, and the steps that read
 * them (acp.ts runs the prompt). Each event is numbered from 0 within its
 * prompt. A step streams them from where it's told (`from`), as JSON lines,
 * until the prompt ends (`done`, `failed`), or the model calls tools: a step
 * ends a moment (`stepMs`) after its first `call`, with the calls that came
 * within it. One step reads a prompt at a time: a newer one takes over.
 * Events before where a step starts were received, and go.
 *
 * A prompt whose events not yet received pass the most it may keep is
 * lost: they go, and what reads it is told so (`lost`).
 */
import type { PromptEvent } from "../../shared/workloads.ts";
import { CHUNK } from "../workloads/streams.ts";
import type { HeldCall } from "./mcp.ts";

/** An event, before it's numbered. */
export type Said = PromptEvent extends infer E ? E extends unknown ? Omit<E, "i"> : never
  : never;

type Event = { i: number; line: string; at: number; type: PromptEvent["type"] };

export type Prompt = {
  id: string;
  /** Its events not yet received, from `events[0].i` on. */
  events: Event[];
  next: number;
  bytes: number;
  ended: boolean;
  lost: boolean;
  /** Its calls the plugin hasn't answered, by id. */
  held: Map<string, HeldCall>;
  wake: Set<() => void>;
  /** When anything last happened to it. */
  used: number;
  /** The step reading it now. */
  reader?: symbol;
};

const encoder = new TextEncoder();

/** What a lost prompt's step says. */
const LOST = "This prompt's events were dropped: start again";

export const newPrompt = (id: string): Prompt => ({
  id,
  events: [],
  next: 0,
  bytes: 0,
  ended: false,
  lost: false,
  held: new Map(),
  wake: new Set(),
  used: Date.now(),
});

/** Tells the step reading it there's news. */
export function wake(prompt: Prompt): void {
  for (const wake of [...prompt.wake]) wake();
}

/** A prompt known to be gone: its events, from `from` on, dropped. */
export function lostPrompt(id: string, from: number): Prompt {
  return { ...newPrompt(id), next: from, ended: true, lost: true };
}

/**
 * Adds an event (unless the prompt ended). True when that took it past
 * `most` bytes not yet received: it's lost, its events gone.
 */
export function emit(prompt: Prompt, event: Said, most: number): boolean {
  if (prompt.ended) return false;
  const i = prompt.next++;
  const line = JSON.stringify({ i, ...event }) + "\n";
  prompt.events.push({ i, line, at: Date.now(), type: event.type });
  prompt.bytes += line.length;
  prompt.used = Date.now();
  if (event.type === "done" || event.type === "failed") prompt.ended = true;
  const lost = prompt.bytes > most;
  if (lost) {
    prompt.lost = prompt.ended = true;
    prompt.events = [];
    prompt.bytes = 0;
  }
  wake(prompt);
  return lost;
}

/** Events before `from` were received: they go. */
export function received(prompt: Prompt, from: number): void {
  const first = prompt.events[0]?.i ?? prompt.next;
  const gone = prompt.events.splice(0, Math.max(0, Math.min(from - first, prompt.events.length)));
  for (const event of gone) prompt.bytes -= event.line.length;
}

/** Until the prompt has news, `ms` pass, or the step's stream goes. */
const nap = (prompt: Prompt, ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      prompt.wake.delete(done);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = ms === Infinity ? undefined : setTimeout(done, ms);
    prompt.wake.add(done);
    signal.addEventListener("abort", done, { once: true });
  });

/**
 * A step: the prompt's events from `from`, as JSON lines, until it ends,
 * its calls are in, a newer step takes over, or it's left (`signal`, or
 * its stream cancelled). `left` hears when it's over.
 */
export function step(
  prompt: Prompt,
  from: number,
  options: { signal: AbortSignal; stepMs: number; left?: () => void },
): ReadableStream<Uint8Array> {
  const { signal, stepMs } = options;
  const me = Symbol("step");
  prompt.reader = me;
  prompt.used = Date.now();
  wake(prompt);
  let cursor = from;
  let callAt: number | undefined;
  let over = false;
  const leave = () => {
    if (over) return;
    over = true;
    if (prompt.reader === me) prompt.reader = undefined;
    prompt.used = Date.now();
    options.left?.();
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      for (;;) {
        if (prompt.reader !== me || signal.aborted) {
          leave();
          return controller.close();
        }
        if (prompt.lost) {
          const i = Math.max(prompt.next, cursor);
          controller.enqueue(encoder.encode(
            JSON.stringify({ i, type: "failed", code: "lost", message: LOST }) + "\n",
          ));
          leave();
          return controller.close();
        }
        let text = "";
        let end = false;
        const first = prompt.events[0]?.i ?? prompt.next;
        for (let at = Math.max(0, cursor - first); at < prompt.events.length; at++) {
          const event = prompt.events[at];
          if (callAt !== undefined && event.at > callAt + stepMs) {
            end = true;
            break;
          }
          if (text && text.length + event.line.length > CHUNK / 4) break;
          text += event.line;
          cursor = event.i + 1;
          if (event.type === "call") callAt ??= event.at;
          if (event.type === "done" || event.type === "failed") {
            end = true;
            break;
          }
        }
        if (text) {
          // Oxian's frames are a chunk at most: a line past one goes in parts.
          const bytes = encoder.encode(text);
          for (let at = 0; at < bytes.length; at += CHUNK) {
            controller.enqueue(bytes.subarray(at, at + CHUNK));
          }
        }
        if (end || (prompt.ended && cursor >= prompt.next)) {
          leave();
          return controller.close();
        }
        if (text) return;
        const wait = callAt === undefined ? Infinity : callAt + stepMs - Date.now();
        if (wait <= 0) {
          leave();
          return controller.close();
        }
        await nap(prompt, wait, signal);
      }
    },
    cancel: leave,
  }, { highWaterMark: 0 });
}
