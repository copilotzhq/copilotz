import type { CollectionRecord } from "../collections/index.ts";
import type { LlmAttempt } from "../domain/index.ts";
import type { CopilotzProcessorContext } from "../engine/index.ts";
import { mapLlmAttemptRecord } from "../engine/collection-graph.ts";
import { withWorkflowMetadata } from "../events/workflow-metadata.ts";
import type { LLMAttemptLifecycleEvent } from "./types.ts";

export function providerAttemptId(parentId: string, index: number): string {
  return `${parentId}:provider:${index}`;
}

export function providerAttemptMetadata(
  parent: LlmAttempt | CollectionRecord,
  lifecycle: LLMAttemptLifecycleEvent,
): Record<string, unknown> {
  const attempt = mapLlmAttemptRecord(parent as CollectionRecord);
  return withWorkflowMetadata({
    runtimeAttemptId: lifecycle.attemptId,
  }, {
    kind: "provider_attempt",
    parentLlmAttemptId: attempt.id,
    agentParticipantId: attempt.participantId,
  });
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export async function recordProviderAttemptLifecycle(
  parentInput: LlmAttempt | CollectionRecord,
  lifecycle: LLMAttemptLifecycleEvent,
  context: CopilotzProcessorContext,
): Promise<void> {
  const parent = mapLlmAttemptRecord(parentInput as CollectionRecord);
  const id = providerAttemptId(parent.id, lifecycle.attemptIndex);
  const metadata = providerAttemptMetadata(parent, lifecycle);
  if (lifecycle.phase === "started") {
    await context.collections.llm_attempt.create({
      id,
      threadId: parent.threadId,
      ...(parent.messageId ? { messageId: parent.messageId } : {}),
      ...(parent.participantId ? { participantId: parent.participantId } : {}),
      ...(parent.initiatorParticipantId
        ? { initiatorParticipantId: parent.initiatorParticipantId }
        : {}),
      ...(parent.agentId ? { agentId: parent.agentId } : {}),
      provider: lifecycle.provider,
      model: lifecycle.model,
      status: "running",
      attemptIndex: lifecycle.attemptIndex,
      parentAttemptId: parent.id,
      inputMessageIds: [...parent.inputMessageIds],
      availableToolIds: [...parent.availableToolIds],
      startedAt: lifecycle.startedAt,
      metadata,
    }, {
      operationKey: `provider:${lifecycle.attemptIndex}:create`,
      threadId: parent.threadId,
      identity: { metadata },
    });
    return;
  }

  const usage = lifecycle.record.usage as unknown as Record<string, unknown>;
  const cost = lifecycle.record.cost as unknown as
    | Record<string, unknown>
    | undefined;
  const current = await context.collections.llm_attempt.get({ id });
  if (!current) throw new Error(`LLM attempt '${id}' was not found.`);

  if (lifecycle.status === "completed") {
    await context.collections.llm_attempt.commands.complete({
      id,
      usage,
      ...(cost ? { cost } : {}),
      finishedAt: lifecycle.finishedAt,
      metricsFinalizedAt: lifecycle.finishedAt,
      metadata: {
        ...asRecord(current.metadata),
        recoveryAction: lifecycle.recoveryAction,
      },
    }, {
      operationKey: `provider:${lifecycle.attemptIndex}:complete`,
      threadId: parent.threadId,
      identity: { metadata },
    });
    return;
  }
  if (lifecycle.status === "superseded") {
    await context.collections.llm_attempt.update({
      id,
      set: {
        status: "superseded",
        usage,
        ...(cost ? { cost } : {}),
        metricsFinalizedAt: lifecycle.finishedAt,
        metadata: {
          ...asRecord(current.metadata),
          recoveryAction: lifecycle.recoveryAction,
        },
      },
    }, {
      operationKey: `provider:${lifecycle.attemptIndex}:supersede`,
      threadId: parent.threadId,
      identity: { metadata },
    });
    return;
  }

  const detail = lifecycle.record.error
    ? await context.content.prepare({
      type: "json",
      value: lifecycle.record.error,
      role: "provider.error_detail",
    }, { operationKey: `provider:${lifecycle.attemptIndex}:error` })
    : undefined;
  await context.features.llmAttempt.fail({
    id,
    safeError: {
      message: "LLM provider attempt failed.",
      code: lifecycle.record.error?.reason ?? "provider_error",
    },
    ...(detail ? { errorDetail: detail } : {}),
    usage,
    ...(cost ? { cost } : {}),
    finishedAt: lifecycle.finishedAt,
    metadataPatch: { recoveryAction: lifecycle.recoveryAction },
  }, {
    operationKey: `provider:${lifecycle.attemptIndex}:fail`,
    identity: { metadata },
  });
}
