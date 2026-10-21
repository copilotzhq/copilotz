/** @jsxRuntime classic */
/** @jsx React.createElement */
// deno-lint-ignore verbatim-module-syntax -- classic JSX requires this runtime import.
import * as React from "react";
import { defineView } from "@copilotz/copilotz/views";
import type { BrowserViewContext } from "@copilotz/copilotz/web";
import { DetailList, Frame, ReadStatus } from "@copilotz/copilotz/web/kit";

const view: import("@copilotz/copilotz/views").ViewDefinition<
  { id: string },
  React.ReactNode,
  BrowserViewContext
> = defineView<{ id: string }, React.ReactNode, BrowserViewContext>({
  id: "admin.participant",
  shows: "participant",
  renderer: "react",
  modes: ["full", "panel", "dialog"],
  url: true,
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
        <ReadStatus state={state} noun="participant" />
        {participant && (
          <DetailList
            items={[
              ["Type", participant.participantType],
              ["External ID", participant.externalId],
              ["Namespace", participant.namespace],
              ["Created", participant.createdAt],
              ["Updated", participant.updatedAt],
              ["ID", <code key="id" className="text-xs">{id}</code>],
            ]}
          />
        )}
      </Frame>
    );
  },
});

export default view;
