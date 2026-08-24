import type { ConversationMessage } from "../../contracts.ts";
import type { ProcessorContext } from "@copilotz/copilotz/plugins";
import type {
  LlmJsonObject,
  LlmMessage,
  LlmToolCall,
} from "@copilotz/copilotz/llm";
import {
  listThreadMessageRecords,
  loadThreadRecord,
} from "../../projections.ts";
import {
  agentAskMetadata,
  agentAskResultMetadata,
  coreToolActionMessageMetadata,
  coreToolPlanResultMetadata,
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
  if (!Array.isArray(value)) return Object.freeze([]);
  return Object.freeze(value.map((candidate, index) => {
    const call = record(candidate);
    const id = optionalText(call.id);
    const action = optionalText(call.action);
    const input = record(call.input);
    if (!id || !action) {
      throw new TypeError(
        `Assistant message tool call ${index} is missing its id or Action alias.`,
      );
    }
    return Object.freeze({
      id,
      action,
      input: structuredClone(input) as LlmJsonObject,
    });
  }));
}

function toolCallId(message: ConversationMessage): string | undefined {
  const toolAction = coreToolActionMessageMetadata(message.metadata);
  if (toolAction?.toolCallId) return toolAction.toolCallId;
  const branch = coreToolPlanResultMetadata(message.metadata);
  if (branch?.origin.toolCallId) return branch.origin.toolCallId;
  return optionalText(record(record(message.metadata).toolInvocation).id);
}

/** Maps one canonical Message into the provider-neutral LLM history contract. */
function toLlmMessage(
  message: ConversationMessage,
  targetParticipantId?: string,
): LlmMessage | null {
  const content = Object.freeze(structuredClone(message.content));
  const name = messageName(message);
  if (message.sender.participantType === "agent") {
    const ask = agentAskMetadata(message.metadata);
    if (ask) {
      const mode = ask.mode ?? "public";
      if (ask.phase === "question") {
        if (targetParticipantId === ask.askedParticipantId) {
          return Object.freeze({
            role: "user",
            content,
            ...(name ? { name } : {}),
          });
        }
        return targetParticipantId === ask.askingParticipantId ||
            mode === "private"
          ? null
          : Object.freeze({ role: "user", content, ...(name ? { name } : {}) });
      }
      if (ask.phase === "progress") {
        if (targetParticipantId === ask.askedParticipantId) {
          const toolCalls = embeddedToolCalls(message.metadata.llmToolCalls);
          return Object.freeze({
            role: "assistant",
            content,
            ...(name ? { name } : {}),
            ...(toolCalls.length ? { toolCalls } : {}),
          });
        }
        return mode === "public" && content.length
          ? Object.freeze({ role: "user", content, ...(name ? { name } : {}) })
          : null;
      }
      // The caller receives this answer only through the receipt below.
      if (targetParticipantId === ask.askingParticipantId) return null;
      if (targetParticipantId === ask.askedParticipantId) {
        return Object.freeze({
          role: "assistant",
          content,
          ...(name ? { name } : {}),
        });
      }
      return mode === "private"
        ? null
        : Object.freeze({ role: "user", content, ...(name ? { name } : {}) });
    }
    if (targetParticipantId && message.sender.id === targetParticipantId) {
      const toolCalls = embeddedToolCalls(message.metadata.llmToolCalls);
      return Object.freeze({
        role: "assistant",
        content,
        ...(name ? { name } : {}),
        ...(toolCalls.length ? { toolCalls } : {}),
      });
    }
    if (embeddedToolCalls(message.metadata.llmToolCalls).length) return null;
    return Object.freeze({ role: "user", content, ...(name ? { name } : {}) });
  }
  if (message.sender.participantType === "tool") {
    const requesterId = optionalText(message.metadata.requesterId) ??
      workflowMetadata(message.metadata)?.agentParticipantId;
    const id = toolCallId(message);
    if (id && requesterId === targetParticipantId) {
      return Object.freeze({
        role: "tool",
        content,
        toolCallId: id,
        ...(name ? { name } : {}),
      });
    }
    const historyVisibility = optionalText(
      message.metadata.historyVisibility,
    ) ?? "public_status";
    if (historyVisibility !== "public") return null;
  }
  return Object.freeze({ role: "user", content, ...(name ? { name } : {}) });
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
  return Object.freeze({
    role: "user",
    content: Object.freeze(structuredClone(answer.content)),
    ...(name ? { name } : {}),
  });
}

/** Compiles immutable Core Messages into participant-relative LLM history. */
export async function buildLlmTranscript(
  context: ProcessorContext,
  input: Readonly<{
    threadId: string;
    messageIds?: readonly string[];
    participantId?: string;
  }>,
): Promise<readonly LlmMessage[]> {
  const thread = await loadThreadRecord(context, input.threadId);
  if (!thread) throw new Error(`Thread '${input.threadId}' was not found.`);
  const history = await listThreadMessageRecords(context, input.threadId);
  const selected = input.messageIds?.length
    ? (() => {
      const byId = new Map(history.map((message) => [message.id, message]));
      return input.messageIds.map((id) => {
        const message = byId.get(id);
        if (!message) {
          throw new Error(
            `LLM input message '${id}' was not found in thread '${input.threadId}'.`,
          );
        }
        return message;
      });
    })()
    : history;
  const byId = new Map(history.map((message) => [message.id, message]));
  const output: LlmMessage[] = [];

  const appendNormal = (message: ConversationMessage) => {
    const projected = toLlmMessage(message, input.participantId);
    if (projected) output.push(projected);
  };
  for (let index = 0; index < selected.length;) {
    const plan = selected[index];
    const planProjection = plan && toLlmMessage(plan, input.participantId);
    const toolIds = planProjection?.role === "assistant"
      ? new Set((planProjection.toolCalls ?? []).map((call) => call.id))
      : new Set<string>();
    if (!planProjection || toolIds.size === 0) {
      if (plan) appendNormal(plan);
      index++;
      continue;
    }
    output.push(planProjection);
    const receipts: ConversationMessage[] = [];
    const deferred: ConversationMessage[] = [];
    const seen = new Set<string>();
    index++;
    while (index < selected.length && seen.size < toolIds.size) {
      const candidate = selected[index++]!;
      const projected = toLlmMessage(candidate, input.participantId);
      if (
        projected?.role === "tool" && projected.toolCallId &&
        toolIds.has(projected.toolCallId)
      ) {
        receipts.push(candidate);
        seen.add(projected.toolCallId);
      } else deferred.push(candidate);
    }
    // A model may only see peer text after every result for its own call block.
    for (const receipt of receipts) appendNormal(receipt);
    const receiptsByAnswerId = new Map(
      receipts.flatMap((receipt) => {
        const result = agentAskResultMetadata(receipt.metadata);
        return result?.answerMessageId
          ? [[result.answerMessageId, receipt]]
          : [];
      }),
    );
    // Preserve public nested causality after the closed Tool block. Keep
    // nested peer messages in their durable order, but reserve direct root
    // answers for the provider-order receipt sequence below.
    for (const message of deferred) {
      if (receiptsByAnswerId.has(message.id)) continue;
      appendNormal(message);
    }
    for (const [id, receipt] of receiptsByAnswerId) {
      const answer = receiptAnswer(receipt, byId.get(id), input.participantId);
      if (answer) output.push(answer);
    }
  }
  return Object.freeze(output);
}
