/**
 * What crosses between the owner and its executors, all JSON:
 * - a job (`core.run` work): run an Action, a Processor delivery or a query;
 * - its output: live frames as they happen, then one result or error;
 * - ops (`core.op` host call): storage operations, alone or in a held transaction.
 */
import type { Actor, Event } from "./store.ts";
import type { Op } from "./ops.ts";
import type { Scheduled } from "./schedules.ts";

export const RUN = "core.run";
export const OP = "core.op";
/**
 * A job's work sent on to a worker of a plugin's kind (a computer): the
 * host call's metadata names it (`{ kind, id, workload }`), its body is the
 * input, and its output the worker's, as it comes.
 */
export const DISPATCH = "core.dispatch";

export type Job =
  /** `id` is the call's id; a retried call says why its previous attempt ended. */
  | {
    kind: "call";
    action: string;
    input: unknown;
    id: string;
    attempt: number;
    after?: "failed" | "lost";
    /** Time called it: the timer, and the time this occurrence was due. */
    scheduled?: Scheduled;
    /** Who called it: the outside call's actor, or the timer's. */
    actor?: Actor;
  }
  /** `retry`: this event may have been handled before (a retried or recovered delivery). */
  | { kind: "process"; processor: string; event: Event; retry: boolean }
  | { kind: "query"; collection: string; query: string; params: unknown; actor?: Actor }
  /** A View, rendered for a medium (see `Owner.render`). */
  | {
    kind: "render";
    renderer: string;
    view: string;
    item: unknown;
    viewer?: { name: string; kind?: string };
    hints?: Record<string, unknown>;
    actor?: Actor;
  };

/** Why something failed; `final`: trying again won't help (it already was, as long as it should be). */
export type Failure = { message: string; code?: string; final?: true };

export type Line =
  | { frame: { channel: string; data: unknown } }
  | { result: unknown }
  | { error: Failure };

/**
 * Ops run in order; the reply is the last one's result. In a held
 * transaction, `end` commits or aborts it after its ops. `cause` is the
 * event the writes answer to: the delivery being processed, or the action
 * being run.
 */
/** `outside`: reads for an outside reader (a query, a View): private fields stay out. */
export type OpRequest =
  | { ops: Op[]; cause?: string; actor?: Actor; outside?: true }
  | {
    tx: string;
    ops: Op[];
    end?: "commit" | "abort";
    cause?: string;
    actor?: Actor;
    outside?: true;
  };

export type OpReply = { value: unknown } | { error: Failure };

const encoder = new TextEncoder();

export const encode = (value: unknown): Uint8Array => encoder.encode(JSON.stringify(value));

export const decode = async <T>(body: ReadableStream<Uint8Array>): Promise<T> =>
  JSON.parse(await new Response(body).text());

export const failure = (error: unknown): Failure => ({
  message: error instanceof Error ? error.message : String(error),
  ...(typeof (error as { code?: unknown })?.code === "string"
    ? { code: (error as { code: string }).code }
    : {}),
  ...((error as { final?: unknown })?.final === true ? { final: true as const } : {}),
});

export const raise = (failure: Failure): Error =>
  Object.assign(
    new Error(failure.message),
    failure.code ? { code: failure.code } : {},
    failure.final ? { final: true } : {},
  );

/**
 * Output lines are newline-delimited JSON. Read with a reader, not `for await`:
 * Safari can't iterate a stream (this runs in browsers too).
 */
export async function* lines<T = Line>(body: ReadableStream<Uint8Array>): AsyncGenerator<T> {
  const text = new TextDecoder();
  const reader = body.getReader();
  let buffer = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += text.decode(value, { stream: true });
      let end: number;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        if (line) yield JSON.parse(line);
      }
    }
  } finally {
    // Stopped early (a consumer that breaks): the stream is let go.
    await reader.cancel().catch(() => {});
  }
}

/** A work's output stream, written line by line as the job runs. */
export function output() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let open = true;
  const readable = new ReadableStream<Uint8Array>({
    start: (c) => void (controller = c),
    cancel: () => void (open = false),
  });
  const write = (line: Line) => {
    if (open) controller.enqueue(encoder.encode(JSON.stringify(line) + "\n"));
  };
  return {
    readable,
    write,
    end(line: Line) {
      write(line);
      if (open) controller.close();
      open = false;
    },
  };
}
