/** @jsxRuntime classic */
/** @jsx React.createElement */
/** @jsxFrag React.Fragment */
// deno-lint-ignore verbatim-module-syntax -- classic JSX requires this runtime import.
import * as React from "react";
import { useState } from "react";
import { defineView } from "@copilotz/copilotz/views";
import type { ActionHandle, BrowserViewContext } from "@copilotz/copilotz/web";
import { Button, ConfirmAction, Textarea } from "@copilotz/copilotz/web/kit";
import { monotonicUlid } from "../../../../dependencies/ulid.ts";
function Composer(
  { threadId, text, ctx }: {
    threadId: string;
    text: string;
    ctx: BrowserViewContext;
  },
) {
  const [active, setActive] = useState<ActionHandle | null>(null);
  const [error, setError] = useState("");
  const [stopping, setStopping] = useState(false);
  const sender = ctx.resources.chat?.sender;
  const send = (event: React.FormEvent) => {
    event.preventDefault();
    if (!text.trim() || active) return;
    const handle = ctx.actions.sendMessage({
      // Time-ordered, so message ids sort in the order they were written.
      id: monotonicUlid(),
      threadId,
      sender,
      content: [{ type: "text", text }],
    });
    setActive(handle);
    setError("");
    handle.result().then(() => {
      if (ctx.collections.draft.get(threadId).value?.text === text) {
        ctx.actions.setDraft({ threadId, text: "" });
      }
    }, (cause) => setError(String(cause))).finally(() => {
      setActive(null);
      setStopping(false);
    });
  };
  return (
    <form onSubmit={send} className="space-y-2" aria-label="Message composer">
      <Textarea
        aria-label="Message"
        value={text}
        placeholder="Write a message…"
        disabled={Boolean(active)}
        onChange={(event) =>
          ctx.actions.setDraft({
            threadId,
            text: (event.target as unknown as { value: string }).value,
          })}
      />
      {error && <p role="alert">{error}</p>}
      <div className="flex gap-2">
        <Button
          type="submit"
          disabled={!sender || !text.trim() || Boolean(active)}
        >
          Send
        </Button>
        {active && (
          <ConfirmAction
            trigger={
              <Button type="button" variant="outline" disabled={stopping}>
                {stopping ? "Stopping…" : "Stop"}
              </Button>
            }
            title="Stop this response?"
            description="This cancels the active response. Messages already received remain in the conversation."
            confirmLabel="Stop response"
            destructive
            onConfirm={async () => {
              setStopping(true);
              try {
                await active.cancel();
                return true;
              } catch (cause) {
                setStopping(false);
                throw cause;
              }
            }}
          />
        )}
      </div>
      {!sender && <p role="status">Sign in to send messages.</p>}
    </form>
  );
}
const view: import("@copilotz/copilotz/views").ViewDefinition<
  { threadId: string },
  React.ReactNode,
  BrowserViewContext
> = defineView<
  { threadId: string },
  React.ReactNode,
  BrowserViewContext
>({
  id: "core.composer",
  shows: "composer",
  renderer: "react",
  modes: ["full", "panel"],
  render({ threadId }, ctx) {
    const draft = ctx.collections.draft.get(threadId);
    return (
      <Composer
        key={threadId}
        threadId={threadId}
        text={String(draft.value?.text ?? "")}
        ctx={ctx}
      />
    );
  },
});

export default view;
