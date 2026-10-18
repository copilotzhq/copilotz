const MAX_JQ_BYTES = 1024 * 1024;
const JQ_TIMEOUT_MS = 5_000;
// Keep the worker in the published type graph without installing its message
// handler or loading WASM in the application importing Core.
import type { JqWorkerRequest } from "./jq-worker.ts";
import {
  createJqAdmission,
  type JqAdmission,
  type JqClock,
  systemJqClock,
} from "./jq-admission.ts";

function serialized(value: unknown, label: string): string {
  let result: string | undefined;
  try {
    result = JSON.stringify(value);
  } catch (error) {
    throw new Error(`${label} must be JSON-compatible: ${String(error)}`);
  }
  if (typeof result !== "string") {
    throw new Error(`${label} must be JSON-compatible.`);
  }
  if (new TextEncoder().encode(result).byteLength > MAX_JQ_BYTES) {
    throw new Error(`${label} exceeds the 1 MiB jq limit.`);
  }
  return result;
}

/** Internal runtime seam, not a public package export. */
export interface CoreJqWorker {
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  postMessage(request: JqWorkerRequest): void;
  terminate(): void;
}

/** Keep dependencies private and isolated so lifecycle tests need no real workers. */
export function createCoreJqEvaluator(options: {
  admission: JqAdmission;
  createWorker: () => CoreJqWorker;
  clock?: JqClock;
}): (
  input: unknown,
  filter: string,
  signal?: AbortSignal,
) => Promise<unknown> {
  const acquire = options.admission.acquire.bind(options.admission);
  const createWorker = options.createWorker;
  const clock = options.clock ?? systemJqClock;
  const schedule = clock.schedule.bind(clock);
  return async (input, filter, signal) => {
    if (!filter.trim()) throw new Error("jq filter is empty.");
    const checkAbort = () => {
      if (signal?.aborted) {
        throw signal.reason ?? new DOMException("Aborted", "AbortError");
      }
    };
    checkAbort();
    const inputJson = serialized(input, "Pipeline input");
    checkAbort();
    const permit = await acquire(signal);
    try {
      checkAbort();
      const worker = createWorker();
      return await new Promise<unknown>((resolve, reject) => {
        let done = false;
        let cancelTimer: (() => void) | undefined;
        let abortRegistered = false;
        const finish = (success: boolean, value: unknown) => {
          if (done) return;
          done = true;
          const cleanup = (action: () => void) => {
            try {
              action();
            } catch (error) {
              if (success) {
                success = false;
                value = error;
              }
            }
          };
          cleanup(() => cancelTimer?.());
          cleanup(() => {
            if (abortRegistered) signal?.removeEventListener("abort", abort);
          });
          cleanup(() => {
            worker.onmessage = null;
          });
          cleanup(() => {
            worker.onerror = null;
          });
          // This requests termination; it does not acknowledge physical exit.
          cleanup(() => worker.terminate());
          if (success) {
            resolve(value);
          } else {
            reject(
              value instanceof Error ? value : new Error(String(value)),
            );
          }
        };
        const abort = () =>
          finish(
            false,
            signal?.reason ?? new DOMException("Aborted", "AbortError"),
          );
        try {
          // Preserve the original budget: it begins after construction returns,
          // and includes module/WASM startup as well as jq execution.
          const cancel = schedule(
            () =>
              finish(
                false,
                new Error("jq exceeded its 5 second execution limit."),
              ),
            JQ_TIMEOUT_MS,
          );
          if (done) {
            cancel();
            return;
          }
          cancelTimer = cancel;
          if (signal) {
            abortRegistered = true;
            signal.addEventListener("abort", abort, { once: true });
          }
          if (done) return;
          worker.onmessage = (event) => {
            if (done) return;
            try {
              const message = event.data as Record<string, unknown>;
              if (message.ok !== true) {
                return finish(
                  false,
                  new Error(
                    `jq failed: ${String(message.error ?? "worker failure")}`,
                  ),
                );
              }
              const output = serialized(message.value, "Pipeline output");
              const values = JSON.parse(output) as unknown[];
              if (!Array.isArray(values) || values.length !== 1) {
                throw new Error(
                  `jq produced ${
                    Array.isArray(values) ? values.length : 0
                  } outputs; a pipeline stage requires exactly one.`,
                );
              }
              finish(true, values[0]);
            } catch (error) {
              finish(false, error);
            }
          };
          if (done) return;
          worker.onerror = (event) =>
            finish(false, new Error(`jq worker failed: ${event.message}`));
          if (done) return;
          if (signal?.aborted) {
            abort();
            return;
          }
          const request: JqWorkerRequest = { input: inputJson, filter };
          worker.postMessage(request);
        } catch (error) {
          finish(false, error);
        }
      });
    } finally {
      permit.release();
    }
  };
}

// The count bounds serialized waiting inputs, not total process memory. Each
// input is at most 1 MiB; filters, JS storage and physical cleanup add overhead.
const evaluate = createCoreJqEvaluator({
  admission: createJqAdmission({
    activeLimit: 1,
    pendingLimit: 128,
    waitMs: 30_000,
  }),
  createWorker: () =>
    new Worker(new URL("./jq-worker.ts", import.meta.url).href, {
      type: "module",
    }),
});

/** A bounded, one-shot Worker makes synchronous jq preemptible. */
export function evaluateCoreJq(
  input: unknown,
  filter: string,
  signal?: AbortSignal,
): Promise<unknown> {
  return evaluate(input, filter, signal);
}

function plain(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
/** Explicit downstream fields win while preserving nested values from jq. */
export function mergePipelineArguments(
  output: unknown,
  explicit: Record<string, unknown>,
): Record<string, unknown> {
  if (!plain(output)) {
    throw new Error(
      "Pipeline output must be a plain object before a tool stage.",
    );
  }
  const merge = (
    left: Record<string, unknown>,
    right: Record<string, unknown>,
  ): Record<string, unknown> => {
    const result: Record<string, unknown> = structuredClone(left);
    for (const [key, value] of Object.entries(right)) {
      if (["__proto__", "prototype", "constructor"].includes(key)) {
        throw new Error(`Pipeline argument key '${key}' is not allowed.`);
      }
      result[key] = plain(result[key]) && plain(value)
        ? merge(result[key] as Record<string, unknown>, value)
        : structuredClone(value);
    }
    return result;
  };
  return merge(output, explicit);
}
