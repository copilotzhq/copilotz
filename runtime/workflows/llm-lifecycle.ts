import type { LlmAttempt, SafeWorkflowError } from "../domain/index.ts";
import type { CopilotzProcessorContext } from "../engine/index.ts";
import type { LLMAttemptLifecycleEvent } from "../llm/types.ts";
import { withWorkflowMetadata } from "./resources.ts";

function providerSafeError(
  code: string,
  message: string,
): SafeWorkflowError {
  return Object.freeze({
    name: "LlmProviderError",
    message,
    code,
    retryable: false,
  });
}

export function providerAttemptId(parentId: string, index: number): string {
  return `${parentId}:provider:${index}`;
}

export function providerAttemptMetadata(
  parent: LlmAttempt,
  lifecycle: LLMAttemptLifecycleEvent,
): Record<string, unknown> {
  return withWorkflowMetadata({
    runtimeAttemptId: lifecycle.attemptId,
  }, {
    kind: "provider_attempt",
    parentLlmAttemptId: parent.id,
    agentParticipantId: parent.participantId,
  });
}

export async function recordProviderAttemptLifecycle(
  parent: LlmAttempt,
  lifecycle: LLMAttemptLifecycleEvent,
  context: CopilotzProcessorContext,
): Promise<void> {
  const id = providerAttemptId(parent.id, lifecycle.attemptIndex);
  const metadata = providerAttemptMetadata(parent, lifecycle);
  if (lifecycle.phase === "started") {
    await context.llmAttempts.create({
      id,
      threadId: parent.threadId,
      messageId: parent.messageId,
      participantId: parent.participantId,
      initiatorParticipantId: parent.initiatorParticipantId,
      agentId: parent.agentId,
      provider: lifecycle.provider,
      model: lifecycle.model,
      status: "running",
      attemptIndex: lifecycle.attemptIndex,
      parentAttemptId: parent.id,
      inputMessageIds: parent.inputMessageIds,
      availableToolIds: parent.availableToolIds,
      startedAt: lifecycle.startedAt,
      metadata,
    }, {
      operationKey: `provider:${lifecycle.attemptIndex}:create`,
      metadata,
    });
    return;
  }

  const usage = lifecycle.record.usage as unknown as Record<string, unknown>;
  const cost = lifecycle.record.cost as unknown as
    | Record<string, unknown>
    | undefined;
  if (lifecycle.status === "completed") {
    await context.llmAttempts.complete({
      id,
      usage,
      ...(cost ? { cost } : {}),
      finishedAt: lifecycle.finishedAt,
      metricsFinalizedAt: lifecycle.finishedAt,
      metadataPatch: { recoveryAction: lifecycle.recoveryAction },
    }, {
      operationKey: `provider:${lifecycle.attemptIndex}:complete`,
      metadata,
    });
    return;
  }
  if (lifecycle.status === "superseded") {
    await context.llmAttempts.update({
      id,
      status: "superseded",
      usage,
      ...(cost ? { cost } : {}),
      metricsFinalizedAt: lifecycle.finishedAt,
      metadataPatch: { recoveryAction: lifecycle.recoveryAction },
    }, {
      operationKey: `provider:${lifecycle.attemptIndex}:supersede`,
      metadata,
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
  await context.llmAttempts.fail({
    id,
    safeError: providerSafeError(
      lifecycle.record.error?.reason ?? "provider_error",
      "LLM provider attempt failed.",
    ),
    ...(detail ? { errorDetail: detail } : {}),
    usage,
    ...(cost ? { cost } : {}),
    finishedAt: lifecycle.finishedAt,
    metadataPatch: { recoveryAction: lifecycle.recoveryAction },
  }, {
    operationKey: `provider:${lifecycle.attemptIndex}:fail`,
    metadata,
  });
}
