import type { CopilotzApplication } from "../runtime/application/index.ts";
import type { AssetRecord, ContentRef } from "../runtime/content/index.ts";
import {
  type ConversationMessage,
  type LlmAttempt,
  llmAttemptContent,
  type ToolExecution,
  toolExecutionContent,
} from "../runtime/domain/index.ts";

export type EventNativeHistoryInclude = "content" | "workflow";

/** JSON transport representation of canonical resolved content. */
export type EventNativeResolvedContent = Readonly<{
  ref: ContentRef;
  asset: AssetRecord;
  base64: string;
}>;

/** Canonical related resources for one message page. */
export type EventNativeMessageHistoryIncluded = Readonly<{
  llmAttempts: readonly LlmAttempt[];
  toolExecutions: readonly ToolExecution[];
  content: readonly EventNativeResolvedContent[];
}>;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function workflowMetadata(
  message: ConversationMessage,
): Record<string, unknown> {
  return record(message.metadata.copilotzWorkflow);
}

function uniqueById<T extends { id: string }>(values: readonly T[]): T[] {
  return [...new Map(values.map((value) => [value.id, value])).values()];
}

function uniqueRefs(refs: readonly ContentRef[]): ContentRef[] {
  const values = new Map<string, ContentRef>();
  for (const ref of refs) {
    const key = JSON.stringify([
      ref.assetId,
      ref.kind,
      ref.role,
      ref.mediaType,
      ref.name ?? null,
      ref.disposition ?? null,
    ]);
    if (!values.has(key)) values.set(key, ref);
  }
  return [...values.values()];
}

function decodeToolCallIds(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return Object.freeze([]);
  return Object.freeze(value.flatMap((candidate) => {
    const id = text(record(candidate).id);
    return id ? [id] : [];
  }));
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
  }
  return btoa(binary);
}

/**
 * Resolves the canonical workflow resources and immutable content bodies that
 * belong to a message page. It does not flatten or duplicate domain fields.
 */
export async function createEventNativeMessageHistoryIncluded(
  application: CopilotzApplication,
  namespace: string,
  threadId: string,
  messages: readonly ConversationMessage[],
  includes: ReadonlySet<EventNativeHistoryInclude>,
): Promise<EventNativeMessageHistoryIncluded | undefined> {
  if (includes.size === 0) return undefined;

  const attemptIds = new Set<string>();
  const executionIds = new Set<string>();
  const sourceMessageByAttempt = new Map<string, string>();
  for (const message of messages) {
    const workflow = workflowMetadata(message);
    const attemptId = text(workflow.llmAttemptId);
    const executionId = text(workflow.toolExecutionId);
    if (attemptId) attemptIds.add(attemptId);
    if (executionId) executionIds.add(executionId);
    if (
      attemptId && workflow.kind === "agent_output" &&
      message.sender.participantType === "agent"
    ) {
      sourceMessageByAttempt.set(attemptId, message.id);
    }
  }

  const llmAttempts = includes.has("workflow")
    ? uniqueById((await Promise.all(
      [...attemptIds].map((id) => application.llmAttempts.get(namespace, id)),
    )).filter((value): value is LlmAttempt => value !== null))
    : [];

  const attemptToolCallRefs = llmAttempts.flatMap((attempt) => {
    const ref = llmAttemptContent(attempt).toolCalls;
    return ref ? [{ attempt, ref }] : [];
  });
  const resolvedToolCalls = attemptToolCallRefs.length
    ? await application.content.resolver.getMany(
      attemptToolCallRefs.map(({ ref }) => ref),
      {
        namespace,
      },
    )
    : [];
  const executionsByCall = includes.has("workflow")
    ? (await Promise.all(
      resolvedToolCalls.flatMap((resolved, index) => {
        const attempt = attemptToolCallRefs[index]?.attempt;
        const sourceMessageId = attempt
          ? sourceMessageByAttempt.get(attempt.id)
          : undefined;
        if (!sourceMessageId) return [];
        return decodeToolCallIds(resolved.value).map((id) =>
          application.toolExecutions.getByMessageToolCallId(
            namespace,
            threadId,
            sourceMessageId,
            id,
          )
        );
      }),
    )).filter((value): value is ToolExecution => value !== null)
    : [];
  const executionsById = includes.has("workflow")
    ? (await Promise.all(
      [...executionIds].map((id) =>
        application.toolExecutions.get(namespace, id)
      ),
    )).filter((value): value is ToolExecution => value !== null)
    : [];
  const toolExecutions = uniqueById([
    ...executionsByCall,
    ...executionsById,
  ]);

  const refs = uniqueRefs([
    ...messages.flatMap((message) => message.content),
    ...(includes.has("content")
      ? llmAttempts.flatMap((attempt) => {
        const content = llmAttemptContent(attempt);
        return [
          ...(content.reasoning ? [content.reasoning] : []),
          ...(content.toolCalls ? [content.toolCalls] : []),
        ];
      })
      : []),
    ...(includes.has("content")
      ? toolExecutions.flatMap((execution) => {
        const content = toolExecutionContent(execution);
        return [
          content.arguments,
          ...(content.projectedOutput ? [content.projectedOutput] : []),
          ...(!content.projectedOutput && content.output
            ? [content.output]
            : []),
          ...(content.errorDetail ? [content.errorDetail] : []),
          ...content.attachments,
        ];
      })
      : []),
  ]);
  const resolved = includes.has("content") && refs.length
    ? await application.content.resolver.getMany(refs, { namespace })
    : [];

  return Object.freeze({
    llmAttempts: Object.freeze(llmAttempts),
    toolExecutions: Object.freeze(toolExecutions),
    content: Object.freeze(resolved.map((value) =>
      Object.freeze({
        ref: value.ref,
        asset: value.asset,
        base64: base64(value.bytes),
      })
    )),
  });
}
