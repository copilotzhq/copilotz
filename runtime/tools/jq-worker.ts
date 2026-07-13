import { loadJq } from "jq-wasm";

interface JqWorkerRequest {
  id: string;
  inputJson: string;
  filter: string;
}

interface JqWorkerResponse {
  id: string;
  results?: unknown[];
  error?: string;
}

const jqPromise = loadJq();

self.onmessage = async (event: MessageEvent<JqWorkerRequest>) => {
  const { id, inputJson, filter } = event.data;
  try {
    const jq = await jqPromise;
    const results = jq.json(inputJson, filter);
    self.postMessage({ id, results } satisfies JqWorkerResponse);
  } catch (error) {
    self.postMessage(
      {
        id,
        error: error instanceof Error ? error.message : String(error),
      } satisfies JqWorkerResponse,
    );
  }
};
