import type React from "react";
import { defineView } from "@copilotz/copilotz/views";
import type { BrowserViewContext } from "@copilotz/copilotz/web";
import {
  Metric,
  ReadStatus,
  ResourceTable,
  Screen,
} from "@copilotz/copilotz/web/kit";
export default defineView<unknown, React.ReactNode, BrowserViewContext>({
  id: "admin.overview",
  shows: "admin",
  renderer: "react",
  modes: ["full", "panel"],
  render(_item, ctx) {
    const threads = ctx.collections.thread.list({ limit: 100 });
    const people = ctx.collections.participant.list({ limit: 100 });
    return (
      <Screen title="Administration" density={ctx.hints.mode}>
        <ReadStatus state={threads} />
        <ReadStatus state={people} />
        <div className="grid gap-3 sm:grid-cols-2">
          <Metric label="Loaded conversations" value={threads.value.length} />
          <Metric label="Loaded participants" value={people.value.length} />
        </div>
        <ResourceTable
          rows={threads.value}
          columns={["title", "updatedAt"]}
          open={(row) =>
            ctx.show({ shows: "thread", value: { id: row.id } }, {
              source: "link",
            })}
        />
      </Screen>
    );
  },
});
