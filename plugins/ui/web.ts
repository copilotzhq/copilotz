import {
  type BrowserPlugin,
  type BrowserRuntime,
  urlReference,
} from "@copilotz/copilotz/web";
import type { ViewHints, ViewReference } from "@copilotz/copilotz/views";
import workspace from "./views/workspace/index.tsx";
import panes from "./views/panes/index.tsx";
import navigator from "./views/navigator/index.tsx";
import { type WorkspaceRegion, workspaceState } from "./workspace.ts";
export * from "./workspace.ts";
export { navigator, panes, workspace };
/** Workspace state and independently composable pane/navigation Views. */
export function uiWebPlugin(storage?: string): BrowserPlugin {
  return {
    id: "@copilotz/ui",
    collections: {
      workspace: {
        placement: "browser",
        storage,
        initial: [{ id: "main", focus: null, context: null, dialog: null }],
        commands: {
          open: {
            mutate({ current, input }) {
              const { source, region, mode } = input as {
                source?: string;
                region?: WorkspaceRegion;
                mode?: string;
              };
              let { reference } = input as { reference: ViewReference | null };
              // A URL open is URL state: identifiers only, opted-in Views only.
              if (source === "url") {
                reference = urlReference(reference);
                if (!reference) {
                  throw new TypeError("URL state carries identifiers only");
                }
              }
              if (region === "dialog" || mode === "dialog") {
                return { set: { dialog: reference } };
              }
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
          replace: {
            mutate: ({ input }) => ({
              set: {
                [regionOf(input)]:
                  (input as { reference: ViewReference | null }).reference,
              },
            }),
          },
          set: {
            mutate: ({ input }) => ({ set: { ...workspaceState(input) } }),
          },
          restore: {
            mutate: ({ input }) => ({ set: { ...workspaceState(input) } }),
          },
          swap: {
            mutate: ({ current }) => ({
              set: { focus: current.context, context: current.focus },
            }),
          },
          close: {
            mutate: ({ input }) => ({
              set: { [regionOf(input)]: null },
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
      uiReplace: {
        id: "ui.replace",
        placement: "browser",
        execute: (input, ctx) =>
          ctx.command("workspace", "main", "replace", input),
      },
      uiSet: {
        id: "ui.set",
        placement: "browser",
        execute: (input, ctx) => ctx.command("workspace", "main", "set", input),
      },
      uiRestore: {
        id: "ui.restore",
        placement: "browser",
        execute: (input, ctx) =>
          ctx.command("workspace", "main", "restore", input),
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
    views: { workspace, panes, navigator },
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

function regionOf(input: unknown): WorkspaceRegion {
  const region = (input as { region?: string }).region ?? "context";
  if (region !== "focus" && region !== "context" && region !== "dialog") {
    throw new TypeError("Unknown workspace region");
  }
  return region;
}
