/** @jsxRuntime classic */
/** @jsx React.createElement */
/** @jsxFrag React.Fragment */
// deno-lint-ignore verbatim-module-syntax -- classic JSX requires this runtime import.
import * as React from "react";
import {
  CircleCheck,
  LoaderCircle,
  Lock,
  MessageCircle,
  TriangleAlert,
} from "lucide-react";
import { defineView, type ViewDefinition } from "@copilotz/copilotz/views";
import type { BrowserViewContext } from "@copilotz/copilotz/web";
import { cn } from "@copilotz/copilotz/web/kit";
import { type ChatSender, parseToolInput } from "../../shared/chat-messages.ts";
import { readSenders, type ToolCallView } from "../chat/context.tsx";
import { SenderAvatar, senderColor } from "../chat/identity.tsx";
import { readThread } from "../reads.ts";

type AskState = "writing" | "waiting" | "answered" | "failed";

/**
 * The asked agent as the conversation shows it: the thread's agent the
 * target names (by agent id, name or external id), or a neutral agent with
 * that name, colored the same way.
 */
function askedAgent(
  ctx: BrowserViewContext,
  threadId: string,
  target: string,
): ChatSender {
  const wanted = target.toLowerCase();
  const thread = readThread(ctx, threadId).value;
  const ids = Array.isArray(thread?.participantIds)
    ? thread.participantIds.map(String)
    : [];
  for (const sender of readSenders(ctx, ids).values()) {
    if (sender.type !== "agent" || sender.unknown) continue;
    if (
      [sender.agentId, sender.name, sender.externalId].some((value) =>
        value?.toLowerCase() === wanted
      )
    ) return sender;
  }
  return { id: wanted, type: "agent", name: target, agentId: wanted };
}

function Status(
  { state, name }: { state: AskState; name: string },
): React.ReactElement | null {
  const base =
    "inline-flex shrink-0 items-center gap-1.5 text-xs whitespace-nowrap";
  if (state === "answered") {
    return (
      <span className={cn(base, "text-muted-foreground")}>
        <CircleCheck aria-hidden="true" className="text-success size-3.5" />
        Answered
      </span>
    );
  }
  if (state === "failed") {
    return (
      <span className={cn(base, "text-warning")}>
        <TriangleAlert aria-hidden="true" className="size-3.5" />
        No answer
      </span>
    );
  }
  if (state === "waiting") {
    return (
      <span className={cn(base, "text-muted-foreground")}>
        <LoaderCircle aria-hidden="true" className="size-3.5 animate-spin" />
        <span>
          Waiting<span className="hidden sm:inline">{` for ${name}`}</span>
        </span>
      </span>
    );
  }
  return null;
}

/**
 * Core's `ask` tool, shown inline as the question itself: who was asked, the
 * question, and whether it was answered. The answer follows as the asked
 * agent's own message; the question's message does not repeat it (see
 * `projectMessages`'s `inlineAsk`).
 */
const view: ViewDefinition<ToolCallView, React.ReactNode, BrowserViewContext> =
  defineView<ToolCallView, React.ReactNode, BrowserViewContext>({
    id: "core.askToolCall",
    shows: "askToolCall",
    renderer: "react",
    modes: ["inline"],
    render(call, ctx) {
      const input = call.input ?? parseToolInput(call.rawInput) ?? {};
      const target = typeof input.target === "string"
        ? input.target.trim()
        : "";
      const message = typeof input.message === "string"
        ? input.message.trim()
        : "";
      const asked = target ? askedAgent(ctx, call.threadId, target) : undefined;
      const color = asked ? senderColor(asked) : undefined;
      const state: AskState = call.status === "completed"
        ? "answered"
        : call.status === "failed"
        ? "failed"
        : call.status === "running"
        ? "waiting"
        : "writing";
      const settled = state === "answered" || state === "failed";
      return (
        <section
          data-slot="ask-tool"
          data-state={state}
          aria-label={asked ? `Question for ${asked.name}` : "Question"}
          className="bg-card grid min-w-0 gap-2 rounded-xl border px-3.5 py-3 text-sm shadow-soft"
        >
          <header className="flex min-h-6 min-w-0 items-center gap-2.5">
            {asked
              ? <SenderAvatar sender={asked} size="sm" />
              : (
                <span className="bg-muted text-muted-foreground flex size-6 shrink-0 items-center justify-center rounded-full">
                  <MessageCircle aria-hidden="true" className="size-3.5" />
                </span>
              )}
            <p
              className={cn(
                "min-w-0 flex-1 truncate",
                !asked && "shimmer-text",
              )}
            >
              {asked
                ? (
                  <>
                    <span className="text-muted-foreground">
                      {settled ? "Asked " : "Asking "}
                    </span>
                    <span className="font-semibold" style={{ color }}>
                      {asked.name}
                    </span>
                  </>
                )
                : "Writing a question…"}
            </p>
            {input.mode === "private" && (
              <span className="text-muted-foreground inline-flex shrink-0 items-center gap-1 text-xs">
                <Lock aria-hidden="true" className="size-3" />
                Private
              </span>
            )}
            {asked && <Status state={state} name={asked.name} />}
          </header>
          {message && (
            <blockquote
              className="text-foreground/90 border-l-2 pl-3 leading-relaxed [overflow-wrap:anywhere] whitespace-pre-wrap"
              style={color ? { borderColor: color } : undefined}
            >
              {message}
            </blockquote>
          )}
          {call.error && (
            <p className="text-muted-foreground text-xs [overflow-wrap:anywhere]">
              {call.error}
            </p>
          )}
        </section>
      );
    },
  });

export default view;
