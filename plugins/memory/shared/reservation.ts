/** Bounded checkpoint reservation shared by background and foreground compaction. @module */
import {
  loadParticipantRecord,
  loadThreadRecord,
  workflowMetadata,
} from "@copilotz/copilotz/core";
import { isContentByteLimitError } from "@copilotz/copilotz/content";
import { estimateTextTokens } from "@copilotz/copilotz/llm/tokens";
import type { CollectionRecord } from "@copilotz/copilotz/collections";

import { loadCoreThreadMessageSnapshot } from "@copilotz/copilotz/core";
import {
  buildMemoryConsolidationInstruction,
  memorySourceManifestEntry,
  type MemorySourceMessage,
  selectLongTermMemoryRange,
} from "../authoring/consolidation/index.ts";
import type { LongTermMemoryConfig } from "../resources/memory/config/index.ts";
import type { MemoryProcessorContext } from "./contracts.ts";
import { optionalText } from "./input.ts";
import {
  checkpointAccessible,
  ensureWritableMemorySpace,
  participantAgentId,
} from "./access.ts";
import { checkpoints, createCheckpoint } from "./checkpoints.ts";
import { memoryKinds } from "./snapshot.ts";
import {
  branchCertificate,
  certifiedHistoryBoundary,
  projectedSourceMessages,
  rangeMessages,
  sourceRangeFingerprint,
} from "./source.ts";

export async function reserveMemoryCheckpoint(
  context: MemoryProcessorContext,
  messageRecord: CollectionRecord,
  config: LongTermMemoryConfig,
  options: Readonly<{
    ownerParticipantId?: string;
    force?: boolean;
    historyLimitEstimatedTokens: number;
    prepared?: Readonly<{
      owner: import("@copilotz/copilotz/core").Participant;
      thread: import("@copilotz/copilotz/core").ConversationThread;
      messages:
        readonly import("@copilotz/copilotz/core").ConversationMessage[];
      sources: readonly MemorySourceMessage[];
    }>;
  }>,
): Promise<CollectionRecord | null> {
  const ownerParticipantId = optionalText(options.ownerParticipantId) ??
    optionalText(messageRecord.senderId);
  if (!ownerParticipantId) return null;
  const owner = options.prepared?.owner ??
    await loadParticipantRecord(context, ownerParticipantId);
  if (!owner || owner.participantType !== "agent") return null;
  const message = {
    ...messageRecord,
    threadId: String(messageRecord.threadId),
    sender: owner,
  } as const;
  const agentId = participantAgentId(owner);
  if (!context.resources.agents[agentId]) return null;
  const pending = await checkpoints(
    context,
    message.threadId,
    agentId,
    "pending",
  );
  if (pending[0]) return pending[0];
  const spaces = await ensureWritableMemorySpace(context, message.threadId);
  const thread = options.prepared?.thread ??
    await loadThreadRecord(context, message.threadId);
  const workflowInitiator = workflowMetadata(messageRecord.metadata)
    ?.initiatorParticipantId;
  const humanParticipants =
    thread?.participants.filter((participant) =>
      participant.participantType === "human"
    ) ?? [];
  const initiatorParticipantId = workflowInitiator ??
    humanParticipants.find((participant) =>
      participant.id === messageRecord.senderId
    )?.id ??
    (humanParticipants.length === 1 ? humanParticipants[0]?.id : undefined);
  if (!initiatorParticipantId) {
    throw new Error(
      "Memory maintenance requires trusted initiating human provenance.",
    );
  }
  const previous = !options.prepared && thread
    ? (await checkpoints(context, message.threadId, agentId, "ready")).find(
      (item) =>
        checkpointAccessible(item, spaces) && Boolean(
          certifiedHistoryBoundary(item, {
            agentId,
            participantId: owner.id,
            historyScopeId: optionalText(messageRecord.historyScopeId),
            thread,
          }),
        ),
    ) ?? null
    : null;
  const certifiedPreviousBoundary = previous && thread
    ? certifiedHistoryBoundary(previous, {
      agentId,
      participantId: owner.id,
      historyScopeId: optionalText(messageRecord.historyScopeId),
      thread,
    })
    : undefined;
  const snapshot = options.prepared
    ? { active: true, messages: options.prepared.messages }
    : await context.readSnapshot(({ collections }) =>
      loadCoreThreadMessageSnapshot(
        { collections } as typeof context,
        message.threadId,
        messageRecord,
        {
          ...(optionalText(messageRecord.historyScopeId)
            ? { historyScopeId: optionalText(messageRecord.historyScopeId) }
            : {}),
          viewerIds: [owner.id],
          ...(certifiedPreviousBoundary
            ? { afterMessageId: certifiedPreviousBoundary }
            : {}),
        },
      )
    );
  if (!snapshot.active) return null;
  const instructionEstimatedTokens = estimateTextTokens(
    buildMemoryConsolidationInstruction({
      spaces,
      sourceMessages: [],
      kinds: memoryKinds(context),
      context: [],
    }),
  );
  const maxSourceEstimatedTokens = Math.max(
    0,
    options.historyLimitEstimatedTokens - instructionEstimatedTokens,
  );
  const sourceMessageOverhead = (source: MemorySourceMessage) =>
    estimateTextTokens(JSON.stringify(memorySourceManifestEntry(source)) + ",");
  if (maxSourceEstimatedTokens <= 0) {
    if (options.force) {
      throw new Error(
        "The Agent prompt prefix and response allowance leave no room for memory source.",
      );
    }
    return null;
  }
  // Background eligibility may require seeing more source than one maintenance
  // turn can carry. The scan remains bounded, while range selection below
  // still caps the checkpoint source at maxSourceEstimatedTokens.
  const retainRecentEstimatedTokens = options.force
    ? Math.min(
      config.retainRecentEstimatedTokens,
      Math.floor(maxSourceEstimatedTokens / 4),
    )
    : config.retainRecentEstimatedTokens;
  const sourceByteLimit = Math.max(
    1,
    (Math.max(maxSourceEstimatedTokens, config.triggerEstimatedTokens) +
      retainRecentEstimatedTokens) * 8,
  );
  const sources: MemorySourceMessage[] = [];
  const encoder = new TextEncoder();
  let usedBytes = 0;
  let batchSize = 16;
  let range: ReturnType<typeof selectLongTermMemoryRange> = null;
  if (options.prepared) {
    range = selectLongTermMemoryRange({
      messages: options.prepared.sources,
      triggerMessageId: options.prepared.sources.at(-1)?.id ?? message.id,
      triggerEstimatedTokens: options.force ? 0 : config.triggerEstimatedTokens,
      retainRecentEstimatedTokens,
      maxSourceEstimatedTokens,
      sourceMessageOverhead,
    });
  }
  for (
    let offset = 0;
    !options.prepared && offset < snapshot.messages.length;
  ) {
    let batch: readonly MemorySourceMessage[];
    try {
      batch = await projectedSourceMessages(context, {
        threadId: message.threadId,
        participantId: owner.id,
        messages: snapshot.messages.slice(offset, offset + batchSize),
        byteLimit: Math.max(0, sourceByteLimit - usedBytes),
        model: (context.resources.agents[agentId]?.models.generate ??
          context.resources.agents[agentId]?.models.session ?? [])[0],
      });
    } catch (error) {
      if (!isContentByteLimitError(error)) throw error;
      if (batchSize > 1) {
        batchSize = Math.max(1, Math.floor(batchSize / 2));
        continue;
      }
      // A later record can exceed the remaining bounded read budget. Keep the
      // completed prefix when it already has a safe range; that record and the
      // history after it remain raw tail. The first record has no safe prefix.
      if (range) break;
      throw new Error(
        sources.length
          ? "Memory source cannot reach the consolidation trigger within the maintenance content budget."
          : "The first memory source message exceeds the maintenance content budget.",
        { cause: error },
      );
    }
    sources.push(...batch);
    usedBytes += batch.reduce(
      (total, source) =>
        total + (source.sourceBytes ?? encoder.encode(source.text).byteLength) +
        encoder.encode(source.reasoning ?? "").byteLength,
      0,
    );
    offset += batchSize;
    range = selectLongTermMemoryRange({
      messages: sources,
      triggerMessageId: sources.at(-1)?.id ?? message.id,
      triggerEstimatedTokens: options.force ? 0 : config.triggerEstimatedTokens,
      retainRecentEstimatedTokens,
      maxSourceEstimatedTokens,
      sourceMessageOverhead,
    });
    // Once the next source would exceed the selected budget, further reads
    // only add raw tail. The selector has already retained the configured
    // recent history, so this source range is safe to reserve.
    if (range?.sourceLimitReached) break;
    batchSize = 16;
  }
  if (!range) return null;
  return await createCheckpoint(context, {
    threadId: message.threadId,
    agentId,
    spaces,
    sourceStartMessageId: range.sourceStartMessageId,
    sourceEndMessageId: range.sourceEndMessageId,
    metadata: {
      agentParticipantId: owner.id,
      initiatorParticipantId,
      preparationTrigger: snapshot.messages.find((item) =>
        item.id ===
          (workflowMetadata(messageRecord.metadata)?.sourceMessageId ??
            messageRecord.id)
      ) ?? snapshot.messages.findLast((item) => item.sender.id !== owner.id),
      estimatedTokens: range.estimatedTokens,
      historyLimitEstimatedTokens: options.historyLimitEstimatedTokens,
      instructionEstimatedTokens: instructionEstimatedTokens +
        range.messages.reduce(
          (sum, source) => sum + sourceMessageOverhead(source),
          0,
        ),
      retainedEstimatedTokens: range.retainedEstimatedTokens,
      retainedMessageCount: range.retainedMessageCount,
      coverageCandidate: {
        schema: "copilotz.memory.coverage.v1",
        agentParticipantId: owner.id,
        ...(optionalText(messageRecord.historyScopeId)
          ? { historyScopeId: optionalText(messageRecord.historyScopeId) }
          : {}),
        branch: thread ? branchCertificate(thread) : "public",
        startMessageId: range.sourceStartMessageId,
        endMessageId: range.sourceEndMessageId,
        sourceFingerprint: await sourceRangeFingerprint(
          rangeMessages(snapshot.messages, {
            sourceStartMessageId: range.sourceStartMessageId,
            sourceEndMessageId: range.sourceEndMessageId,
          }),
        ),
      },
    },
  });
}
