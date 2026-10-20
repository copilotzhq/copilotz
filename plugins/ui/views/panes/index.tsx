/** @jsxRuntime classic */
/** @jsx React.createElement */
// deno-lint-ignore verbatim-module-syntax -- classic JSX requires this runtime import.
import * as React from "react";
import { defineView, type ViewReference } from "@copilotz/copilotz/views";
import type { BrowserViewContext } from "@copilotz/copilotz/web";
import {
  Button,
  Dialog,
  DialogContent,
  DialogTitle,
  showSafely,
} from "@copilotz/copilotz/web/kit";

const view: import("@copilotz/copilotz/views").ViewDefinition<
  unknown,
  React.ReactNode,
  BrowserViewContext
> = defineView<unknown, React.ReactNode, BrowserViewContext>({
  id: "ui.panes",
  shows: "workspacePanes",
  renderer: "react",
  modes: ["full", "panel"],
  render(_item, ctx) {
    const workspace = ctx.collections.workspace.get("main").value;
    const focus = workspace?.focus as ViewReference | null;
    const context = workspace?.context as ViewReference | null;
    const dialog = workspace?.dialog as ViewReference | null;
    return (
      <div
        data-slot="workspace-panes"
        className={context
          ? "grid min-h-0 gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]"
          : "grid min-h-0 gap-4"}
      >
        <main aria-label="Focus" className="min-w-0">
          {focus && (
            <Button
              type="button"
              variant="ghost"
              onClick={() => ctx.actions.uiClose({ region: "focus" })}
            >
              Close focus
            </Button>
          )}
          {focus
            ? showSafely(ctx, focus, { mode: "full" }, "Focus")
            : <p>Select a view to get started.</p>}
        </main>
        {context && (
          <aside aria-label="Context" className="min-w-0">
            <div className="flex gap-2">
              <Button
                type="button"
                variant="outline"
                aria-label="Swap focus and context"
                onClick={() => ctx.actions.uiSwap({})}
              >
                ⇄
              </Button>
              <Button
                type="button"
                variant="ghost"
                onClick={() => ctx.actions.uiClose({ region: "context" })}
              >
                Close context
              </Button>
            </div>
            {showSafely(ctx, context, { mode: "panel" }, "Context")}
          </aside>
        )}
        {dialog && (
          <Dialog
            open
            onOpenChange={(open) => {
              if (!open) ctx.actions.uiClose({ region: "dialog" });
            }}
          >
            <DialogContent className="h-dvh max-w-full overflow-y-auto rounded-none sm:h-auto sm:max-h-[90dvh] sm:max-w-2xl sm:rounded-lg">
              <DialogTitle className="sr-only">Workspace dialog</DialogTitle>
              {showSafely(ctx, dialog, { mode: "dialog" }, "Dialog")}
            </DialogContent>
          </Dialog>
        )}
      </div>
    );
  },
});

export default view;
