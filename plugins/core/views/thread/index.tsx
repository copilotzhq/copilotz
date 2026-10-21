/** @jsxRuntime classic */
/** @jsx React.createElement */
/** @jsxFrag React.Fragment */
// deno-lint-ignore verbatim-module-syntax -- classic JSX requires this runtime import.
import * as React from "react";
import { useState } from "react";
import { defineView } from "@copilotz/copilotz/views";
import type { BrowserViewContext } from "@copilotz/copilotz/web";
import {
  Button,
  ConfirmAction,
  ReadStatus,
  Screen,
  Textarea,
} from "@copilotz/copilotz/web/kit";
import { monotonicUlid } from "../../../../dependencies/ulid.ts";
function Revise(
  { id, threadId, ctx }: {
    id: string;
    threadId: string;
    ctx: BrowserViewContext;
  },
) {
  const [editing, setEditing] = useState(false),
    [text, setText] = useState(""),
    [error, setError] = useState("");
  if (!editing) {
    return (
      <Button
        variant="ghost"
        size="sm"
        onClick={() => setEditing(true)}
      >
        Revise
      </Button>
    );
  }
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        ctx.actions.reviseMessage({
          id: monotonicUlid(),
          messageId: id,
          threadId,
          content: [{ type: "text", text }],
        }).result().then(
          () => setEditing(false),
          (error) => setError(String(error)),
        );
      }}
    >
      <Textarea
        aria-label="Revised message"
        value={text}
        onChange={(event) =>
          setText((event.target as unknown as { value: string }).value)}
      />
      <Button disabled={!text.trim()}>Save revision</Button>
      <Button type="button" variant="ghost" onClick={() => setEditing(false)}>
        Cancel
      </Button>
      {error && <p role="alert">{error}</p>}
    </form>
  );
}
function ClearConversation(
  { threadId, ctx }: { threadId: string; ctx: BrowserViewContext },
) {
  return (
    <ConfirmAction
      trigger={<Button type="button" variant="ghost">Clear messages</Button>}
      title="Clear this conversation?"
      description="This removes the messages in this conversation."
      confirmLabel="Clear messages"
      destructive
      onConfirm={async () => {
        await ctx.actions.deleteThreadMessages({ threadId }).result();
        return true;
      }}
    />
  );
}

const view: import("@copilotz/copilotz/views").ViewDefinition<
  { id: string },
  React.ReactNode,
  BrowserViewContext
> = defineView<{ id: string }, React.ReactNode, BrowserViewContext>({
  id: "core.thread",
  shows: "thread",
  renderer: "react",
  modes: ["full", "panel"],
  url: true,
  render({ id }, ctx) {
    const thread = ctx.collections.thread.get(id);
    const messages = readThreadMessages(ctx, id);
    return (
      <Screen
        title={String(thread.value?.name ?? "Conversation")}
        density={ctx.hints.mode}
        actions={<ClearConversation threadId={id} ctx={ctx} />}
      >
        <ReadStatus state={thread} />
        <ReadStatus state={messages} />
        <div role="log" aria-label="Messages" className="space-y-3">
          {messages.value.map((message) => (
            <div key={message.id}>
              {ctx.show({
                shows: "message",
                value: message,
              }) as React.ReactNode}
              {ctx.actions.reviseMessage && (
                <Revise id={message.id} threadId={id} ctx={ctx} />
              )}
            </div>
          ))}
        </div>
        {!messages.value.length && messages.status === "ready" && (
          <p>Start a conversation.</p>
        )}
        {ctx.show({
          shows: "composer",
          value: { threadId: id },
        }) as React.ReactNode}
      </Screen>
    );
  },
});

import { readThreadMessages } from "../reads.ts";

export default view;
