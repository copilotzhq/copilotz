/** @jsxRuntime classic */
/** @jsx React.createElement */
import * as React from "react";
import { defineView } from "@copilotz/copilotz/views";
import type { BrowserViewContext } from "@copilotz/copilotz/web";
import { Frame, ReadStatus } from "@copilotz/copilotz/web/kit";

const view: import("@copilotz/copilotz/views").ViewDefinition<
  { id: string },
  React.ReactNode,
  BrowserViewContext
> = defineView<{ id: string }, React.ReactNode, BrowserViewContext>({
  id: "admin.participant",
  shows: "participant",
  renderer: "react",
  modes: ["full", "panel", "dialog"],
  render({ id }, ctx) {
    const state = ctx.collections.participant.get(id);
    const participant = state.value;
    return (
      <Frame
        ctx={ctx}
        title={String(
          participant?.name ?? participant?.externalId ?? "Participant",
        )}
      >
        <ReadStatus state={state} />
        {participant && (
          <dl className="grid gap-3">
            {[
              "id",
              "externalId",
              "participantType",
              "namespace",
              "createdAt",
              "updatedAt",
            ].map((field) => (
              <React.Fragment key={field}>
                <dt>{field}</dt>
                <dd>{String(participant[field] ?? "—")}</dd>
              </React.Fragment>
            ))}
          </dl>
        )}
      </Frame>
    );
  },
});

export default view;
