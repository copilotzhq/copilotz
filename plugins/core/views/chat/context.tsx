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
  type ChatMessage,
  type ChatSender,
  chatSender,
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
  error?: string;
  /** Progressive output while the tool runs, by channel (such as `stdout`). */
  output?: Readonly<Record<string, string>>;
}>;

/** A registered tool renderer: `resources.toolRenderers.<toolId>`. */
export type ToolRenderer = Readonly<{ view: string; inline?: boolean }>;

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
  return {
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
    ...(Object.keys(sender).length ? { self: sender as ChatSelf } : {}),
    ...(feed && typeof feed === "object"
      ? { feed: feed as ThreadFeedAdapter }
      : {}),
    branding: record(shell.branding) as ChatConfig["branding"],
  };
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
  return new Map(
    Object.entries(registered).flatMap(([toolId, value]) => {
      const entry = record(value);
      return typeof entry.view === "string"
        ? [
          [toolId, {
            view: entry.view,
            inline: entry.inline === true,
          }] as const,
        ]
        : [];
    }),
  );
}

function status(item: ChatActivity): ToolCallView["status"] {
  if (item.status === "failed") return "failed";
  if (item.status === "complete") return "completed";
  return item.input ? "running" : "streaming";
}

/**
 * Renders each tool call that has an app renderer, as a nested View. Call
 * during View rendering so each renderer tracks its own reads.
 */
export function presentTools(
  ctx: BrowserViewContext,
  threadId: string,
  messages: readonly ChatMessage[],
): Map<string, ToolPresentation> {
  const renderers = toolRenderers(ctx);
  const tools = new Map<string, ToolPresentation>();
  if (!renderers.size) return tools;
  for (const message of messages) {
    for (const item of message.activity) {
      if (item.kind !== "tool" || !item.toolId) continue;
      const renderer = renderers.get(item.toolId);
      if (!renderer) continue;
      const value: ToolCallView = {
        toolId: item.toolId,
        callId: item.id,
        threadId,
        ...(message.id.startsWith("live:") ? {} : { messageId: message.id }),
        status: status(item),
        ...(item.input ? { input: item.input } : {}),
        ...(item.rawInput !== undefined ? { rawInput: item.rawInput } : {}),
        ...(item.result !== undefined ? { result: item.result } : {}),
        ...(item.error !== undefined ? { error: item.error } : {}),
      };
      let node: React.ReactNode;
      try {
        node = ctx.show({
          shows: "chatToolCall",
          value: { ...value, view: renderer.view },
        }, { mode: "inline" }) as React.ReactNode;
      } catch {
        continue; // A missing renderer falls back to the plain details.
      }
      tools.set(item.id, {
        node: (
          <PaneBoundary key={item.id} label={`The ${item.toolId} view`}>
            {node}
          </PaneBoundary>
        ),
        inline: renderer.inline === true,
      });
    }
  }
  return tools;
}
