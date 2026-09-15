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

import {
  defineMemoryKind,
  type MemoryKindDefinition,
} from "../authoring/ontology/index.ts";
import { MEMORY_RESOURCE_ID } from "../resources/promptContext/memory/index.ts";
import type {
  MemoryActionContext,
  MemoryProcessorContext,
} from "./contracts.ts";
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
  const existing = frozenSnapshot(input.checkpoint);
  if (existing.length || Array.isArray(input.checkpoint.contextSnapshot)) {
    return existing;
  }
  const contributed = await collectContextContributions(context, {
    purpose: "conversation",
    agent: input.agent,
    participant: input.participant,
    thread: input.thread,
    sourceRange: {
      startMessageId: requiredText(
        input.checkpoint.sourceStartMessageId,
        "Memory source start",
      ),
      endMessageId: requiredText(
        input.checkpoint.sourceEndMessageId,
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
          `context:${input.checkpoint.id}:${item.resourceId}:${item.id}`,
      })
    ),
  );
  const snapshot = contributed.map((item, index) => ({
    id: item.id,
    resourceId: item.resourceId,
    title: item.title,
    role: item.role,
    content: prepared[index].content,
    ...(item.source ? { source: structuredClone(item.source) } : {}),
    capturedAt: item.capturedAt ?? capturedAt,
    ...(item.resourceId === MEMORY_RESOURCE_ID && item.historyAfterMessageId
      ? { historyAfterMessageId: item.historyAfterMessageId }
      : {}),
  } as const));
  await context.collections.longTermMemory.update(
    {
      id: input.checkpoint.id,
      set: {
        contextSnapshotContent: combinePrepared(prepared),
        contextSnapshot: snapshot,
        metadata: {
          ...record(input.checkpoint.metadata),
          contextCapturedAt: capturedAt,
        },
      },
    },
    { operationKey: `checkpoint:${input.checkpoint.id}:context` },
  );
  return snapshot;
}

export function memoryKinds(
  context: MemoryActionContext | MemoryProcessorContext,
) {
  return ((context.resources.memory?.kinds ?? []).filter((
    value,
  ): value is MemoryKindDefinition => !!value).map(defineMemoryKind));
}
