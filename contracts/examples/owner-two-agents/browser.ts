import { createRoot } from "react-dom/client";
import { createCopilotzClient } from "@copilotz/copilotz/client";
import { createReactViewHost } from "./view-host.ts";
import { attachPageLifecycle, createDemoPage } from "./page.ts";
attachPageLifecycle(
  globalThis,
  createDemoPage({
    createHost: (commands) =>
      createReactViewHost(
        createRoot(document.getElementById("app")!),
        commands,
      ),
    createWorker: () => new Worker("/worker.mjs", { type: "module" }),
    createClient: createCopilotzClient,
    fetch: globalThis.fetch.bind(globalThis),
    storage: localStorage,
    origin: location.origin,
    randomId: () => crypto.randomUUID(),
  }),
);
