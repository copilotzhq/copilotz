/** @jsxRuntime classic */
/** @jsx React.createElement */
/** @jsxFrag React.Fragment */
/** What chat Views read from the app's composition, in one place. @module */
// deno-lint-ignore verbatim-module-syntax -- classic JSX requires this runtime import.
import * as React from "react";
import type { BrowserViewContext } from "@copilotz/copilotz/web";
import {
  type MarkdownPlugin,
  markdownPlugins,
  PaneBoundary,
} from "@copilotz/copilotz/web/kit";
import {
  type ChatActivity,
  type ChatDeferredBody,
  type ChatMessage,
  type ChatSender,
  chatSender,
  type ChatTextPart,
  joinText,
  type ToolResultStatus,
} from "../../shared/chat-messages.ts";
import type { ActivityLabels, ToolPresentation } from "./activity.tsx";
import type { ThreadFeedAdapter } from "./host.ts";
import { readParticipants } from "../reads.ts";

/** What a tool renderer View receives as its value. */
export type ToolCallView = Readonly<{
  /** The stable tool id (its renderer key). */
  toolId: string;
  callId: string;
  threadId: string;
  messageId?: string;
  status: "streaming" | "running" | "completed" | "failed";
  /** Parsed arguments, once the model finished writing them. */
  input?: Readonly<Record<string, unknown>>;
  /** Raw arguments while they stream. */
  rawInput?: string;
  /** The result text, when the history read includes it. */
  result?: string;
  /**
   * The structured (JSON) result. Core stores object tool output as JSON; it
   * arrives once read on demand (see `resultStatus`), bounded at 256 KiB.
   */
  data?: unknown;
  /** A JSON result still loading, too large to show, or unavailable. */
  resultStatus?: ToolResultStatus;
  error?: string;
  /** Progressive output while the tool runs, by channel (such as `stdout`). */
  output?: Readonly<Record<string, string>>;
}>;

/**
 * What a summary View receives: the call, and when the renderer batches
 * (`batch`), every consecutive call to the same tool in the reply that reads
 * as this one step, oldest first. The call's `status` is then the run's:
 * running while any runs, failed when any failed.
 */
export type ToolSummaryView =
  & ToolCallView
  & Readonly<{
    calls?: readonly ToolCallView[];
  }>;

/**
 * Who a live renderer is for: `everyone` draws in full in the message;
 * `technical` (a terminal) shows a slim status strip that opens to it, open
 * from the start for people who chose "Show technical details".
 */
export type ToolAudience = "everyone" | "technical";

/**
 * A registered tool renderer: `resources.toolRenderers.<toolId>`. Every part
 * is optional; a tool with none reads as a generic step ("Used kanban").
 *
 * - `summary`: a View (`shows`) given a {@link ToolSummaryView} that says in
 *   plain words what the call did ("Searched memory: no notes found"), for
 *   the reply's activity row and its steps. `batch` lets one summary speak
 *   for a run of consecutive calls ("Added 3 cards to Launch plan");
 *   `summaryResult` says it reads the result, which then loads when the
 *   steps open (never for the collapsed row).
 * - `view`: a View (`shows`) given a {@link ToolCallView} that draws the
 *   call. `inline` replaces the step with it for good (the call is the
 *   message, such as `ask`). `live` draws it in the message while the call
 *   runs, streaming, then settles it into a compact card that expands to the
 *   full run, for its `audience` (default `everyone`); see `useToolDisplay`.
 *   `icon` (a kit icon name, such as `terminal`) marks its settled card, so
 *   its summary says the outcome ("`npm test` exited with 1"), and
 *   `summaryResult` reads its result as soon as the card shows. Otherwise
 *   the View shows in the step's details.
 */
export type ToolRenderer = Readonly<{
  view?: string;
  inline?: boolean;
  live?: boolean;
  audience?: ToolAudience;
  icon?: string;
  summary?: string;
  batch?: boolean;
  summaryResult?: boolean;
}>;

export type ChatLabels = ActivityLabels & {
  composerPlaceholder?: string;
  composerHelp?: string;
  footer?: string;
  emptyTitle?: string;
  emptyHint?: string;
};

export type ChatSelf = Readonly<{
  id?: string;
  externalId?: string;
  name?: string;
  email?: string;
}>;

export type ChatConfig = Readonly<{
  /**
   * The person chose "Show technical details": technical live views start
   * open and each reply's steps show with their details one click away.
   * The shell keeps it per person (`shellPreferences.technical`).
   */
  technical: boolean;
  imageOrigins: readonly string[];
  plugins: readonly MarkdownPlugin[];
  labels: ChatLabels;
  suggestions: readonly string[];
  features: Readonly<{ attachments: boolean; voice: boolean }>;
  self?: ChatSelf;
  feed?: ThreadFeedAdapter;
  branding: Readonly<{ title?: string; subtitle?: string; logoUrl?: string }>;
}>;

const strings = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};

/** The app's chat configuration from resources and adapters. */
export function chatConfig(ctx: BrowserViewContext): ChatConfig {
  const shell = record(ctx.resources.shell);
  const labels = record(shell.labels);
  const features = record(shell.features);
  const sender = record(record(ctx.resources.chat).sender);
  const feed = ctx.adapters.core?.feed;
  const self = Object.keys(sender).length ? sender as ChatSelf : undefined;
  return {
    technical: technicalDetails(ctx, self),
    imageOrigins: strings(record(ctx.resources.markdown).imageOrigins),
    plugins: markdownPlugins(ctx.adapters),
    labels: Object.fromEntries(
      Object.entries(labels).filter(([, value]) => typeof value === "string"),
    ) as ChatLabels,
    suggestions: strings(shell.suggestions),
    features: {
      attachments: features.attachments !== false,
      voice: features.voice !== false,
    },
    ...(self ? { self } : {}),
    ...(feed && typeof feed === "object"
      ? { feed: feed as ThreadFeedAdapter }
      : {}),
    branding: record(shell.branding) as ChatConfig["branding"],
  };
}

/**
 * Whether this person chose "Show technical details". The shell keeps the
 * choice per person, as the person ids in `shellPreferences.technical`
 * (people sharing a browser keep their own); without a shell it is off.
 */
export function technicalDetails(
  ctx: BrowserViewContext,
  self: ChatSelf | undefined,
): boolean {
  const preferences = record(
    ctx.collections.shellPreferences?.get("main").value,
  );
  const person = self?.id ?? self?.externalId ?? "";
  return strings(preferences.technical).includes(person);
}

/**
 * Participant rows for these sender ids, one tracked read each. Call during
 * View rendering.
 */
export function readSenders(
  ctx: BrowserViewContext,
  ids: Iterable<string>,
): Map<string, ChatSender> {
  const unique = [...new Set(ids)].filter(Boolean);
  const rows = readParticipants(ctx, unique);
  return new Map(unique.map((id) => [id, chatSender(rows.get(id), id)]));
}

/** The registered tool renderers. */
export function toolRenderers(
  ctx: BrowserViewContext,
): ReadonlyMap<string, ToolRenderer> {
  const registered = record(ctx.resources.toolRenderers);
  const name = (value: unknown) =>
    typeof value === "string" && value ? value : undefined;
  return new Map(
    Object.entries(registered).flatMap(([toolId, value]) => {
      const entry = record(value);
      const view = name(entry.view);
      const summary = name(entry.summary);
      if (!view && !summary) return [];
      const renderer: ToolRenderer = {
        ...(view ? { view } : {}),
        ...(summary ? { summary } : {}),
        ...(view && entry.inline === true ? { inline: true } : {}),
        ...(view && entry.inline !== true && entry.live === true
          ? {
            live: true,
            audience: entry.audience === "technical" ? "technical" : "everyone",
          }
          : {}),
        ...(view && entry.live === true && name(entry.icon)
          ? { icon: name(entry.icon) }
          : {}),
        ...(entry.batch === true ? { batch: true } : {}),
        ...(entry.summaryResult === true ? { summaryResult: true } : {}),
      };
      return [[toolId, renderer] as const];
    }),
  );
}

function status(item: ChatActivity): ToolCallView["status"] {
  if (item.status === "failed") return "failed";
  if (item.status === "complete") return "completed";
  return item.input ? "running" : "streaming";
}

function callView(
  item: ChatActivity,
  message: ChatMessage,
  threadId: string,
): ToolCallView {
  return {
    toolId: item.toolId ?? "tool",
    callId: item.id,
    threadId,
    ...(message.id.startsWith("live:") ? {} : { messageId: message.id }),
    status: status(item),
    ...(item.input ? { input: item.input } : {}),
    ...(item.rawInput !== undefined ? { rawInput: item.rawInput } : {}),
    ...(item.result !== undefined ? { result: item.result } : {}),
    ...(item.data !== undefined ? { data: item.data } : {}),
    ...(item.resultStatus ? { resultStatus: item.resultStatus } : {}),
    ...(item.error !== undefined ? { error: item.error } : {}),
  };
}

/** A run of calls as one: running while any runs, failed when any failed. */
function runStatus(calls: readonly ToolCallView[]): ToolCallView["status"] {
  if (calls.some((call) => call.status === "streaming")) return "streaming";
  if (calls.some((call) => call.status === "running")) return "running";
  return calls.some((call) => call.status === "failed")
    ? "failed"
    : "completed";
}

/**
 * Renders each tool call that has an app renderer: its summary line (once
 * per batched run) and its View. Call during View rendering so each renders
 * as a nested View that tracks its own reads.
 */
export function presentTools(
  ctx: BrowserViewContext,
  threadId: string,
  messages: readonly ChatMessage[],
): Map<string, ToolPresentation> {
  const renderers = toolRenderers(ctx);
  const tools = new Map<string, ToolPresentation>();
  if (!renderers.size) return tools;
  const show = (shows: string, value: unknown): React.ReactNode | undefined => {
    try {
      return ctx.show({ shows, value }, { mode: "inline" }) as React.ReactNode;
    } catch {
      return undefined; // A missing View falls back to the generic step.
    }
  };
  for (const message of messages) {
    const items = message.activity;
    for (let index = 0; index < items.length;) {
      const item = items[index];
      const renderer = item.kind === "tool" && item.toolId
        ? renderers.get(item.toolId)
        : undefined;
      if (!renderer) {
        index++;
        continue;
      }
      // Consecutive background calls to a batching tool read as one step.
      let end = index + 1;
      if (renderer.batch && !renderer.inline && !renderer.live) {
        while (
          end < items.length && items[end].kind === "tool" &&
          items[end].toolId === item.toolId
        ) end++;
      }
      const run = items.slice(index, end);
      const calls = run.map((call) => callView(call, message, threadId));
      const value: ToolSummaryView = calls.length > 1
        ? { ...calls.at(-1)!, status: runStatus(calls), calls }
        : calls[0];
      const summary = renderer.summary
        ? show(renderer.summary, value)
        : undefined;
      const group = run.length > 1 ? run.map((call) => call.id) : undefined;
      run.forEach((call, offset) => {
        const node = renderer.view
          ? show("chatToolCall", { ...calls[offset], view: renderer.view })
          : undefined;
        tools.set(call.id, {
          ...(node !== undefined
            ? {
              node: (
                <PaneBoundary key={call.id} label={`The ${call.toolId} view`}>
                  {node}
                </PaneBoundary>
              ),
            }
            : {}),
          ...(summary !== undefined ? { summary } : {}),
          inline: renderer.inline === true && node !== undefined,
          ...(renderer.live && node !== undefined
            ? { live: renderer.audience ?? "everyone" }
            : {}),
          ...(renderer.icon ? { icon: renderer.icon } : {}),
          ...(group ? { group } : {}),
          ...(renderer.summaryResult ? { summaryResult: true } : {}),
        });
      });
      index = end;
    }
  }
  return tools;
}

/**
 * Tool results read on demand (`chatLoadToolResult`), merged into the activity
 * that references them. Call during View rendering.
 */
export function withLoadedResults(
  ctx: BrowserViewContext,
  messages: readonly ChatMessage[],
): ChatMessage[] {
  const store = ctx.collections.toolResult;
  const waiting = (item: ChatActivity) =>
    Boolean(item.resultRef) && item.data === undefined &&
    item.result === undefined;
  return messages.map((message) => {
    if (!store || !message.activity.some(waiting)) return message;
    return {
      ...message,
      activity: message.activity.map((item) => {
        if (!waiting(item)) return item;
        const row = store.get(item.id).value;
        if (!row) return item;
        if (row.status !== "ready") {
          return { ...item, resultStatus: row.status as ToolResultStatus };
        }
        return typeof row.text === "string"
          ? { ...item, result: row.text }
          : { ...item, data: row.value };
      }),
    };
  });
}

/**
 * Message text bodies read on demand (`chatLoadBody`), joined into the text
 * where they belong; parts still loading keep their status. Call during View
 * rendering.
 */
export function withLoadedBodies(
  ctx: BrowserViewContext,
  messages: readonly ChatMessage[],
): ChatMessage[] {
  const store = ctx.collections.messageBody;
  return messages.map((message) => {
    if (!message.pending) return message;
    const parts = message.pending.map((part): ChatTextPart => {
      if ("text" in part) return part;
      const row = store?.get(part.assetId).value;
      if (row?.status === "ready" && typeof row.text === "string") {
        return { text: row.text };
      }
      return row?.status
        ? { ...part, status: row.status as ChatDeferredBody["status"] }
        : part;
    });
    const waiting = parts.some((part) => "assetId" in part);
    const { pending: _parts, ...rest } = message;
    return {
      ...rest,
      text: joinText(parts),
      ...(waiting ? { pending: parts } : {}),
    };
  });
}
