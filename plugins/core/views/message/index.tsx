/** @jsxRuntime classic */
/** @jsx React.createElement */
/** @jsxFrag React.Fragment */
// deno-lint-ignore verbatim-module-syntax -- classic JSX requires this runtime import.
import * as React from "react";
import { defineView } from "@copilotz/copilotz/views";
import type { BrowserViewContext, Row } from "@copilotz/copilotz/web";
import { Badge, Card, CardContent, Markdown } from "@copilotz/copilotz/web/kit";
/** Canonical inline text parts only; large content references remain references. */
export function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map(messageText).join("\n");
  if (content && typeof content === "object") {
    const part = content as Record<string, unknown>;
    return typeof part.text === "string"
      ? part.text
      : typeof part.value === "string" &&
          (part.type === "text" || part.kind === "text")
      ? part.value
      : "";
  }
  return "";
}
const view: import("@copilotz/copilotz/views").ViewDefinition<
  Row,
  React.ReactNode,
  BrowserViewContext
> = defineView<Row, React.ReactNode, BrowserViewContext>({
  id: "core.message",
  shows: "message",
  renderer: "react",
  modes: ["full", "panel"],
  render(message, ctx) {
    return (
      <Card data-density={ctx.hints.mode}>
        <CardContent className="space-y-2">
          <Badge variant="secondary">
            {String(message.role ?? message.senderName ?? "Message")}
          </Badge>
          <Markdown>{messageText(message.content)}</Markdown>
          {message.status === "streaming" && <p role="status">Writing…</p>}
        </CardContent>
      </Card>
    );
  },
});

export default view;
