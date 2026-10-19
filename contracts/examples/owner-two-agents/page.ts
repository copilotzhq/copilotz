/** Application page lifetime. Closing an observer never cancels durable work. */
import type { createCopilotzClient } from "@copilotz/copilotz/client";
import type { Dashboard, Row } from "./shared/ui.ts";
type Commands = Readonly<Record<string, () => void | Promise<void>>>;
type Host = { render(state: Dashboard): Promise<void>; close(): void };
type Bootstrap = {
  databaseSchema: string;
  capability: string;
  workerUrl: string;
};
type Dependencies = {
  createHost(commands: Commands): Host;
  createWorker(): Pick<
    Worker,
    "onmessage" | "onerror" | "postMessage" | "terminate"
  >;
  createClient: typeof createCopilotzClient;
  fetch: typeof fetch;
  storage: Pick<Storage, "getItem" | "setItem">;
  origin: string;
  randomId(): string;
};
export function createDemoPage(deps: Dependencies) {
  let state: Dashboard = {
    plans: [],
    evidence: [],
    connection: "Starting",
    notice: "",
    busy: false,
    runId: deps.storage.getItem("demo-run-id"),
    resets: 0,
    packageLabel: "Exact package details are in dist/package-proof.json",
  };
  let current: { close(): void } | undefined;
  const start = () => {
    if (current) return;
    const lifetime = new AbortController();
    const alive = () => !lifetime.signal.aborted;
    let worker: ReturnType<Dependencies["createWorker"]> | undefined;
    let observations: AbortController | undefined;
    let bootstrap: Bootstrap | undefined;
    let connectionGeneration = 0, viewGeneration = 0, runGeneration = 0;
    const update = (patch: Partial<Dashboard>) => {
      if (!alive()) return;
      state = { ...state, ...patch };
      // A render finishing during page teardown belongs to the old lifetime.
      void host.render(state).catch((error) => {
        if (alive()) console.error("View render failed", error);
      });
    };
    function connect() {
      if (!alive() || !bootstrap) return;
      const generation = ++connectionGeneration;
      worker?.terminate();
      update({ connection: "Connecting browser Worker" });
      const next = deps.createWorker();
      worker = next;
      next.onmessage = ({ data }) => {
        if (!alive() || generation !== connectionGeneration) return;
        if (data.ready) update({ connection: "Browser Worker ready" });
        if (data.error) {
          update({ connection: "Worker failed", notice: data.error });
        }
      };
      next.onerror = (event) => {
        if (alive() && generation === connectionGeneration) {
          update({ connection: "Worker failed", notice: event.message });
        }
      };
      next.postMessage(bootstrap);
    }
    function observe() {
      if (!alive() || !bootstrap) return;
      observations?.abort();
      observations = new AbortController();
      const signal = AbortSignal.any([lifetime.signal, observations.signal]);
      const generation = ++viewGeneration;
      const capability = bootstrap.capability;
      const client = deps.createClient({
        baseUrl: `${deps.origin}/api`,
        getRequestHeaders: () => ({ authorization: `Bearer ${capability}` }),
      });
      for (
        const [name, field, limit] of [["demo_plan", "plans", 20], [
          "demo_evidence",
          "evidence",
          60,
        ]] as const
      ) {
        void client.collections.observe(name, {
          query: { limit, order: { field: "createdAt", direction: "desc" } },
        }, {
          signal,
          onSnapshot(snapshot) {
            if (!alive() || generation !== viewGeneration || signal.aborted) {
              return;
            }
            if (!Array.isArray(snapshot.value)) {
              throw new Error("Expected a bounded owner Collection list.");
            }
            update({
              [field]: snapshot.value as Row[],
              resets: state.resets + (snapshot.reset ? 1 : 0),
            });
          },
        }).catch((error) => {
          if (alive() && !signal.aborted && generation === viewGeneration) {
            update({
              [field]: [],
              notice: `View unavailable: ${error}. Reconnect Views to retry.`,
            });
          }
        });
      }
    }
    async function run(runId: string) {
      if (!alive() || !bootstrap || state.busy) return;
      const generation = ++runGeneration;
      const observing = () => alive() && generation === runGeneration;
      deps.storage.setItem("demo-run-id", runId);
      update({
        busy: true,
        runId,
        notice:
          "Two-agent flow is running. The Views update from owner snapshots.",
      });
      try {
        const response = await deps.fetch("/demo/run", {
          method: "POST",
          signal: lifetime.signal,
          headers: {
            authorization: `Bearer ${bootstrap.capability}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ runId }),
        });
        if (!observing()) return;
        const result = await response.json();
        if (!observing()) return;
        if (!response.ok) throw new Error(result.error ?? response.statusText);
        update({
          notice: `Run settled. Replay uses the same ingress identities. ${
            result.completed.replies.join(" ")
          }`,
        });
      } catch (error) {
        if (observing()) {
          update({
            notice:
              `Run did not confirm success: ${error}. Reconnect the worker and replay the same run if needed.`,
          });
        }
      } finally {
        if (observing()) update({ busy: false });
      }
    }
    const host = deps.createHost({
      run: () => run(deps.randomId()),
      replay: () => state.runId ? run(state.runId) : undefined,
      disconnect() {
        if (!alive()) return;
        connectionGeneration++;
        worker?.terminate();
        worker = undefined;
        update({
          connection: "Worker disconnected",
          notice:
            "The browser worker was terminated. Reconnect to continue; owner state remains persisted.",
        });
      },
      reconnect: connect,
      refresh: observe,
    });
    current = {
      close() {
        // Fence first: late fetch/body/subscription/Worker results cannot touch a restored page.
        lifetime.abort();
        connectionGeneration++;
        viewGeneration++;
        runGeneration++;
        observations?.abort();
        worker?.terminate();
        host.close();
        state = {
          ...state,
          plans: [],
          evidence: [],
          busy: false,
          connection: "Restoring",
          notice: state.busy
            ? "Local run observation closed. The owner may have accepted the operation. Reconnect and replay the same run to establish its result."
            : state.notice,
        };
      },
    };
    update({ connection: "Starting", busy: false });
    void (async () => {
      try {
        const response = await deps.fetch("/bootstrap", {
          signal: lifetime.signal,
        });
        if (!alive()) return;
        if (!response.ok) throw new Error("Bootstrap denied.");
        const next: Bootstrap = await response.json();
        if (!alive()) return;
        bootstrap = next;
        observe();
        connect();
      } catch (error) {
        if (alive()) {
          update({ connection: "Startup failed", notice: String(error) });
        }
      }
    })();
  };
  const stop = () => {
    const previous = current;
    current = undefined;
    previous?.close();
  };
  return { start, stop };
}
/** Initial pageshow is harmless; BFCache restoration creates a fresh lifetime. */
export function attachPageLifecycle(
  target: Pick<EventTarget, "addEventListener" | "removeEventListener">,
  page: ReturnType<typeof createDemoPage>,
) {
  target.addEventListener("pagehide", page.stop);
  target.addEventListener("pageshow", page.start);
  page.start();
  return () => {
    target.removeEventListener("pagehide", page.stop);
    target.removeEventListener("pageshow", page.start);
    page.stop();
  };
}
