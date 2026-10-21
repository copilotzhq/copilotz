/** @jsxRuntime classic */
/** @jsx React.createElement */
/** @jsxFrag React.Fragment */
// deno-lint-ignore verbatim-module-syntax -- classic JSX requires this runtime import.
import * as React from "react";
import { Bot } from "lucide-react";
import { defineView, type ViewDefinition } from "@copilotz/copilotz/views";
import type { BrowserViewContext } from "@copilotz/copilotz/web";
import type { FeedAttempt } from "../../shared/chat-feed.ts";
import {
  type ChatSender,
  groupMessages,
  liveMessage,
} from "../../shared/chat-messages.ts";
import { chatConfig, presentTools } from "../chat/context.tsx";
import { MessageGroup } from "../chat/message.tsx";

function Working(): React.ReactElement {
  return (
    <div role="status" className="flex items-center gap-3 pt-6">
      <span className="bg-muted text-muted-foreground flex size-8 items-center justify-center rounded-full">
        <Bot aria-hidden="true" className="size-4" />
      </span>
      <span className="flex items-center gap-1" aria-hidden="true">
        {[0, 1, 2].map((dot) => (
          <span
            key={dot}
            className="bg-muted-foreground/70 size-1.5 animate-bounce rounded-full"
            style={{ animationDelay: `${dot * 140}ms` }}
          />
        ))}
      </span>
      <span className="sr-only">An agent is working on a reply</span>
    </div>
  );
}

/**
 * The replies still arriving in a thread, from the thread feed. Only this
 * View re-renders as text streams; the persisted history does not.
 */
const view: ViewDefinition<
  { threadId: string; settled?: readonly string[] },
  React.ReactNode,
  BrowserViewContext
> = defineView<
  { threadId: string; settled?: readonly string[] },
  React.ReactNode,
  BrowserViewContext
>({
  id: "core.threadLive",
  shows: "threadLive",
  renderer: "react",
  modes: ["full", "panel"],
  render({ threadId, settled = [] }, ctx) {
    const feed = ctx.collections.threadFeed?.get(threadId).value;
    const run = ctx.collections.threadRun?.get(threadId).value;
    const done = new Set(settled);
    const attempts =
      (Array.isArray(feed?.attempts) ? feed.attempts as FeedAttempt[] : [])
        .filter((attempt) => !done.has(attempt.attemptId));
    const active = Array.isArray(run?.active) && run.active.length > 0;
    if (!attempts.length) return active ? <Working /> : null;
    const config = chatConfig(ctx);
    const messages = attempts.map((attempt) => {
      const sender: ChatSender = {
        id: `agent:${attempt.agent?.id ?? attempt.attemptId}`,
        type: "agent",
        name: attempt.agent?.name ?? "Assistant",
        ...(attempt.agent ? { agentId: attempt.agent.id } : {}),
      };
      return liveMessage(attempt, sender);
    });
    const tools = presentTools(ctx, threadId, messages);
    return (
      <div data-slot="thread-live" className="grid gap-6 pt-6">
        {groupMessages(messages, () => false).map((group) => (
          <MessageGroup
            key={group.id}
            group={group}
            imageOrigins={config.imageOrigins}
            markdownPlugins={config.plugins}
            tools={tools}
            labels={config.labels}
          />
        ))}
      </div>
    );
  },
});

export default view;
