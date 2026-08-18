import type { CollectionRecord } from "../collections/index.ts";
import type { ContentSequence } from "../content/index.ts";
import type { LlmAttempt } from "../domain/index.ts";
import { LLM_CONTENT_ROLE } from "../content/index.ts";
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

function contentSequence(value: unknown): ContentSequence {
  if (!Array.isArray(value)) return Object.freeze([]);
  return Object.freeze(value) as ContentSequence;
}

function withErrorDetail(
  current: ContentSequence,
  detail?: ContentSequence,
): ContentSequence {
  if (!detail?.length) return current;
  return Object.freeze([
    ...current.filter((ref) => ref.role !== LLM_CONTENT_ROLE.errorDetail),
    ...detail.map((ref) => ({ ...ref, role: LLM_CONTENT_ROLE.errorDetail })),
  ]);
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
    await context.transaction({
      operationKey: `provider:${lifecycle.attemptIndex}:create`,
      namespace: context.namespace,
      identity: { metadata },
      execute: async ({ collections }) => {
        await collections.llm_attempt.create({
          id,
          threadId: parent.threadId,
          ...(parent.messageId ? { messageId: parent.messageId } : {}),
          ...(parent.participantId
            ? { participantId: parent.participantId }
            : {}),
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
          namespace: context.namespace,
          threadId: parent.threadId,
          identity: { metadata },
        });
      },
    });
    return;
  }

  const usage = lifecycle.record.usage as unknown as Record<string, unknown>;
  const cost = lifecycle.record.cost as unknown as
    | Record<string, unknown>
    | undefined;
  if (lifecycle.status === "completed") {
    await context.transaction({
      operationKey: `provider:${lifecycle.attemptIndex}:complete`,
      namespace: context.namespace,
      identity: { metadata },
      execute: async ({ collections }) => {
        const current = await collections.llm_attempt.get(id, context.namespace);
        if (!current) throw new Error(`LLM attempt '${id}' was not found.`);
        await collections.llm_attempt.mutate(id, "complete", {
          usage,
          ...(cost ? { cost } : {}),
          finishedAt: lifecycle.finishedAt,
          metricsFinalizedAt: lifecycle.finishedAt,
          metadata: { ...asRecord(current.metadata), recoveryAction: lifecycle.recoveryAction },
        }, {
          namespace: context.namespace,
          threadId: parent.threadId,
          identity: { metadata },
        });
      },
    });
    return;
  }
  if (lifecycle.status === "superseded") {
    await context.transaction({
      operationKey: `provider:${lifecycle.attemptIndex}:supersede`,
      namespace: context.namespace,
      identity: { metadata },
      execute: async ({ collections }) => {
        const current = await collections.llm_attempt.get(id, context.namespace);
        if (!current) throw new Error(`LLM attempt '${id}' was not found.`);
        await collections.llm_attempt.update(id, {
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
          namespace: context.namespace,
          threadId: parent.threadId,
          identity: { metadata },
        });
      },
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
  const current = await context.collectionRuntime.get("llm_attempt")?.get(
    id,
    context.namespace,
  );
  if (!current) throw new Error(`LLM attempt '${id}' was not found.`);
  const materialized = detail
    ? await context.content.materialize(detail, {
      origin: {
        scope: { type: "thread", id: parent.threadId },
        producer: { type: "llm_attempt", id },
      },
    })
    : undefined;
  const content = withErrorDetail(contentSequence(current.content), materialized);
  await context.transaction({
    operationKey: `provider:${lifecycle.attemptIndex}:fail`,
    namespace: context.namespace,
    identity: { metadata },
    execute: async ({ collections }) => {
      await collections.llm_attempt.mutate(id, "fail", {
        message: "LLM provider attempt failed.",
        code: lifecycle.record.error?.reason ?? "provider_error",
        content,
        usage,
        ...(cost ? { cost } : {}),
        finishedAt: lifecycle.finishedAt,
        metadata: { ...asRecord(current.metadata), recoveryAction: lifecycle.recoveryAction },
      }, {
        namespace: context.namespace,
        threadId: parent.threadId,
        identity: { metadata },
      });
    },
  });
  if (content.length) await context.content.linkOwner(id, content);
}
