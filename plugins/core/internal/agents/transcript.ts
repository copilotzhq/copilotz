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
  coreToolActionMessageMetadata,
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
    if (targetParticipantId && message.sender.id === targetParticipantId) {
      const toolCalls = embeddedToolCalls(message.metadata.llmToolCalls);
      return Object.freeze({
        role: "assistant",
        content,
        ...(name ? { name } : {}),
        ...(toolCalls.length ? { toolCalls } : {}),
      });
    }
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
  return Object.freeze(
    selected.flatMap((message) => {
      const projected = toLlmMessage(message, input.participantId);
      return projected ? [projected] : [];
    }),
  );
}
