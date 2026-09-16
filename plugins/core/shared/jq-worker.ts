import { loadJq } from "../../../dependencies/jq-wasm.ts";

export async function runJqWorker(
  input: string,
  filter: string,
): Promise<unknown> {
  const jq = await loadJq();
  return await jq.json(input, filter);
}

const workerGlobal = globalThis as unknown as {
  postMessage?: (value: unknown) => void;
  onmessage?: (
    event: MessageEvent<{ input: string; filter: string }>,
  ) => void | Promise<void>;
};

if (typeof workerGlobal.postMessage === "function") {
  workerGlobal.onmessage = async (event) => {
    try {
      const value = await runJqWorker(event.data.input, event.data.filter);
      workerGlobal.postMessage?.({ ok: true, value });
    } catch (error) {
      workerGlobal.postMessage?.({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };
}
