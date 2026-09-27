import type { ConversationMessage } from "../contracts.ts";
import type {
  LlmJsonObject,
  LlmMessage,
  LlmNativeReasoning,
  LlmToolCall,
} from "@copilotz/copilotz/llm";
import {
  type AgentAskMetadata,
  agentAskMetadata,
  type AgentAskPhase,
  agentAskResultMetadata,
  agentFailureMetadata,
  coreToolActionMessageMetadata,
  coreToolPlanMetadata,
  coreToolPlanResultMetadata,
  coreToolResultOrigin,
  workflowMetadata,
} from "../workflow-metadata.ts";

/** One model-facing message paired with the stored Message it came from. */
export type LlmTranscriptEntry = Readonly<{
  sourceId: string;
  message: LlmMessage;
}>;

type AssistantMessage = Extract<LlmMessage, { role: "assistant" }>;

type AskViewer =
  | "asked"
  | "askerPublic"
  | "askerPrivate"
  | "otherPublic"
  | "otherPrivate";

type AskView = "user" | "assistant" | "hidden";

/** How each participant sees every message of an agent-to-agent ask. */
const ASK_VIEWS: Readonly<
  Record<AgentAskPhase, Readonly<Record<AskViewer, AskView>>>
> = {
  question: {
    asked: "user",
    askerPublic: "hidden",
    askerPrivate: "hidden",
    otherPublic: "user",
    otherPrivate: "hidden",
  },
  progress: {
    asked: "assistant",
    askerPublic: "user",
    askerPrivate: "hidden",
    otherPublic: "user",
    otherPrivate: "hidden",
  },
  answer: {
    asked: "assistant",
    askerPublic: "user",
    askerPrivate: "user",
    otherPublic: "user",
    otherPrivate: "hidden",
  },
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function optionalText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function senderName(message: ConversationMessage): string | undefined {
  return optionalText(message.sender.name) ??
    optionalText(message.sender.externalId);
}

function askViewer(ask: AgentAskMetadata, viewerId: string): AskViewer {
  if (viewerId === ask.askedParticipantId) return "asked";
  const mode = ask.mode === "private" ? "Private" : "Public";
  return viewerId === ask.askingParticipantId ? `asker${mode}` : `other${mode}`;
}

function embeddedToolCalls(value: unknown): readonly LlmToolCall[] {
  if (!Array.isArray(value)) return [];
  return value.map((candidate, index) => {
    const call = record(candidate);
    const id = optionalText(call.id);
    const action = optionalText(call.action);
    if (!id || !action) {
      throw new TypeError(
        `Assistant message tool call ${index} is missing its id or Action alias.`,
      );
    }
    return {
      id,
      action,
      input: structuredClone(record(call.input)) as LlmJsonObject,
    };
  });
}

function hasToolCalls(message: ConversationMessage): boolean {
  const calls = message.metadata.llmToolCalls;
  return Array.isArray(calls) && calls.length > 0;
}

function toolCallId(message: ConversationMessage): string | undefined {
  return coreToolActionMessageMetadata(message.metadata)?.toolCallId ??
    coreToolPlanResultMetadata(message.metadata)?.origin.toolCallId ??
    optionalText(record(message.metadata.toolInvocation).id);
}

function toolPlanId(message: ConversationMessage): string | undefined {
  return coreToolPlanMetadata(message.metadata)?.planId ??
    coreToolResultOrigin(message.metadata)?.planId;
}

function nativeReasoning(value: unknown): LlmNativeReasoning | undefined {
  const native = record(value);
  return native.schema === "copilotz.llm-native-reasoning.v1" &&
      typeof native.adapter === "string" &&
      typeof native.api === "string" &&
      typeof native.model === "string" &&
      Array.isArray(native.blocks)
    ? structuredClone(native) as LlmNativeReasoning
    : undefined;
}

function userTurn(message: ConversationMessage): LlmMessage {
  const name = senderName(message);
  return {
    role: "user",
    content: structuredClone(message.content),
    ...(name ? { name } : {}),
  };
}

/** The viewer's own turn, with its tool calls and reasoning. */
function ownAssistantTurn(message: ConversationMessage): LlmMessage {
  const name = senderName(message);
  const toolCalls = embeddedToolCalls(message.metadata.llmToolCalls);
  const planId = toolPlanId(message);
  const reasoning = message.metadata.llmReasoning;
  const native = nativeReasoning(message.metadata.llmNativeReasoning);
  return {
    role: "assistant",
    content: structuredClone(message.content),
    ...(name ? { name } : {}),
    ...(toolCalls.length ? { toolCalls } : {}),
    ...(planId && toolCalls.length ? { toolPlanId: planId } : {}),
    ...(Array.isArray(reasoning)
      ? { reasoning: reasoning as NonNullable<AssistantMessage["reasoning"]> }
      : {}),
    ...(native ? { nativeReasoning: native } : {}),
  };
}

function toolTurn(message: ConversationMessage, callId: string): LlmMessage {
  const name = senderName(message);
  const planId = toolPlanId(message);
  return {
    role: "tool",
    content: structuredClone(message.content),
    toolCallId: callId,
    ...(planId ? { toolPlanId: planId } : {}),
    ...(name ? { name } : {}),
  };
}

function projectAgentMessage(
  message: ConversationMessage,
  viewerId: string,
): LlmMessage | null {
  const ask = agentAskMetadata(message.metadata);
  if (ask) {
    const view = ASK_VIEWS[ask.phase][askViewer(ask, viewerId)];
    if (view === "assistant") return ownAssistantTurn(message);
    // A progress turn that only carried tool calls has nothing for others to read.
    if (
      view === "hidden" ||
      (ask.phase === "progress" && !message.content.length)
    ) return null;
    return userTurn(message);
  }
  if (message.sender.id === viewerId) return ownAssistantTurn(message);
  return hasToolCalls(message) ? null : userTurn(message);
}

function projectToolMessage(
  message: ConversationMessage,
  viewerId: string,
): LlmMessage | null {
  const requesterId = optionalText(message.metadata.requesterId) ??
    workflowMetadata(message.metadata)?.agentParticipantId;
  const callId = toolCallId(message);
  if (callId && requesterId === viewerId) return toolTurn(message, callId);
  return message.metadata.historyVisibility === "public"
    ? userTurn(message)
    : null;
}

/** Decides whether and how one stored Message appears in the viewer's transcript. */
function projectMessage(
  message: ConversationMessage,
  viewerId: string,
): LlmMessage | null {
  // Failure receipts are for the human-facing timeline. Replaying one would
  // turn a transient provider failure into an instruction-bearing fact.
  if (agentFailureMetadata(message.metadata)) return null;
  switch (message.sender.participantType) {
    case "agent":
      return projectAgentMessage(message, viewerId);
    case "tool":
      return projectToolMessage(message, viewerId);
    default:
      return userTurn(message);
  }
}

/** Whether `answer` is the viewer's answer to the ask that `receipt` completed. */
function answersAskForViewer(
  receipt: ConversationMessage,
  answer: ConversationMessage | undefined,
  viewerId: string,
): answer is ConversationMessage {
  const result = agentAskResultMetadata(receipt.metadata);
  if (
    !result || result.status !== "completed" ||
    !answer || answer.id !== result.answerMessageId ||
    answer.sender.id !== result.askedParticipantId
  ) return false;
  const ask = agentAskMetadata(answer.metadata);
  return Boolean(
    ask && ask.phase === "answer" && ask.askId === result.askId &&
      ask.askingParticipantId === viewerId,
  );
}

/** Compiles immutable Core Messages into one participant's LLM history. */
export function buildLlmTranscript(
  input: Readonly<{
    threadId: string;
    history: readonly ConversationMessage[];
    messageIds?: readonly string[];
    participantId: string;
  }>,
): readonly LlmTranscriptEntry[] {
  const viewerId = input.participantId;
  const byId = new Map(input.history.map((message) => [message.id, message]));
  const selected = input.messageIds === undefined
    ? input.history
    : input.messageIds.map((id) => {
      const message = byId.get(id);
      if (!message) {
        throw new Error(
          `LLM input message '${id}' was not found in thread '${input.threadId}'.`,
        );
      }
      return message;
    });
  const selectedIds = new Set(selected.map((message) => message.id));

  // The asker receives an Ask answer at the receipt that closed the ask, as
  // that tool call's output. This applies only when both are selected; a
  // range that splits them keeps the answer in place, or leaves it to the
  // receipt's range.
  const answerByReceipt = new Map<string, ConversationMessage>();
  const movedAnswerIds = new Set<string>();
  for (const receipt of selected) {
    const answerId = agentAskResultMetadata(receipt.metadata)?.answerMessageId;
    if (
      !answerId || !selectedIds.has(answerId) || movedAnswerIds.has(answerId)
    ) continue;
    const answer = byId.get(answerId);
    if (!answersAskForViewer(receipt, answer, viewerId)) continue;
    answerByReceipt.set(receipt.id, answer);
    movedAnswerIds.add(answerId);
  }

  const entries: LlmTranscriptEntry[] = [];
  for (const message of selected) {
    if (movedAnswerIds.has(message.id)) continue;
    const projected = projectMessage(message, viewerId);
    const answer = answerByReceipt.get(message.id);
    if (answer && projected?.role === "tool") {
      entries.push({
        sourceId: answer.id,
        message: { ...projected, content: structuredClone(answer.content) },
      });
      continue;
    }
    if (projected) entries.push({ sourceId: message.id, message: projected });
    if (answer) {
      entries.push({ sourceId: answer.id, message: userTurn(answer) });
    }
  }
  return entries;
}
