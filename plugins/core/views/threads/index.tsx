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
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  Input,
  ReadStatus,
  ResourceTable,
  Screen,
} from "@copilotz/copilotz/web/kit";
function CreateConversation({ ctx }: { ctx: BrowserViewContext }) {
  const [open, setOpen] = useState(false), [name, setName] = useState("");
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>New conversation</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New conversation</DialogTitle>
        </DialogHeader>
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (busy) return;
            const id = crypto.randomUUID();
            setBusy(true);
            setError("");
            ctx.actions.createThread({
              id,
              name,
              participants: ctx.resources.chat?.sender
                ? [ctx.resources.chat.sender]
                : [],
            }).result().then(() => {
              setOpen(false);
              setName("");
              ctx.show({ shows: "thread", value: { id } }, {
                source: "navigator",
              });
            }, (cause) => setError(String(cause))).finally(() =>
              setBusy(false)
            );
          }}
        >
          <Input
            aria-label="Conversation title"
            value={name}
            onChange={(event) =>
              setName((event.target as unknown as { value: string }).value)}
          />
          {error && <p role="alert">{error}</p>}
          <Button disabled={busy || !name.trim()}>
            {busy ? "Creating…" : "Create"}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
const view: import("@copilotz/copilotz/views").ViewDefinition<
  unknown,
  React.ReactNode,
  BrowserViewContext
> = defineView<unknown, React.ReactNode, BrowserViewContext>({
  id: "core.threads",
  shows: { list: "thread" },
  renderer: "react",
  modes: ["full", "panel"],
  url: true,
  render(_item, ctx) {
    const threads = ctx.collections.thread.list({ limit: 100 });
    return (
      <Screen
        title="Conversations"
        density={ctx.hints.mode}
        actions={<CreateConversation ctx={ctx} />}
      >
        <ReadStatus state={threads} />
        <ResourceTable
          rows={threads.value}
          columns={["name", "updatedAt"]}
          open={(row) =>
            ctx.show({ shows: "thread", value: { id: row.id } }, {
              source: "navigator",
            })}
        />
      </Screen>
    );
  },
});

export default view;
