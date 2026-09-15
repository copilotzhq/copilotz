import type { ConversationMessage } from "../../../core-collections/internal/contracts.ts";
import type {
  LlmJsonObject,
  LlmMessage,
  LlmNativeReasoning,
  LlmToolCall,
} from "@copilotz/copilotz/llm";
import {
  agentAskMetadata,
  agentAskResultMetadata,
  agentFailureMetadata,
  coreToolActionMessageMetadata,
  coreToolPlanMetadata,
  coreToolPlanResultMetadata,
  coreToolResultOrigin,
  workflowMetadata,
} from "../workflow-metadata.ts";

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function optionalText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function messageName(message: ConversationMessage): string | undefined {
  return optionalText(message.sender.name) ??
    optionalText(message.sender.externalId);
}

function embeddedToolCalls(value: unknown): readonly LlmToolCall[] {
  if (!Array.isArray(value)) return ([] as const);
  return (value.map((candidate, index) => {
    const call = record(candidate);
    const id = optionalText(call.id);
    const action = optionalText(call.action);
    const input = record(call.input);
    if (!id || !action) {
      throw new TypeError(
        `Assistant message tool call ${index} is missing its id or Action alias.`,
      );
    }
    return ({
      id,
      action,
      input: structuredClone(input) as LlmJsonObject,
    } as const);
  }));
}

function toolCallId(message: ConversationMessage): string | undefined {
  const toolAction = coreToolActionMessageMetadata(message.metadata);
  if (toolAction?.toolCallId) return toolAction.toolCallId;
  const branch = coreToolPlanResultMetadata(message.metadata);
  if (branch?.origin.toolCallId) return branch.origin.toolCallId;
  return optionalText(record(record(message.metadata).toolInvocation).id);
}

function toolPlanId(message: ConversationMessage): string | undefined {
  return coreToolPlanMetadata(message.metadata)?.planId ??
    coreToolResultOrigin(message.metadata)?.planId;
}

/** Maps one canonical Message into the provider-neutral LLM history contract. */
function projectMessage(
  message: ConversationMessage,
  targetParticipantId?: string,
): LlmMessage | null {
  // A public failure receipt is for the human-facing timeline only. Replaying
  // it into a later Model request would turn a transient provider failure into
  // an instruction-bearing conversation fact.
  if (agentFailureMetadata(message.metadata)) return null;
  const content = structuredClone(message.content);
  const name = messageName(message);
  if (message.sender.participantType === "agent") {
    const ask = agentAskMetadata(message.metadata);
    if (ask) {
      const mode = ask.mode ?? "public";
      if (ask.phase === "question") {
        if (targetParticipantId === ask.askedParticipantId) {
          return ({
            role: "user",
            content,
            ...(name ? { name } : {}),
          } as const);
        }
        return targetParticipantId === ask.askingParticipantId ||
            mode === "private"
          ? null
          : ({ role: "user", content, ...(name ? { name } : {}) } as const);
      }
      if (ask.phase === "progress") {
        if (targetParticipantId === ask.askedParticipantId) {
          const toolCalls = embeddedToolCalls(message.metadata.llmToolCalls);
          const planId = toolPlanId(message);
          return ({
            role: "assistant",
            content,
            ...(name ? { name } : {}),
            ...(toolCalls.length ? { toolCalls } : {}),
            ...(planId && toolCalls.length ? { toolPlanId: planId } : {}),
          } as const);
        }
        return mode === "public" && content.length
          ? ({ role: "user", content, ...(name ? { name } : {}) } as const)
          : null;
      }
      if (targetParticipantId === ask.askingParticipantId) {
        return ({
          role: "user",
          content,
          ...(name ? { name } : {}),
        } as const);
      }
      if (targetParticipantId === ask.askedParticipantId) {
        return ({
          role: "assistant",
          content,
          ...(name ? { name } : {}),
        } as const);
      }
      return mode === "private"
        ? null
        : ({ role: "user", content, ...(name ? { name } : {}) } as const);
    }
    if (targetParticipantId && message.sender.id === targetParticipantId) {
      const toolCalls = embeddedToolCalls(message.metadata.llmToolCalls);
      const planId = toolPlanId(message);
      return ({
        role: "assistant",
        content,
        ...(name ? { name } : {}),
        ...(toolCalls.length ? { toolCalls } : {}),
        ...(planId && toolCalls.length ? { toolPlanId: planId } : {}),
      } as const);
    }
    if (embeddedToolCalls(message.metadata.llmToolCalls).length) return null;
    return ({ role: "user", content, ...(name ? { name } : {}) } as const);
  }
  if (message.sender.participantType === "tool") {
    const requesterId = optionalText(message.metadata.requesterId) ??
      workflowMetadata(message.metadata)?.agentParticipantId;
    const id = toolCallId(message);
    const planId = toolPlanId(message);
    if (id && requesterId === targetParticipantId) {
      return ({
        role: "tool",
        content,
        toolCallId: id,
        ...(planId ? { toolPlanId: planId } : {}),
        ...(name ? { name } : {}),
      } as const);
    }
    const historyVisibility = optionalText(
      message.metadata.historyVisibility,
    ) ?? "public_status";
    if (historyVisibility !== "public") return null;
  }
  return ({ role: "user", content, ...(name ? { name } : {}) } as const);
}

function toLlmMessage(
  message: ConversationMessage,
  targetParticipantId?: string,
): LlmMessage | null {
  const projected = projectMessage(message, targetParticipantId);
  if (
    projected?.role !== "assistant" ||
    message.sender.id !== targetParticipantId
  ) return projected;
  const metadata = record(message.metadata);
  const native = metadata.llmNativeReasoning;
  const nativeReasoning = native && typeof native === "object" &&
      !Array.isArray(native) &&
      (native as Record<string, unknown>).schema ===
        "copilotz.llm-native-reasoning.v1" &&
      typeof (native as Record<string, unknown>).adapter === "string" &&
      typeof (native as Record<string, unknown>).api === "string" &&
      typeof (native as Record<string, unknown>).model === "string" &&
      Array.isArray((native as Record<string, unknown>).blocks)
    ? structuredClone(native) as LlmNativeReasoning
    : undefined;
  return {
    ...projected,
    ...(Array.isArray(metadata.llmReasoning)
      ? {
        reasoning: metadata
          .llmReasoning as import("@copilotz/copilotz/content").ContentSequence,
      }
      : {}),
    ...(nativeReasoning ? { nativeReasoning } : {}),
  };
}

function receiptAnswer(
  receipt: ConversationMessage,
  answer: ConversationMessage | undefined,
  targetParticipantId?: string,
): LlmMessage | null {
  const result = agentAskResultMetadata(receipt.metadata);
  if (
    !result || result.status !== "completed" || !result.answerMessageId ||
    !answer || answer.id !== result.answerMessageId ||
    answer.sender.id !== result.askedParticipantId ||
    targetParticipantId === undefined
  ) return null;
  const ask = agentAskMetadata(answer.metadata);
  if (
    !ask || ask.phase !== "answer" || ask.askId !== result.askId ||
    ask.askingParticipantId !== targetParticipantId
  ) return null;
  const name = messageName(answer);
  return ({
    role: "user",
    content: structuredClone(answer.content),
    ...(name ? { name } : {}),
  } as const);
}

/** Compiles immutable Core Messages into participant-relative LLM history. */
export function buildLlmTranscript(
  input: Readonly<{
    threadId: string;
    history: readonly ConversationMessage[];
    messageIds?: readonly string[];
    participantId?: string;
  }>,
  onSelectedSource?: (messageId: string) => void,
): readonly LlmMessage[] {
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
  const answers = new Map<string, { id: string; message: LlmMessage }>();
  const deferredAnswers = new Set<string>();
  for (const receipt of selected) {
    const id = agentAskResultMetadata(receipt.metadata)?.answerMessageId;
    if (!id || !selectedIds.has(id)) continue;
    const answer = receiptAnswer(receipt, byId.get(id), input.participantId);
    if (answer && !deferredAnswers.has(id)) {
      answers.set(receipt.id, { id, message: answer });
      deferredAnswers.add(id);
    }
  }
  const output: LlmMessage[] = [];
  for (const message of selected) {
    // Keep existing receipt order when both records are present. A prefix ending
    // before the receipt still includes the answer; a tail never reloads content
    // already covered by its summary.
    if (!deferredAnswers.has(message.id)) {
      const projected = toLlmMessage(message, input.participantId);
      if (projected) {
        output.push(projected);
        onSelectedSource?.(message.id);
      }
    }
    const answer = answers.get(message.id);
    if (answer) {
      output.push(answer.message);
      onSelectedSource?.(answer.id);
    }
  }
  return output;
}
