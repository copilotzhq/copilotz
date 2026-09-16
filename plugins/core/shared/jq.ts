const MAX_JQ_BYTES = 1024 * 1024;
const JQ_TIMEOUT_MS = 5_000;
// Static reachability also keeps the Worker implementation in the package
// graph; execution remains isolated in the Worker created below.
import { runJqWorker } from "./jq-worker.ts";
void runJqWorker;

function serialized(value: unknown, label: string): string {
  let result: string;
  try {
    result = JSON.stringify(value);
  } catch (error) {
    throw new Error(`${label} must be JSON-compatible: ${String(error)}`);
  }
  if (new TextEncoder().encode(result).byteLength > MAX_JQ_BYTES) {
    throw new Error(`${label} exceeds the 1 MiB jq limit.`);
  }
  return result;
}

/** A one-shot Worker makes synchronous jq preemptible and bounds every lease. */
export async function evaluateCoreJq(
  input: unknown,
  filter: string,
  signal?: AbortSignal,
): Promise<unknown> {
  if (!filter.trim()) throw new Error("jq filter is empty.");
  if (signal?.aborted) {
    throw signal.reason ?? new DOMException("Aborted", "AbortError");
  }
  const inputJson = serialized(input, "Pipeline input");
  const worker = new Worker(new URL("./jq-worker.ts", import.meta.url).href, {
    type: "module",
  });
  try {
    return await new Promise<unknown>((resolve, reject) => {
      let done = false;
      const close = () => {
        if (!done) {
          done = true;
          worker.terminate();
        }
      };
      const fail = (error: unknown) => {
        close();
        reject(error instanceof Error ? error : new Error(String(error)));
      };
      const timer = setTimeout(
        () => fail(new Error("jq exceeded its 5 second execution limit.")),
        JQ_TIMEOUT_MS,
      );
      const abort = () =>
        fail(signal?.reason ?? new DOMException("Aborted", "AbortError"));
      signal?.addEventListener("abort", abort, { once: true });
      worker.onmessage = (event: MessageEvent<unknown>) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        const message = event.data as Record<string, unknown>;
        if (message.ok !== true) {
          return fail(
            new Error(
              `jq failed: ${String(message.error ?? "worker failure")}`,
            ),
          );
        }
        try {
          const output = serialized(message.value, "Pipeline output");
          const values = JSON.parse(output) as unknown[];
          if (!Array.isArray(values) || values.length !== 1) {
            throw new Error(
              `jq produced ${
                Array.isArray(values) ? values.length : 0
              } outputs; a pipeline stage requires exactly one.`,
            );
          }
          close();
          resolve(values[0]);
        } catch (error) {
          fail(error);
        }
      };
      worker.onerror = (event) =>
        fail(new Error(`jq worker failed: ${event.message}`));
      worker.postMessage({ input: inputJson, filter });
    });
  } finally {
    worker.terminate();
  }
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
