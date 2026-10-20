/** @jsxRuntime classic */
/** @jsx React.createElement */
// deno-lint-ignore verbatim-module-syntax -- classic JSX requires this runtime import.
import * as React from "react";
import { defineView } from "@copilotz/copilotz/views";
import type { BrowserViewContext } from "@copilotz/copilotz/web";
import { Screen } from "@copilotz/copilotz/web/kit";
const view: import("@copilotz/copilotz/views").ViewDefinition<
  unknown,
  React.ReactNode,
  BrowserViewContext
> = defineView<unknown, React.ReactNode, BrowserViewContext>({
  id: "ui.workspace",
  shows: "workspace",
  renderer: "react",
  modes: ["full", "panel"],
  render(_item, ctx) {
    return (
      <Screen title="Workspace" density={ctx.hints.mode}>
        {ctx.show({
          shows: "workspaceNavigator",
          value: null,
        }) as React.ReactNode}
        {ctx.show({ shows: "workspacePanes", value: null }) as React.ReactNode}
      </Screen>
    );
  },
});

export default view;
