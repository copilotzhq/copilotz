/** @jsxRuntime classic */
/** @jsx React.createElement */
/** @jsxFrag React.Fragment */
// deno-lint-ignore verbatim-module-syntax -- classic JSX requires this runtime import.
import * as React from "react";
import { defineView, type ViewDefinition } from "@copilotz/copilotz/views";
import type { BrowserViewContext } from "@copilotz/copilotz/web";
import type { ToolCallView } from "../chat/context.tsx";

/**
 * Hosts an app's tool renderer and feeds it the tool's live output. Only this
 * boundary re-renders as output streams; the conversation does not.
 */
const view: ViewDefinition<
  ToolCallView & { view: string },
  React.ReactNode,
  BrowserViewContext
> = defineView<
  ToolCallView & { view: string },
  React.ReactNode,
  BrowserViewContext
>({
  id: "core.toolCall",
  shows: "chatToolCall",
  renderer: "react",
  modes: ["inline"],
  render({ view: kind, ...call }, ctx) {
    const outputs = ctx.collections.threadOutputs?.get(call.threadId).value
      ?.outputs as Record<string, Record<string, string>> | undefined;
    const output = outputs?.[call.callId];
    return ctx.show({
      shows: kind,
      value: output ? { ...call, output } : call,
    }, { mode: "inline" }) as React.ReactNode;
  },
});

export default view;
