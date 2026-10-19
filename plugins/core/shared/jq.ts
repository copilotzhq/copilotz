const MAX_JQ_BYTES = 1024 * 1024;
const JQ_TIMEOUT_MS = 5_000;
// Keep the worker in the published type graph without installing its message
// handler or loading WASM in the application importing Core.
import type { JqWorkerRequest } from "./jq-worker.ts";

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

let active = false;
/** One preemptible evaluation; excess work refuses before retaining its input. */
export async function evaluateCoreJq(
  input: unknown,
  filter: string,
  signal?: AbortSignal,
): Promise<unknown> {
  signal?.throwIfAborted();
  if (!filter.trim()) throw new Error("jq filter is empty.");
  if (active) throw new Error("jq capacity is full.");
  active = true;
  let worker: Worker | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  try {
    const inputJson = serialized(input, "Pipeline input");
    signal?.throwIfAborted();
    worker = new Worker(new URL("./jq-worker.ts", import.meta.url).href, {
      type: "module",
    });
    return await new Promise<unknown>((resolve, reject) => {
      abort = () =>
        reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
      signal?.addEventListener("abort", abort, { once: true });
      timer = setTimeout(
        () => reject(new Error("jq exceeded its 5 second execution limit.")),
        JQ_TIMEOUT_MS,
      );
      worker!.onerror = (event) =>
        reject(new Error(`jq worker failed: ${event.message}`));
      worker!.onmessage = (event) => {
        try {
          const message = event.data as Record<string, unknown>;
          if (message.ok !== true) {
            throw new Error(
              `jq failed: ${String(message.error ?? "worker failure")}`,
            );
          }
          const values = JSON.parse(
            serialized(message.value, "Pipeline output"),
          );
          if (!Array.isArray(values) || values.length !== 1) {
            throw new Error(
              `jq produced ${
                Array.isArray(values) ? values.length : 0
              } outputs; a pipeline stage requires exactly one.`,
            );
          }
          resolve(values[0]);
        } catch (error) {
          reject(error);
        }
      };
      signal?.throwIfAborted();
      const request: JqWorkerRequest = { input: inputJson, filter };
      worker!.postMessage(request);
    });
  } finally {
    clearTimeout(timer);
    if (abort) signal?.removeEventListener("abort", abort);
    worker?.terminate();
    active = false;
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
