/** @jsxRuntime classic */
/** @jsx React.createElement */
/** @jsxFrag React.Fragment */
// deno-lint-ignore verbatim-module-syntax -- classic JSX requires this runtime import.
import * as React from "react";
import { defineView, type ViewDefinition } from "@copilotz/copilotz/views";
import type { BrowserViewContext } from "@copilotz/copilotz/web";
import { readThread } from "../reads.ts";
import { chatConfig, readSenders } from "../chat/context.tsx";
import { Composer, type MentionTarget } from "../chat/composer.tsx";
import { startConversation } from "../chat/start.ts";

/** The draft key: the thread, or a new conversation (optionally in a Space). */
export function draftKey(threadId?: string, spaceId?: string): string {
  return threadId ?? `new:${spaceId ?? ""}`;
}

const view: ViewDefinition<
  { threadId?: string; spaceId?: string },
  React.ReactNode,
  BrowserViewContext
> = defineView<
  { threadId?: string; spaceId?: string },
  React.ReactNode,
  BrowserViewContext
>({
  id: "core.composer",
  shows: "composer",
  renderer: "react",
  modes: ["full", "panel"],
  render({ threadId, spaceId }, ctx) {
    const config = chatConfig(ctx);
    const key = draftKey(threadId, spaceId);
    const draft = ctx.collections.draft.get(key);
    const run = threadId
      ? ctx.collections.threadRun?.get(threadId).value
      : undefined;
    const thread = threadId ? readThread(ctx, threadId).value : undefined;
    const participants = Array.isArray(thread?.participantIds)
      ? thread.participantIds.map(String)
      : [];
    const targets: MentionTarget[] = [...readSenders(ctx, participants)]
      .flatMap(([id, sender]) =>
        sender.type === "agent" ? [{ id, name: sender.name, sender }] : []
      );
    const send = ctx.actions.chatSend;
    const disabledReason = !config.self
      ? "Sign in to send messages."
      : !send
      ? "Sending is not available here."
      : thread?.status === "archived"
      ? "This conversation is archived. Restore it to reply."
      : undefined;
    const generating = Array.isArray(run?.active) && run.active.length > 0;
    return (
      <Composer
        key={key}
        value={String(draft.value?.text ?? "")}
        onChange={(text) => ctx.actions.setDraft({ threadId: key, text })}
        disabledReason={disabledReason}
        generating={generating}
        stopping={run?.stopping === true}
        onStop={() => void ctx.actions.chatStop?.({ threadId }).result()}
        targets={targets}
        attachments={config.features.attachments}
        voice={config.features.voice}
        autoFocus={!threadId}
        labels={{
          placeholder: config.labels.composerPlaceholder ??
            (targets.length > 1
              ? "Message the team, or @mention an agent…"
              : "Message…"),
          help: config.labels.composerHelp,
          footer: config.labels.footer,
        }}
        onSubmit={async ({ text, files, recipientIds }) => {
          ctx.actions.setDraft({ threadId: key, text: "" });
          if (!threadId) {
            try {
              await startConversation(ctx, {
                text,
                files,
                recipientIds,
                ...(spaceId ? { spaceId } : {}),
              });
            } catch (error) {
              ctx.actions.setDraft({ threadId: key, text });
              throw error;
            }
            return;
          }
          // A failed send stays in the conversation with Retry.
          await send({ threadId, text, files, recipientIds }).result()
            .catch(() => {});
        }}
      />
    );
  },
});

export default view;
