/** Capture and preparation of consolidation context. @module */
import {
  type AgentResource,
  collectContextContributions,
  type ContextSourceRef,
  type ConversationMessage,
  type ConversationThread,
  type FrozenContextContribution,
  type Participant,
} from "@copilotz/copilotz/core";
import type {
  ContentRef,
  PreparedAsset,
  PreparedContent,
} from "@copilotz/copilotz/content";
import type { CollectionRecord } from "@copilotz/copilotz/collections";

import { MEMORY_RESOURCE_ID } from "../resources/promptContext/memory/index.ts";
import type { MemoryProcessorContext } from "./contracts.ts";
import { optionalText, record, requiredText } from "./input.ts";

function combinePrepared(values: readonly PreparedContent[]): PreparedContent {
  const assets = new Map<string, PreparedAsset>();
  for (const value of values) {
    for (const asset of value.assets) assets.set(asset.id, asset);
  }
  return ({
    content: values.flatMap((value) => value.content),
    assets: [...assets.values()] as const,
  } as const);
}

export function frozenSnapshot(
  value: CollectionRecord,
): readonly FrozenContextContribution[] {
  if (!Array.isArray(value.contextSnapshot)) return ([] as const);
  return (value.contextSnapshot.flatMap((item) => {
    const input = record(item);
    if (!Array.isArray(input.content)) return [];
    const role = input.role === "evidence" ? "evidence" : "context";
    return [
      {
        id: requiredText(input.id, "Frozen context id"),
        resourceId: requiredText(
          input.resourceId,
          "Frozen context resource id",
        ),
        title: requiredText(input.title, "Frozen context title"),
        role,
        ...(input.placement === "before_latest_message"
          ? { placement: "before_latest_message" as const }
          : {}),
        content: structuredClone(input.content) as ContentRef[],
        ...(input.source
          ? { source: structuredClone(input.source) as ContextSourceRef }
          : {}),
        capturedAt: requiredText(
          input.capturedAt,
          "Frozen context capture time",
        ),
        ...(optionalText(input.historyAfterMessageId)
          ? { historyAfterMessageId: optionalText(input.historyAfterMessageId) }
          : {}),
      } as const,
    ];
  }));
}

export async function captureContextSnapshot(
  context: MemoryProcessorContext,
  input: Readonly<{
    checkpoint: CollectionRecord;
    agent: AgentResource;
    participant: Participant;
    thread: ConversationThread;
    rangeMessages: readonly ConversationMessage[];
  }>,
) {
  let checkpoint = input.checkpoint;
  for (;;) {
    context.signal.throwIfAborted();
    const existing = frozenSnapshot(checkpoint);
    if (existing.length || Array.isArray(checkpoint.contextSnapshot)) {
      return existing;
    }
    const contributed = await collectContextContributions(context, {
      purpose: "conversation",
      agent: input.agent,
      participant: input.participant,
      thread: input.thread,
      sourceRange: {
        startMessageId: requiredText(
          checkpoint.sourceStartMessageId,
          "Memory source start",
        ),
        endMessageId: requiredText(
          checkpoint.sourceEndMessageId,
          "Memory source end",
        ),
        messages: input.rangeMessages,
      },
    });
    const capturedAt = new Date().toISOString();
    const prepared = await Promise.all(
      contributed.map((item) =>
        context.content.prepare(item.content, {
          operationKey:
            `context:${checkpoint.id}:${item.resourceId}:${item.id}`,
        })
      ),
    );
    const snapshot = contributed.map((item, index) => ({
      id: item.id,
      resourceId: item.resourceId,
      title: item.title,
      role: item.role,
      ...(item.placement ? { placement: item.placement } : {}),
      content: prepared[index].content,
      ...(item.source ? { source: structuredClone(item.source) } : {}),
      capturedAt: item.capturedAt ?? capturedAt,
      ...(item.resourceId === MEMORY_RESOURCE_ID && item.historyAfterMessageId
        ? { historyAfterMessageId: item.historyAfterMessageId }
        : {}),
    } as const));
    try {
      await context.collections.longTermMemory.update(
        {
          id: checkpoint.id,
          set: {
            contextSnapshotContent: combinePrepared(prepared),
            contextSnapshot: snapshot,
            metadata: {
              ...record(checkpoint.metadata),
              contextCapturedAt: capturedAt,
            },
          },
        },
        {
          operationKey: `checkpoint:${checkpoint.id}:context`,
          condition: {
            current: {
              where: {
                status: "pending",
                // Keep the compare-and-set predicate scalar and bounded. The
                // mutation timestamp fences every concurrent checkpoint write
                // without copying the potentially large source metadata.
                updatedAt: checkpoint.updatedAt,
              },
              filter: {
                or: [
                  { field: "contextSnapshot", isNull: true },
                  { field: "contextSnapshot", exists: false },
                ],
              },
            },
          },
        },
      );
      return snapshot;
    } catch (error) {
      const conditionalConflict = Boolean(
        error && typeof error === "object" &&
          (error as { code?: unknown }).code ===
            "collection_mutation_condition_failed",
      );
      const latest = await context.collections.longTermMemory.get({
        id: checkpoint.id,
      });
      if (!latest) return ([] as const);
      if (latest.status !== "pending") return frozenSnapshot(latest);
      if (Array.isArray(latest.contextSnapshot)) {
        return frozenSnapshot(latest);
      }
      if (!conditionalConflict && latest.updatedAt === checkpoint.updatedAt) {
        throw error;
      }
      checkpoint = latest;
    }
  }
}
