/**
 * Framework-free chat view model over live Collection rows: senders,
 * ownership, text and attachments, tool activity paired with its results,
 * and grouping by consecutive speaker.
 * @module
 */
import { canReadToolOutput } from "./tool-visibility.ts";
import type { FeedAttempt } from "./chat-feed.ts";

type Row = Readonly<{ id: string; [field: string]: unknown }>;

export type ChatSenderType = "human" | "agent" | "tool" | "job" | "system";

/** The display identity of whoever wrote a message. */
export type ChatSender = Readonly<{
  /** The participant record id (`message.senderId`). */
  id: string;
  type: ChatSenderType;
  name: string;
  externalId?: string;
  agentId?: string;
  avatarUrl?: string;
  /**
   * The participant could not be read (refused or missing): the name and type
   * are neutral guesses from the message, never another person's.
   */
  unknown?: true;
}>;

export type ChatAttachment = Readonly<{
  kind: "image" | "audio" | "video" | "file";
  mediaType: string;
  name?: string;
  size?: number;
  /** A persisted body; the host's feed adapter resolves it for previews. */
  assetId?: string;
  /** A local preview (object URL) for a message not yet sent. */
  url?: string;
}>;

export type ChatActivityStatus = "active" | "complete" | "failed";

/** One step of an agent's work: thinking, a tool call, or a failure. */
export type ChatActivity = Readonly<{
  id: string;
  kind: "thinking" | "tool" | "failure";
  status: ChatActivityStatus;
  toolId?: string;
  /** Parsed arguments once complete. */
  input?: Readonly<Record<string, unknown>>;
  /** Raw arguments while the model is still writing them. */
  rawInput?: string;
  /** The tool result's text, when the read includes it. */
  result?: string;
  /** The tool's structured (JSON) result, once read. */
  data?: unknown;
  /**
   * A JSON result the window read leaves as a reference; it is read on
   * demand (`chatLoadToolResult`), bounded, when the step or renderer shows.
   */
  resultRef?: ToolResultRef;
  /** Why a referenced result is not shown yet. */
  resultStatus?: ToolResultStatus;
  error?: string;
  reasoning?: string;
}>;

/**
 * A referenced JSON result while it loads, or why it cannot show:
 * `restricted` when the tool's visibility lets this viewer see that it ran
 * (and its input) but not its output (`public_status` for anyone but the
 * requesting agent or initiating human).
 */
export type ToolResultStatus =
  | "loading"
  | "too-large"
  | "unavailable"
  | "restricted";

/** A text body the window read deferred (over its budget), to load on demand. */
export type ChatDeferredBody = Readonly<{
  assetId: string;
  byteLength?: number;
  /** Set once a load starts: still loading, too large to show, or failed. */
  status?: "loading" | "too-large" | "unavailable";
}>;

/** A message's text in order: text already read, or a body still to load. */
export type ChatTextPart = Readonly<{ text: string }> | ChatDeferredBody;

export type ChatMessage = Readonly<{
  id: string;
  role: "user" | "assistant";
  sender: ChatSender;
  /** The text read so far (see `pending`). */
  text: string;
  /**
   * Present while part of the text is deferred: every part in order, so the
   * loaded bodies (`chatLoadBody`) join the text where they belong.
   */
  pending?: readonly ChatTextPart[];
  createdAt: string;
  attachments: readonly ChatAttachment[];
  activity: readonly ChatActivity[];
  /** `sending`/`failed` come from the outbox, `streaming` from the feed. */
  status: "sent" | "sending" | "failed" | "streaming";
  /** The LLM call that produced an agent message. */
  attemptId?: string;
  edited?: boolean;
  error?: string;
}>;

/** Consecutive messages by one speaker, rendered under one name and avatar. */
export type ChatMessageGroup = Readonly<{
  id: string;
  sender: ChatSender;
  role: ChatMessage["role"];
  own: boolean;
  messages: readonly ChatMessage[];
}>;

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

/** A participant row as a display sender; unknown rows keep their id. */
export function chatSender(
  row: Row | undefined,
  fallbackId: string,
): ChatSender {
  // Unread participants stay neutral: a person until the message says
  // otherwise (see `projectMessages`), never "Participant" with a bot.
  if (!row) {
    return { id: fallbackId, type: "human", name: "Someone", unknown: true };
  }
  const metadata = record(row?.metadata);
  const type = row?.participantType;
  const name = text(row?.name) ?? text(metadata.displayName) ??
    text(row?.email) ?? text(row?.externalId) ??
    (type === "agent" ? "Assistant" : "Participant");
  const avatarUrl = text(metadata.avatarUrl) ?? text(metadata.avatar);
  return {
    id: row?.id ?? fallbackId,
    type: type === "human" || type === "agent" || type === "tool" ||
        type === "job"
      ? type
      : "system",
    name,
    ...(text(row?.externalId) ? { externalId: text(row?.externalId) } : {}),
    ...(text(row?.agentId) ? { agentId: text(row?.agentId) } : {}),
    ...(avatarUrl ? { avatarUrl } : {}),
  };
}

type ContentEntry = Readonly<{
  kind?: unknown;
  role?: unknown;
  value?: unknown;
  mediaType?: unknown;
  name?: unknown;
  assetId?: unknown;
  metadata?: unknown;
}>;

function entries(content: unknown): readonly ContentEntry[] {
  if (typeof content === "string") return [{ kind: "text", value: content }];
  return Array.isArray(content)
    ? content.filter((entry) => entry && typeof entry === "object")
    : [];
}

/**
 * A message body's text parts in order: read text, or a text body the read
 * left as a reference (deferred over its budget). Reasoning and assets stay
 * out.
 */
export function messageTextParts(content: unknown): ChatTextPart[] {
  return entries(content).flatMap((entry): ChatTextPart[] => {
    const role = typeof entry.role === "string" ? entry.role : "";
    if (role.startsWith("reasoning")) return [];
    const kind = entry.kind ?? (entry as { type?: unknown }).type;
    if (kind !== "text") return [];
    const value = typeof entry.value === "string"
      ? entry.value
      : (entry as { text?: unknown }).text;
    if (typeof value === "string") return value.trim() ? [{ text: value }] : [];
    const deferred = entry as { resolve?: unknown; byteLength?: unknown };
    return deferred.resolve === false && typeof entry.assetId === "string"
      ? [{
        assetId: entry.assetId,
        ...(typeof deferred.byteLength === "number"
          ? { byteLength: deferred.byteLength }
          : {}),
      }]
      : [];
  });
}

/** Joins the text parts that are read. */
export function joinText(parts: readonly ChatTextPart[]): string {
  return parts.flatMap((part) => "text" in part ? [part.text] : []).join(
    "\n\n",
  );
}

/** The readable text of a message body; reasoning and assets stay out. */
export function messageText(content: unknown): string {
  return joinText(messageTextParts(content));
}

/** Image, audio, video and file entries, as references for previews. */
export function messageAttachments(
  content: unknown,
): readonly ChatAttachment[] {
  return entries(content).flatMap((entry) => {
    const kind = entry.kind;
    if (
      kind !== "image" && kind !== "audio" && kind !== "video" &&
      kind !== "file"
    ) return [];
    const metadata = record(entry.metadata);
    return [{
      kind,
      mediaType: text(entry.mediaType) ?? "application/octet-stream",
      ...(text(entry.name) ? { name: text(entry.name) } : {}),
      ...(typeof metadata.byteLength === "number"
        ? { size: metadata.byteLength }
        : {}),
      ...(text(entry.assetId) ? { assetId: text(entry.assetId) } : {}),
    }];
  });
}

/** Tool arguments, parsed when they are complete JSON. */
export function parseToolInput(
  raw: string | undefined,
): Readonly<Record<string, unknown>> | undefined {
  if (!raw?.trim()) return undefined;
  try {
    const parsed = record(JSON.parse(raw));
    return record(parsed.arguments ?? parsed.args ?? parsed.input ?? parsed);
  } catch {
    return undefined;
  }
}

type ToolResult = {
  status: ChatActivityStatus;
  result?: string;
  data?: unknown;
  resultRef?: ToolResultRef;
  resultStatus?: ToolResultStatus;
  error?: string;
};

/** A tool result body the read left as a reference: JSON, or deferred text. */
export type ToolResultRef = Readonly<{
  messageId: string;
  assetId: string;
  kind?: "json" | "text";
}>;

/**
 * A tool's JSON result: its value when the read resolved it, otherwise a
 * reference to read on demand. Core stores object tool output as JSON content.
 */
function jsonResult(
  row: Row,
): Pick<ToolResult, "data" | "resultRef"> {
  for (const part of Array.isArray(row.content) ? row.content : []) {
    const entry = record(part);
    if (entry.kind !== "json") continue;
    if (entry.value !== undefined && entry.resolve !== false) {
      return { data: entry.value };
    }
    if (typeof entry.assetId === "string") {
      return {
        resultRef: { messageId: String(row.id), assetId: entry.assetId },
      };
    }
  }
  return {};
}

/**
 * Whether a tool result's output is withheld from this viewer: its
 * visibility shares the status only (`public_status`, or `requester_only`
 * as read by someone else) and the viewer has no output grant.
 */
function outputWithheld(
  row: Row,
  viewerIds: readonly string[] | undefined,
): boolean {
  const visibility = record(row.visibility);
  if (visibility.kind !== "tool" || visibility.policy === "public") {
    return false;
  }
  return !canReadToolOutput(visibility, viewerIds ?? []);
}

function toolResult(
  row: Row,
  viewerIds?: readonly string[],
): [string, ToolResult] | undefined {
  const metadata = record(row.metadata);
  const id = text(record(metadata.toolInvocation).id);
  if (!id) return undefined;
  const status = metadata.toolStatus;
  const parts = messageTextParts(row.content);
  const body = joinText(parts);
  const settled = status === "completed"
    ? "complete"
    : status === "failed" || status === "cancelled"
    ? "failed"
    : "active";
  // Status only: no output to read, and nothing to retry. What the read did
  // deliver (an inline body) still shows.
  const json = jsonResult(row);
  if (
    outputWithheld(row, viewerIds) && !body && json.data === undefined
  ) {
    return [id, {
      status: settled,
      ...(settled !== "active" ? { resultStatus: "restricted" as const } : {}),
      ...(status === "cancelled" ? { error: "Cancelled." } : {}),
    }];
  }
  // A text result the window read deferred is read on demand, like JSON.
  const later = parts.find((part) => "assetId" in part);
  const deferredText = !body && later && "assetId" in later
    ? {
      resultRef: {
        messageId: String(row.id),
        assetId: later.assetId,
        kind: "text" as const,
      },
    }
    : {};
  return [id, {
    status: settled,
    ...(body ? { result: body } : {}),
    ...deferredText,
    ...json,
    ...(status === "cancelled"
      ? { error: "Cancelled." }
      : status === "failed"
      ? { error: body || "The tool failed." }
      : {}),
  }];
}

function workflow(row: Row): Record<string, unknown> {
  return record(record(row.metadata).copilotzWorkflow);
}

/** Whether a row is a tool result already shown inside its call's activity. */
function isToolResult(row: Row, sender: ChatSender): boolean {
  return sender.type === "tool" &&
    Boolean(text(record(record(row.metadata).toolInvocation).id));
}

/**
 * Decides which messages belong to the signed-in person. With one human
 * sender every human message is theirs; with several, only those whose
 * participant matches `self`. If none match, the host's identity and the
 * server's disagree, so human messages stay the person's.
 */
export function ownMessagePredicate(
  senders: readonly ChatSender[],
  self: Readonly<{ id?: string; externalId?: string }> | undefined,
): (sender: ChatSender) => boolean {
  const humans = new Set(
    senders.filter((sender) => sender.type === "human").map((sender) =>
      sender.id
    ),
  );
  const human = (sender: ChatSender) => sender.type === "human";
  if (!self || humans.size <= 1) return human;
  const matches = (sender: ChatSender) =>
    [sender.id, sender.externalId].some((id) =>
      id !== undefined && (id === self.id || id === self.externalId)
    );
  if (!senders.some((sender) => human(sender) && matches(sender))) return human;
  return (sender) => human(sender) && matches(sender);
}

/**
 * An unread sender's neutral identity, from what the message says about its
 * author: an agent's output or a tool's result; a person otherwise.
 */
function inferSender(sender: ChatSender, row: Row): ChatSender {
  if (!sender.unknown) return sender;
  const metadata = record(row.metadata);
  if (text(record(metadata.toolInvocation).id)) {
    return { ...sender, type: "tool", name: "Tool" };
  }
  const kind = workflow(row).kind;
  if (
    kind === "agent_output" || kind === "agent_failure" ||
    Array.isArray(metadata.llmToolCalls)
  ) return { ...sender, type: "agent", name: "Agent" };
  return sender;
}

/**
 * Message rows (already in conversation order) as chat messages. Tool result
 * rows fold into the activity of the call that requested them; internal rows
 * and agent rows with nothing to show are dropped.
 */
export function projectMessages(
  rows: readonly Row[],
  senderOf: (id: string) => ChatSender,
  options: Readonly<{
    /**
     * The viewer's participant ids: a tool result whose visibility shares
     * only its status shows its output to its requester or authorized initiator.
     */
    viewerIds?: readonly string[];
  }> = {},
): ChatMessage[] {
  const results = new Map<string, ToolResult>();
  for (const row of rows) {
    const sender = inferSender(senderOf(String(row.senderId ?? "")), row);
    if (sender.type !== "tool") continue;
    const result = toolResult(row, options.viewerIds);
    if (result) results.set(result[0], result[1]);
  }
  const messages: ChatMessage[] = [];
  for (const row of rows) {
    if (record(row.visibility).kind === "internal") continue;
    const sender = inferSender(senderOf(String(row.senderId ?? "")), row);
    if (isToolResult(row, sender)) continue;
    const metadata = record(row.metadata);
    const flow = workflow(row);
    const activity: ChatActivity[] = [];
    if (
      flow.kind === "agent_failure" &&
      (flow.outcome === "failed" || flow.outcome === "cancelled")
    ) {
      activity.push({
        id: `${row.id}:failure`,
        kind: "failure",
        status: "failed",
        error: flow.outcome === "cancelled"
          ? "The response was stopped."
          : "The response could not be completed.",
      });
    }
    if (
      Array.isArray(metadata.llmReasoning) && metadata.llmReasoning.length
    ) {
      const reasoning = messageText(
        metadata.llmReasoning.map((entry) => ({
          ...record(entry),
          role: "thought",
        })),
      );
      activity.push({
        id: `${row.id}:thinking`,
        kind: "thinking",
        status: "complete",
        ...(reasoning ? { reasoning } : {}),
      });
    }
    for (
      const call of Array.isArray(metadata.llmToolCalls)
        ? metadata.llmToolCalls
        : []
    ) {
      const value = record(call);
      const id = text(value.id);
      if (!id) continue;
      const result = results.get(id);
      activity.push({
        id,
        kind: "tool",
        status: result?.status ?? "active",
        toolId: text(value.action) ?? text(value.name) ?? "tool",
        input: record(value.input),
        ...(result?.result ? { result: result.result } : {}),
        ...(result?.data !== undefined ? { data: result.data } : {}),
        ...(result?.resultRef ? { resultRef: result.resultRef } : {}),
        ...(result?.resultStatus ? { resultStatus: result.resultStatus } : {}),
        ...(result?.error ? { error: result.error } : {}),
      });
    }
    const parts = messageTextParts(row.content);
    const body = joinText(parts);
    const pending = parts.some((part) => "assetId" in part) ? parts : undefined;
    const attachments = messageAttachments(row.content);
    const human = sender.type === "human";
    if (
      !human && !body && !pending && !attachments.length && !activity.length
    ) continue;
    messages.push({
      id: row.id,
      role: human ? "user" : "assistant",
      sender,
      text: body,
      ...(pending ? { pending } : {}),
      createdAt: String(row.createdAt ?? ""),
      attachments,
      activity,
      status: "sent",
      ...(text(flow.llmAttemptId)
        ? { attemptId: text(flow.llmAttemptId) }
        : {}),
      ...(record(row.revision).previousRevisionMessageId
        ? { edited: true }
        : {}),
    });
  }
  return messages;
}

/** A live reply as a streaming chat message. */
export function liveMessage(
  attempt: FeedAttempt,
  sender: ChatSender,
): ChatMessage {
  const activity: ChatActivity[] = [];
  if (attempt.reasoning || (!attempt.text && !attempt.tools.length)) {
    activity.push({
      id: `${attempt.attemptId}:thinking`,
      kind: "thinking",
      status: attempt.status === "streaming" && !attempt.text &&
          !attempt.tools.length
        ? "active"
        : attempt.status === "failed"
        ? "failed"
        : "complete",
      ...(attempt.reasoning ? { reasoning: attempt.reasoning } : {}),
    });
  }
  for (const tool of attempt.tools) {
    const input = tool.phase === "complete"
      ? parseToolInput(tool.input)
      : undefined;
    activity.push({
      id: tool.toolCallId ?? tool.id,
      kind: "tool",
      status: attempt.status === "failed" ? "failed" : "active",
      toolId: tool.name,
      ...(input ? { input } : { rawInput: tool.input }),
    });
  }
  if (attempt.status === "failed") {
    activity.push({
      id: `${attempt.attemptId}:failure`,
      kind: "failure",
      status: "failed",
      error: "The response could not be completed.",
    });
  }
  return {
    id: `live:${attempt.attemptId}`,
    role: "assistant",
    sender,
    text: attempt.text,
    createdAt: new Date(attempt.startedAt).toISOString(),
    attachments: [],
    activity,
    status: attempt.status === "streaming" ? "streaming" : "sent",
    attemptId: attempt.attemptId,
  };
}

/** Consecutive messages from the same speaker share one header. */
export function groupMessages(
  messages: readonly ChatMessage[],
  isOwn: (sender: ChatSender) => boolean,
): ChatMessageGroup[] {
  const groups: ChatMessageGroup[] = [];
  for (const message of messages) {
    const last = groups.at(-1);
    if (
      last && last.role === message.role && last.sender.id === message.sender.id
    ) {
      groups[groups.length - 1] = {
        ...last,
        messages: [...last.messages, message],
      };
      continue;
    }
    groups.push({
      id: message.id,
      sender: message.sender,
      role: message.role,
      own: message.role === "user" && isOwn(message.sender),
      messages: [message],
    });
  }
  return groups;
}
