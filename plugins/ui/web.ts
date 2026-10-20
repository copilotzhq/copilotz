import type { BrowserPlugin, BrowserRuntime } from "@copilotz/copilotz/web";
import type { ViewHints, ViewReference } from "@copilotz/copilotz/views";
import workspace from "./views/workspace/index.tsx";
/** URL restore is provided by the host's workspace storage adapter. */
export function uiWebPlugin(storage?: string): BrowserPlugin {
  return {
    id: "@copilotz/ui",
    collections: {
      workspace: {
        placement: "browser",
        storage,
        initial: [{ id: "main", focus: null, context: null }],
        commands: {
          open: {
            mutate({ current, input }) {
              const { reference, source, region } = input as {
                reference: ViewReference;
                source?: string;
                region?: string;
              };
              const focus = region === "focus" ||
                !region &&
                  ["navigator", "command", "url"].includes(source ?? "");
              return {
                set: focus
                  ? {
                    focus: reference,
                    context: current.focus ?? current.context,
                  }
                  : { context: reference },
              };
            },
          },
          swap: {
            mutate: ({ current }) => ({
              set: { focus: current.context, context: current.focus },
            }),
          },
          close: {
            mutate: ({ input }) => ({
              set: (input as { region: string }).region === "focus"
                ? { focus: null }
                : { context: null },
            }),
          },
        },
      },
    },
    actions: {
      uiOpen: {
        id: "ui.open",
        placement: "browser",
        execute: (input, ctx) =>
          ctx.command("workspace", "main", "open", input),
      },
      uiSwap: {
        id: "ui.swap",
        placement: "browser",
        execute: (input, ctx) =>
          ctx.command("workspace", "main", "swap", input),
      },
      uiClose: {
        id: "ui.close",
        placement: "browser",
        execute: (input, ctx) =>
          ctx.command("workspace", "main", "close", input),
      },
    },
    views: { workspace },
  };
}
export function workspaceNavigation(
  runtime: () => BrowserRuntime,
): (
  reference: ViewReference,
  hints: ViewHints,
) => import("@copilotz/copilotz/web").ActionHandle {
  return (reference: ViewReference, hints: ViewHints) =>
    runtime().actions.uiOpen({ reference, ...hints });
}
