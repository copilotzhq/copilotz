/** Small application React host for actual View definitions, not a package renderer. */
import { createViewResolver, snapshotViewData } from "@copilotz/copilotz/views";
import type { ReactNode } from "react";
import type { Root } from "react-dom/client";
import dashboard from "./views/dashboard/index.ts";
import type { Dashboard, ReactViewContext } from "./shared/ui.ts";
export function createReactViewHost(
  root: Root,
  commands: Readonly<Record<string, () => void | Promise<void>>>,
) {
  const resolve = createViewResolver({ dashboard });
  const lifetime = new AbortController();
  let revision = 0, evaluating = 0;
  const denied = () =>
    Promise.reject(
      new Error("Read-only View: use the host's authorized live selections."),
    );
  const actions = Object.fromEntries(
    Object.entries(commands).map(([name, command]) => [name, () => {
      lifetime.signal.throwIfAborted();
      if (evaluating) {
        throw new Error(
          "Actions are available only to later UI gestures, never View evaluation.",
        );
      }
      return command();
    }]),
  );
  return {
    async render(value: Dashboard) {
      lifetime.signal.throwIfAborted();
      const current = ++revision;
      const reference = { shows: { navigation: "demo" }, value: {} } as const;
      const view = resolve(reference.shows, "interactive", "react");
      if (!view) throw new Error("Dashboard View is not registered.");
      const context: ReactViewContext = {
        collections: {
          plan: { get: denied, list: denied },
          evidence: { get: denied, list: denied },
        },
        actions,
        resources: { demo: { model: "deterministic" } },
        scope: { viewer: "local-demo-viewer" },
        signal: lifetime.signal,
        hints: { renderer: "react", mode: "interactive" },
        show: () =>
          Promise.reject(new Error("This demo registers only its root View.")),
      };
      evaluating++;
      let rendered: ReactNode;
      try {
        rendered = await view.render(
          snapshotViewData(value) as never,
          context,
        ) as ReactNode;
      } finally {
        evaluating--;
      }
      if (!lifetime.signal.aborted && current === revision) {
        root.render(rendered);
      }
    },
    close() {
      revision++;
      lifetime.abort();
      root.unmount();
    },
  };
}
