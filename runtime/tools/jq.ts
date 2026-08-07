import { loadJq } from "../../dependencies/jq-wasm.ts";
import { serializePipelineValue } from "./pipeline.ts";

const DEFAULT_JQ_TIMEOUT_MS = 5_000;

type JqRuntime = Awaited<ReturnType<typeof loadJq>>;
let runtime: Promise<JqRuntime> | undefined;

function getRuntime(): Promise<JqRuntime> {
  runtime ??= loadJq();
  return runtime;
}

/** Evaluates one jq filter in-process through the portable WASM runtime. */
export async function evaluateJq(
  input: unknown,
  filter: string,
  timeoutMs = DEFAULT_JQ_TIMEOUT_MS,
): Promise<unknown> {
  if (!filter.trim()) throw new Error("jq filter is empty.");
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError("jq timeout must be positive.");
  }
  const inputJson = serializePipelineValue(input);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const results = await Promise.race([
      getRuntime().then((jq) => jq.json(inputJson, filter)),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`jq timed out after ${timeoutMs}ms.`)),
          timeoutMs,
        );
      }),
    ]);
    if (results.length === 0) throw new Error("jq produced no output.");
    if (results.length > 1) {
      throw new Error(
        `jq produced ${results.length} outputs; wrap the filter in [...] to produce one array value.`,
      );
    }
    return results[0];
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("jq ")) throw error;
    throw new Error(
      `jq failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

/** Clears the lazily loaded WASM runtime between isolated tests. */
export function resetJqRuntime(): void {
  runtime = undefined;
}
