/** @jsxRuntime classic */
/** @jsx React.createElement */
/** @jsxFrag React.Fragment */
// deno-lint-ignore verbatim-module-syntax -- classic JSX requires this runtime import.
import * as React from "react";
import { useEffect } from "react";
import { MessageSquare, Sparkles } from "lucide-react";
import { defineView, type ViewDefinition } from "@copilotz/copilotz/views";
import type { BrowserViewContext, Row } from "@copilotz/copilotz/web";
import {
  isReconnecting,
  ReadStatus,
  Skeleton,
} from "@copilotz/copilotz/web/kit";
import {
  type ChatMessage,
  type ChatSender,
  finishedReplies,
  groupMessages,
  ownMessagePredicate,
  projectMessages,
  settleFinished,
  toolReaderIds,
} from "../../shared/chat-messages.ts";
import { projectActiveMessageBranch } from "../../shared/projections.ts";
import {
  readThread,
  readThreadMessages,
  THREAD_MESSAGE_LIMIT,
} from "../reads.ts";
import {
  chatConfig,
  type ChatSelf,
  presentTools,
  readSenders,
  withLoadedBodies,
  withLoadedResults,
} from "../chat/context.tsx";
import { MessageGroup } from "../chat/message.tsx";
import { ActivityMemory } from "../chat/activity.tsx";
import { type LogItem, MessageLog } from "../chat/list.tsx";
import type { MessageBranch } from "../../shared/contracts.ts";

function LoadingRows(): React.ReactElement {
  return (
    <div
      role="status"
      aria-label="Loading messages"
      className="mx-auto grid w-full max-w-3xl gap-8 px-4 pt-8 sm:px-6"
    >
      {[0, 1, 2].map((index) => (
        <div
          key={index}
          className={index % 2 ? "flex flex-row-reverse gap-3" : "flex gap-3"}
        >
          <Skeleton className="size-8 shrink-0 rounded-full" />
          <div className={index % 2 ? "grid w-1/2 gap-2" : "grid w-3/4 gap-2"}>
            <Skeleton className="h-3.5 w-24" />
            <Skeleton className="h-3.5 w-full" />
            <Skeleton className="h-3.5 w-4/5" />
          </div>
        </div>
      ))}
    </div>
  );
}

/** The welcome shown in a conversation with no messages yet. */
export function ConversationStart(
  { title, hint, suggestions, onSuggestion, logoUrl }: {
    title: string;
    hint?: string;
    suggestions: readonly string[];
    onSuggestion?(text: string): void;
    logoUrl?: string;
  },
): React.ReactElement {
  return (
    <div className="mx-auto flex min-h-full w-full max-w-2xl flex-col items-center justify-center gap-6 px-4 py-10 text-center">
      <div className="grid justify-items-center gap-3">
        <div className="bg-primary/5 text-primary flex size-12 items-center justify-center overflow-hidden rounded-2xl border">
          {logoUrl
            ? <img src={logoUrl} alt="" className="size-full object-cover" />
            : <Sparkles aria-hidden="true" className="size-6" />}
        </div>
        <h2 className="text-xl font-semibold tracking-tight">{title}</h2>
        {hint && (
          <p className="text-muted-foreground max-w-md text-sm">{hint}</p>
        )}
      </div>
      {suggestions.length > 0 && onSuggestion && (
        <ul className="grid w-full gap-2 sm:grid-cols-2">
          {suggestions.map((suggestion) => (
            <li key={suggestion}>
              <button
                type="button"
                onClick={() => onSuggestion(suggestion)}
                className="bg-card hover:bg-accent/60 hover:border-ring/40 focus-visible:ring-ring/45 flex h-full w-full items-start gap-3 rounded-xl border p-3.5 text-left text-sm shadow-soft transition-colors outline-none focus-visible:ring-[3px]"
              >
                <MessageSquare
                  aria-hidden="true"
                  className="text-muted-foreground mt-0.5 size-4 shrink-0"
                />
                <span className="line-clamp-2 font-medium">{suggestion}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Follow(
  { threadId, ctx }: { threadId: string; ctx: BrowserViewContext },
): null {
  useEffect(() => {
    const follow = ctx.actions.chatFollow?.({ threadId });
    return () => void follow?.cancel().catch(() => {});
  }, [threadId]);
  return null;
}

/** The persisted sender to show for outbox messages: the person's own participant. */
function ownSender(
  senders: Iterable<ChatSender>,
  self: ChatSelf | undefined,
): ChatSender {
  for (const sender of senders) {
    if (
      sender.type === "human" && self &&
      (sender.externalId === self.externalId || sender.id === self.id)
    ) return sender;
  }
  return {
    id: `self:${self?.externalId ?? self?.id ?? "me"}`,
    type: "human",
    name: self?.name ?? "You",
    ...(self?.externalId ? { externalId: self.externalId } : {}),
  };
}

const view: ViewDefinition<
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
    const config = chatConfig(ctx);
    const thread = readThread(ctx, id);
    // A conversation started here shows its first message while Core
    // creates it; it is never "not found" in the meantime.
    const starting = thread.value
      ? undefined
      : ctx.collections.pendingThread?.get(id).value;
    const title = String(
      thread.value?.name ?? starting?.name ?? "Conversation",
    );
    const window = ctx.collections.threadWindow?.get(id).value;
    const limit = Number(window?.limit ?? THREAD_MESSAGE_LIMIT);
    const current = readThreadMessages(ctx, id, limit);
    // While a larger window loads, keep showing the previous one.
    const messages = current.status === "loading" &&
        limit > THREAD_MESSAGE_LIMIT
      ? readThreadMessages(ctx, id, limit - THREAD_MESSAGE_LIMIT)
      : current;
    const rows = projectActiveMessageBranch(
      messages.value,
      thread.value?.activeMessageBranch as MessageBranch | undefined,
    );
    // The thread's people are one shared read (the composer and the agent
    // selector read the same); only senders outside it add another.
    const people = readSenders(
      ctx,
      Array.isArray(thread.value?.participantIds)
        ? thread.value.participantIds.map(String)
        : [],
    );
    const senders = new Map([
      ...people,
      ...readSenders(
        ctx,
        // Senders, and whoever a withheld tool output is shared with.
        [...rows.map((row) => String(row.senderId)), ...toolReaderIds(rows)]
          .filter((sender) => !people.has(sender)),
      ),
    ]);
    const projected = withLoadedBodies(
      ctx,
      withLoadedResults(
        ctx,
        projectMessages(
          rows,
          (sender) =>
            senders.get(sender) ??
              { id: sender, type: "system", name: "Unknown" },
          {
            viewerIds: [config.self?.id, config.self?.externalId].filter((
              value,
            ): value is string => typeof value === "string" && value !== ""),
          },
        ),
      ),
    );
    // A reply that finished never shows a step still running: the thread is
    // idle, or its agent wrote again (it continues once its tools settle).
    const run = ctx.collections.threadRun?.get(id).value;
    const idle = run?.status === "unavailable" ||
      (run?.status === "live" &&
        !(Array.isArray(run.active) && run.active.length));
    const persisted = settleFinished(
      projected,
      finishedReplies(projected, idle),
    );
    const known = new Set(rows.map((row) => row.id));
    const self = config.self;
    const me = ownSender(senders.values(), self);
    const outbox = (ctx.collections.outbox?.list({ where: { threadId: id } })
      .value ?? []).filter((row: Row) => !row.removed && !known.has(row.id));
    const pending: ChatMessage[] = outbox.map((row: Row) => ({
      id: row.id,
      role: "user",
      sender: me,
      text: String(row.text ?? ""),
      createdAt: String(row.createdAt ?? ""),
      attachments: Array.isArray(row.attachments)
        ? row.attachments as ChatMessage["attachments"]
        : [],
      activity: [],
      status: row.status === "failed"
        ? "failed"
        : row.status === "sending"
        ? "sending"
        : "sent",
      ...(typeof row.error === "string" ? { error: row.error } : {}),
    }));
    const all = [...persisted, ...pending];
    const isOwn = ownMessagePredicate([...senders.values(), me], self);
    const groups = groupMessages(all, isOwn);
    const tools = presentTools(ctx, id, persisted);
    const settled = persisted.flatMap((message) =>
      message.attemptId ? [message.attemptId] : []
    );
    const live = ctx.show({
      shows: "threadLive",
      value: {
        threadId: id,
        settled,
        // A reply's own running step already says the agent is at work.
        ...(persisted.some((message) =>
            message.activity.some((item) => item.status === "active")
          )
          ? { working: true }
          : {}),
      },
    }, { mode: ctx.hints.mode }) as React.ReactNode;
    const loadAsset = config.feed?.asset
      ? (messageId: string, assetId: string, signal: AbortSignal) =>
        config.feed!.asset!(id, messageId, assetId, signal)
      : undefined;
    const items: LogItem[] = groups.map((group) => ({
      key: group.messages.at(-1)!.id,
      node: (
        <MessageGroup
          group={group}
          imageOrigins={config.imageOrigins}
          markdownPlugins={config.plugins}
          tools={tools}
          labels={config.labels}
          technical={config.technical}
          loadAsset={loadAsset}
          onLoadBody={(messageId, assetId) =>
            void ctx.actions.chatLoadBody?.({
              threadId: id,
              messageId,
              assetId,
            })
              .result().catch(() => {})}
          onLoadResult={(item) =>
            item.resultRef &&
            void ctx.actions.chatLoadToolResult?.({
              callId: item.id,
              threadId: id,
              ...item.resultRef,
            }).result().catch(() => {})}
          onEdit={ctx.actions.chatRevise
            ? (messageId, text) =>
              ctx.actions.chatRevise({ threadId: id, messageId, text })
                .result().then(() => undefined)
            : undefined}
          onRetry={(messageId) =>
            void ctx.actions.chatSend?.({
              threadId: id,
              text: "",
              retry: messageId,
            })
              .result().catch(() => {})}
          onDiscard={(messageId) =>
            void ctx.actions.chatDiscard?.({ messageId }).result()}
        />
      ),
    }));
    items.push({ key: "live", node: live, bare: true });
    const loading = messages.status === "loading" && !rows.length;
    // A reconnect keeps the messages on screen; the shell's indicator says so.
    const unavailable = messages.status !== "ready" &&
      messages.status !== "loading" && !isReconnecting(messages);
    const empty = !loading && !all.length && messages.status === "ready";
    const embedded = ctx.hints.embedded === true;
    return (
      <section
        aria-label={title}
        data-density={ctx.hints.mode}
        className="flex h-full min-h-0 flex-col"
      >
        <Follow threadId={id} ctx={ctx} />
        {!embedded && (
          <header className="flex h-12 shrink-0 items-center border-b px-4">
            <h1 className="truncate text-sm font-semibold">
              {title}
            </h1>
          </header>
        )}
        {!starting &&
            (thread.status === "denied" || thread.status === "missing")
          ? (
            <div className="mx-auto w-full max-w-3xl p-6">
              <ReadStatus state={thread} noun="conversation" />
            </div>
          )
          : (
            <>
              {unavailable && (
                <div className="mx-auto w-full max-w-3xl px-4 pt-3 sm:px-6">
                  <ReadStatus state={messages} noun="messages" />
                </div>
              )}
              {/* What the reader opened stays open as replies grow. */}
              <ActivityMemory key={id}>
                <MessageLog
                  resetKey={id}
                  items={loading || empty ? [] : items}
                  busy={false}
                  hasOlder={current.status === "ready" &&
                    current.value.length >= limit}
                  loadingOlder={current !== messages}
                  onLoadOlder={() =>
                    void ctx.actions.chatLoadOlder?.({ threadId: id }).result()}
                  empty={loading ? <LoadingRows /> : (
                    <>
                      <ConversationStart
                        title={config.labels.emptyTitle ??
                          "Start the conversation"}
                        hint={config.labels.emptyHint ??
                          "Ask a question, share a file, or @mention an agent."}
                        suggestions={config.suggestions}
                        logoUrl={undefined}
                        onSuggestion={ctx.actions.chatSend
                          ? (text) =>
                            void ctx.actions.chatSend({ threadId: id, text })
                              .result().catch(() => {})
                          : undefined}
                      />
                      {live}
                    </>
                  )}
                />
              </ActivityMemory>
              {ctx.show({
                shows: "composer",
                value: { threadId: id },
              }, { mode: ctx.hints.mode }) as React.ReactNode}
            </>
          )}
      </section>
    );
  },
});

export default view;
