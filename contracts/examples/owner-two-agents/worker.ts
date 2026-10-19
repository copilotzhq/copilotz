/// <reference lib="webworker" />
import { createCopilotz } from "@copilotz/copilotz/worker";
import { demoPlugin } from "./composition.ts";
import { assertBrowserWorker } from "./shared/browser.ts";
assertBrowserWorker();
let worker: Awaited<ReturnType<typeof createCopilotz>> | undefined;
self.onmessage = async ({ data }) => {
  try {
    if (data.close) {
      await worker?.close("user_disconnect");
      self.postMessage({ closed: true });
      return;
    }
    if (worker) throw new Error("Worker already started.");
    worker = await createCopilotz({
      role: "worker",
      id: "demo-worker",
      namespace: "owner-demo",
      databaseSchema: data.databaseSchema,
      plugins: [demoPlugin],
      capacity: 8,
      transport: {
        type: "websocket",
        config: { url: data.workerUrl, allowInsecureLoopback: true },
      },
      activate: () => ({
        workerId: "demo-worker",
        attemptId: crypto.randomUUID(),
        epoch: 1,
      }),
      register: () => ({
        credential: { kind: "registration", capability: data.capability },
        expiresAtMs: Date.now() + 3600000,
      }),
      handshake() {},
    });
    await worker.ready;
    self.postMessage({ ready: true, runtime: "dedicated-browser-worker" });
  } catch (error) {
    self.postMessage({ error: String(error) });
  }
};
