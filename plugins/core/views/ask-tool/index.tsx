/** @jsxRuntime classic */
/** @jsx React.createElement */
/** @jsxFrag React.Fragment */
// deno-lint-ignore verbatim-module-syntax -- classic JSX requires this runtime import.
import * as React from "react";
import { LoaderCircle, MessageCircle } from "lucide-react";
import { defineView, type ViewDefinition } from "@copilotz/copilotz/views";
import type { BrowserViewContext } from "@copilotz/copilotz/web";
import { identityColor } from "@copilotz/copilotz/web/kit";
import { parseToolInput } from "../../shared/chat-messages.ts";
import type { ToolCallView } from "../chat/context.tsx";

/** Core's `ask` tool, shown inline as the question one agent asks another. */
const view: ViewDefinition<ToolCallView, React.ReactNode, BrowserViewContext> =
  defineView<ToolCallView, React.ReactNode, BrowserViewContext>({
    id: "core.askToolCall",
    shows: "askToolCall",
    renderer: "react",
    modes: ["inline"],
    render(call) {
      const input = call.input ?? parseToolInput(call.rawInput) ?? {};
      const target = typeof input.target === "string"
        ? input.target.trim()
        : "";
      const message = typeof input.message === "string"
        ? input.message.trim()
        : "";
      const waiting = call.status === "streaming" || call.status === "running";
      return (
        <div
          data-slot="ask-tool"
          className="bg-muted/40 grid gap-1.5 rounded-xl border px-3.5 py-3 text-sm"
        >
          <p className="flex items-center gap-2 font-medium">
            <MessageCircle
              aria-hidden="true"
              className="text-muted-foreground size-4"
            />
            {target
              ? (
                <span style={{ color: identityColor(target.toLowerCase()) }}>
                  Asking @{target}
                </span>
              )
              : <span>Preparing a question…</span>}
            {waiting && (
              <LoaderCircle
                aria-label="Waiting for the answer"
                className="text-muted-foreground ml-auto size-3.5 animate-spin"
              />
            )}
          </p>
          {message && (
            <p className="text-foreground/90 leading-relaxed whitespace-pre-wrap">
              {message}
            </p>
          )}
          {call.error && <p className="text-destructive">{call.error}</p>}
        </div>
      );
    },
  });

export default view;
