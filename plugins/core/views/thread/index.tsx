import type React from "react";
import { useState } from "react";
import { defineView } from "@copilotz/copilotz/views";
import type { BrowserViewContext } from "@copilotz/copilotz/web";
import {
  Button,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  ReadStatus,
  Screen,
  Textarea,
} from "@copilotz/copilotz/web/kit";
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
          id: crypto.randomUUID(),
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
  const [open, setOpen] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="ghost">Clear messages</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Clear this conversation?</DialogTitle>
        </DialogHeader>
        <p>This removes the messages in this conversation.</p>
        {error && <p role="alert">{error}</p>}
        <Button
          variant="destructive"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            setError("");
            ctx.actions.deleteMessages({ threadId }).result().then(
              () => setOpen(false),
              (cause) => setError(String(cause)),
            ).finally(() => setBusy(false));
          }}
        >
          {busy ? "Clearing…" : "Clear messages"}
        </Button>
      </DialogContent>
    </Dialog>
  );
}
export default defineView<{ id: string }, React.ReactNode, BrowserViewContext>({
  id: "core.thread",
  shows: "thread",
  renderer: "react",
  modes: ["full", "panel"],
  render({ id }, ctx) {
    const thread = ctx.collections.thread.get(id);
    const messages = ctx.collections.message.list({
      where: { threadId: id },
      limit: 100,
    }, {
      content: {
        fields: ["content"],
        byteLimit: 262144,
        exclude: [
          { kind: "image" },
          { kind: "audio" },
          { kind: "video" },
          { kind: "file" },
          { kind: "json" },
        ],
      },
    });
    return (
      <Screen
        title={String(thread.value?.title ?? "Conversation")}
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
