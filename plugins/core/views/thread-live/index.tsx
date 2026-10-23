/** @jsxRuntime classic */
/** @jsx React.createElement */
/** @jsxFrag React.Fragment */
import * as React from "react";
import { Sparkles } from "lucide-react";
import { defineView, type ViewDefinition } from "@copilotz/copilotz/views";
import type { BrowserViewContext } from "@copilotz/copilotz/web";
import type { FeedAttempt, FeedTurn } from "../../shared/chat-feed.ts";
import {
  type ChatSender,
  groupMessages,
  liveMessage,
} from "../../shared/chat-messages.ts";
import {
  chatConfig,
  type ChatLabels,
  presentTools,
  readSenders,
} from "../chat/context.tsx";
import { SenderAvatar, senderColor } from "../chat/identity.tsx";
import { MessageGroup } from "../chat/message.tsx";
import { readThread } from "../reads.ts";

/** Someone at work with nothing on screen yet, and whose question they answer. */
type AtWork = Readonly<{ sender: ChatSender; asker?: ChatSender }>;

/** A label with `{{name}}` slots, each filled with its own node. */
function fillNodes(
  template: string,
  values: Readonly<Record<string, React.ReactNode>>,
): React.ReactNode[] {
  return template.split(/(\{\{\w+\}\})/g).map((part, index) => {
    const key = /^\{\{(\w+)\}\}$/.exec(part)?.[1];
    return key && key in values
      ? <React.Fragment key={index}>{values[key]}</React.Fragment>
      : part;
  });
}

function Dots(): React.ReactElement {
  return (
    <span
      aria-hidden="true"
      data-slot="typing-dots"
      className="text-muted-foreground inline-flex shrink-0 items-center gap-[3px] pl-0.5"
    >
      {[0, 1, 2].map((dot) => (
        <span
          key={dot}
          className="typing-dot size-1 rounded-full bg-current"
          style={{ animationDelay: `${dot * 160}ms` }}
        />
      ))}
    </span>
  );
}

function Name({ sender }: { sender: ChatSender }): React.ReactElement {
  return (
    <span
      className="text-foreground font-semibold"
      style={sender.type === "human"
        ? undefined
        : { color: senderColor(sender) }}
    >
      {sender.name}
    </span>
  );
}

/**
 * Who is at work before their reply shows: one calm row per agent, with
 * its avatar, name and color as its messages show them, so agents working
 * at once read as working together. With no one known, one neutral row.
 */
function Working(
  { agents, labels, imageOrigins }: {
    agents: readonly AtWork[];
    labels: ChatLabels;
    imageOrigins?: readonly string[];
  },
): React.ReactElement {
  return (
    <div
      role="status"
      data-slot="agents-working"
      className="grid gap-2.5 pt-6"
    >
      {agents.length
        ? agents.map(({ sender, asker }) => (
          <div
            key={sender.id}
            data-slot="agent-working"
            data-agent={sender.agentId ?? sender.id}
            className="animate-in fade-in-0 flex min-h-8 items-center gap-3 duration-300"
          >
            <SenderAvatar sender={sender} imageOrigins={imageOrigins} />
            <p className="text-muted-foreground flex min-w-0 items-center gap-1.5 text-sm">
              <span className="min-w-0 truncate">
                {fillNodes(
                  asker
                    ? labels.answering ?? "{{agent}} is answering {{asker}}"
                    : labels.replying ?? "{{agent}} is replying",
                  {
                    agent: <Name sender={sender} />,
                    ...(asker ? { asker: <Name sender={asker} /> } : {}),
                  },
                )}
              </span>
              <Dots />
            </p>
          </div>
        ))
        : (
          <div
            data-slot="agent-working"
            className="animate-in fade-in-0 flex min-h-8 items-center gap-3 duration-300"
          >
            <span className="bg-muted text-muted-foreground flex size-8 shrink-0 items-center justify-center rounded-full">
              <Sparkles aria-hidden="true" className="size-4" />
            </span>
            <p className="text-muted-foreground flex items-center gap-1.5 text-sm">
              {labels.workingReply ?? "Working on a reply"}
              <Dots />
            </p>
          </div>
        )}
    </div>
  );
}

/**
 * The replies still arriving in a thread, from the thread feed, and who is at
 * work before theirs shows. Only this View re-renders as text streams; the
 * persisted history does not.
 *
 * `settled` are the LLM calls the history already shows; `busy` the
 * participants whose step in the history still runs (their message already
 * says they are at work), and `working` that some step runs.
 */
const view: ViewDefinition<
  {
    threadId: string;
    settled?: readonly string[];
    working?: boolean;
    busy?: readonly string[];
  },
  React.ReactNode,
  BrowserViewContext
> = defineView<
  {
    threadId: string;
    settled?: readonly string[];
    working?: boolean;
    busy?: readonly string[];
  },
  React.ReactNode,
  BrowserViewContext
>({
  id: "core.threadLive",
  shows: "threadLive",
  renderer: "react",
  modes: ["full", "panel"],
  render({ threadId, settled = [], working = false, busy = [] }, ctx) {
    const feed = ctx.collections.threadFeed?.get(threadId).value;
    const run = ctx.collections.threadRun?.get(threadId).value;
    const done = new Set(settled);
    const all = Array.isArray(feed?.attempts)
      ? feed.attempts as FeedAttempt[]
      : [];
    const attempts = all.filter((attempt) => !done.has(attempt.attemptId));
    // A final reply (no tool calls) the history shows ends its agent's turn,
    // even before the feed says so: the two arrive separately.
    const answered = (turn: FeedTurn, sender: ChatSender) =>
      all.some((attempt) =>
        done.has(attempt.attemptId) && !attempt.tools.length &&
        attempt.operationId === turn.operationId &&
        attempt.startedAt >= turn.since &&
        attempt.agent?.id === sender.agentId
      );
    const running = new Set(
      Array.isArray(run?.active) ? run.active.map(String) : [],
    );
    // Turns of the operations still running; the feed commits both at once.
    const turns = (Array.isArray(feed?.turns) ? feed.turns as FeedTurn[] : [])
      .filter((turn) => running.has(turn.operationId));
    if (!attempts.length && !running.size) return null;
    const config = chatConfig(ctx);
    // The thread's people, read once for the whole conversation, give live
    // replies and rows the names, avatars and colors their messages have.
    const thread = readThread(ctx, threadId).value;
    const people = readSenders(
      ctx,
      Array.isArray(thread?.participantIds)
        ? thread.participantIds.map(String)
        : [],
    );
    const senders = new Map([
      ...people,
      ...readSenders(
        ctx,
        turns.flatMap((turn) => [turn.participantId, turn.askedBy ?? ""])
          .filter((id) => id && !people.has(id)),
      ),
    ]);
    const agentSender = (agent: { id: string; name: string }) =>
      [...senders.values()].find((sender) =>
        sender.type === "agent" && !sender.unknown &&
        sender.agentId === agent.id
      );
    const messages = attempts.map((attempt) => {
      const sender: ChatSender =
        (attempt.agent && agentSender(attempt.agent)) ??
          {
            id: `agent:${attempt.agent?.id ?? attempt.attemptId}`,
            type: "agent",
            name: attempt.agent?.name ?? "Assistant",
            ...(attempt.agent ? { agentId: attempt.agent.id } : {}),
          };
      return liveMessage(attempt, sender);
    });
    // Someone whose reply streams, or whose step in the history runs, is on
    // screen already; everyone else the running operations wait on gets a row.
    const shown = new Set([
      ...busy,
      ...messages.flatMap((message) => [
        message.sender.id,
        ...(message.sender.agentId ? [`agent:${message.sender.agentId}`] : []),
      ]),
    ]);
    const atWork: AtWork[] = [];
    for (const turn of turns) {
      const sender = senders.get(turn.participantId);
      if (
        !sender || sender.type !== "agent" || shown.has(sender.id) ||
        (sender.agentId && shown.has(`agent:${sender.agentId}`)) ||
        answered(turn, sender)
      ) continue;
      shown.add(sender.id);
      const asker = turn.askedBy ? senders.get(turn.askedBy) : undefined;
      atWork.push({
        sender,
        ...(asker && !asker.unknown ? { asker } : {}),
      });
    }
    // Without word of who replies (an operation whose messages this viewer
    // can't see), a neutral row says that work goes on.
    const routed = new Set(
      Array.isArray(feed?.routed) ? feed.routed.map(String) : [],
    );
    const unknown = !messages.length && !working && !atWork.length &&
      [...running].some((operation) => !routed.has(operation));
    const indicator = atWork.length || unknown
      ? (
        <Working
          agents={atWork}
          labels={config.labels}
          imageOrigins={config.imageOrigins}
        />
      )
      : null;
    if (!messages.length) return indicator;
    const tools = presentTools(ctx, threadId, messages);
    return (
      <>
        <div data-slot="thread-live" className="grid gap-6 pt-6">
          {groupMessages(messages, () => false).map((group) => (
            <MessageGroup
              key={group.id}
              group={group}
              imageOrigins={config.imageOrigins}
              markdownPlugins={config.plugins}
              tools={tools}
              labels={config.labels}
              technical={config.technical}
            />
          ))}
        </div>
        {indicator}
      </>
    );
  },
});

export default view;
