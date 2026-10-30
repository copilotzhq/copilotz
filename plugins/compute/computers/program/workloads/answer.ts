/**
 * How a workload answers: one JSON value, or, when it fails,
 * `{ error: { message, code } }`. A failure is an answer too, because Oxian
 * tells plugin code only that a job's handler failed, not why.
 */
import type { WorkerWorkHandler } from "@oxian/oxian-js";
import type { Failed } from "../../shared/workloads.ts";

/** Stops the work with an error its answer carries (`code`: invalid, not_found, busy…). */
export function fail(message: string, code = "invalid"): never {
  throw Object.assign(new Error(message), { code });
}

/** The error a failure answers with. */
export function failure(error: unknown): Failed {
  const code = (error as { code?: unknown })?.code;
  return {
    error: {
      message: error instanceof Error ? error.message : String(error),
      code: typeof code === "string" ? code : "failed",
    },
  };
}

const encoder = new TextEncoder();

/** A workload that reads its input as JSON and answers `run`'s value (or its failure) as JSON. */
export function answer<I>(
  run: (input: I, signal: AbortSignal) => unknown | Promise<unknown>,
): WorkerWorkHandler {
  return async ({ input, signal }) => {
    let value: unknown;
    try {
      const text = await new Response(input).text();
      value = await run((text ? JSON.parse(text) : {}) as I, signal);
    } catch (error) {
      value = failure(error);
    }
    return encoder.encode(JSON.stringify(value ?? null));
  };
}
