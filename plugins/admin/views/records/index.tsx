/** @jsxRuntime classic */
/** @jsx React.createElement */
/** @jsxFrag React.Fragment */
// deno-lint-ignore verbatim-module-syntax -- classic JSX requires this runtime import.
import * as React from "react";
import { defineView } from "@copilotz/copilotz/views";
import type { BrowserViewContext } from "@copilotz/copilotz/web";
import { ReadStatus, ResourceTable, Screen } from "@copilotz/copilotz/web/kit";
const view: import("@copilotz/copilotz/views").ViewDefinition<
  { collection: string; columns?: string[] },
  React.ReactNode,
  BrowserViewContext
> = defineView<
  { collection: string; columns?: string[] },
  React.ReactNode,
  BrowserViewContext
>({
  id: "admin.records",
  shows: "adminRecords",
  renderer: "react",
  modes: ["full", "panel"],
  render({ collection, columns = ["id", "name", "status"] }, ctx) {
    const reader = ctx.collections[collection];
    if (!reader) {
      return <Screen title="Collection unavailable" density={ctx.hints.mode} />;
    }
    const records = reader.list({ limit: 100 });
    return (
      <Screen title={collection} density={ctx.hints.mode}>
        <ReadStatus state={records} />
        <ResourceTable rows={records.value} columns={columns} />
      </Screen>
    );
  },
});

export default view;
