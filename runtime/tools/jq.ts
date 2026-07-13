import { serializePipelineValue } from "@/runtime/tools/pipeline.ts";

interface JqWorkerResponse {
  id: string;
  results?: unknown[];
  error?: string;
}

interface PendingEvaluation {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: number;
}

const DEFAULT_JQ_TIMEOUT_MS = 5_000;
const pending = new Map<string, PendingEvaluation>();
let worker: Worker | null = null;

function rejectAll(error: Error): void {
  for (const request of pending.values()) {
    clearTimeout(request.timer);
    request.reject(error);
  }
  pending.clear();
}

function disposeWorker(): void {
  worker?.terminate();
  worker = null;
}

function getWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL("./jq-worker.ts", import.meta.url).href, {
    type: "module",
    name: "copilotz-jq",
  });
  worker.onmessage = (event: MessageEvent<JqWorkerResponse>) => {
    const request = pending.get(event.data.id);
    if (!request) return;
    pending.delete(event.data.id);
    clearTimeout(request.timer);
    try {
      if (event.data.error) {
        request.reject(new Error(`jq failed: ${event.data.error}`));
        return;
      }
      const results = event.data.results ?? [];
      if (results.length === 0) {
        request.reject(new Error("jq produced no output."));
      } else if (results.length > 1) {
        request.reject(
          new Error(
            `jq produced ${results.length} outputs; wrap the filter in [...] to produce one array value.`,
          ),
        );
      } else {
        request.resolve(results[0]);
      }
    } finally {
      // Deno workers cannot be unref'd. Release an idle worker so command-line
      // consumers can exit naturally after a pipeline completes.
      if (pending.size === 0) disposeWorker();
    }
  };
  worker.onerror = (event) => {
    const error = new Error(`jq worker failed: ${event.message}`);
    rejectAll(error);
    disposeWorker();
  };
  return worker;
}

export function evaluateJq(
  input: unknown,
  filter: string,
  timeoutMs = DEFAULT_JQ_TIMEOUT_MS,
): Promise<unknown> {
  if (!filter.trim()) return Promise.reject(new Error("jq filter is empty."));
  const inputJson = serializePipelineValue(input);
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (!pending.delete(id)) return;
      reject(new Error(`jq timed out after ${timeoutMs}ms.`));
      rejectAll(new Error("jq worker was restarted after a timeout."));
      disposeWorker();
    }, timeoutMs) as unknown as number;
    pending.set(id, { resolve, reject, timer });
    getWorker().postMessage({ id, inputJson, filter });
  });
}

export function disconnectJqWorker(): void {
  rejectAll(new Error("jq worker disconnected."));
  disposeWorker();
}
