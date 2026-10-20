import type React from "react";
import { useState } from "react";
import { defineView } from "@copilotz/copilotz/views";
import type { ActionHandle, BrowserViewContext } from "@copilotz/copilotz/web";
import { Button, Textarea } from "@copilotz/copilotz/web/kit";
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
      id: crypto.randomUUID(),
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
          <Button
            type="button"
            variant="outline"
            disabled={stopping}
            onClick={() => {
              setStopping(true);
              active.cancel().catch((cause) => {
                setError(String(cause));
                setStopping(false);
              });
            }}
          >
            {stopping ? "Stopping…" : "Stop"}
          </Button>
        )}
      </div>
      {!sender && <p role="status">Sign in to send messages.</p>}
    </form>
  );
}
export default defineView<
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
