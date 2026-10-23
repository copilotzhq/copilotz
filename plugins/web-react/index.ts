import React, { useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import type { ViewRendererAdapter } from "@copilotz/copilotz/views";
import type { Observation } from "@copilotz/copilotz/web";
/** The adapter receives already evaluated, automatically tracked View output. */
export function ObservedView(
  { output }: {
    output: Pick<Observation<unknown>, "getSnapshot" | "subscribe">;
  },
): React.ReactNode {
  return useSyncExternalStore(
    output.subscribe,
    output.getSnapshot,
    output.getSnapshot,
  ) as React.ReactNode;
}
export const reactRenderer: ViewRendererAdapter = {
  id: "react",
  view: (output, key) => React.createElement(ObservedView, { output, key }),
  mount(target, output) {
    const root = createRoot(target as Element);
    root.render(React.createElement(ObservedView, { output }));
    return {
      dispose() {
        root.unmount();
      },
    };
  },
};
