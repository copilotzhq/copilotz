import { memoryConfig } from "../../memory/config/index.ts";
/** Contributes settled memory and coordinates foreground compaction. @module */
import type { ContentRef } from "@copilotz/copilotz/content";
import {
  type ContextContribution,
  type ContextResource,
  loadThreadRecord,
} from "@copilotz/copilotz/core";

import type { MemoryProcessorContext } from "../../../shared/contracts.ts";
import { optionalText, record } from "../../../shared/input.ts";
import { activeMemoryRecords } from "../../../shared/retrieval.ts";
import {
  isEditoriallyVisible,
  renderLongTermMemory,
} from "../../../authoring/consolidation/index.ts";
import { checkpoints } from "../../../shared/checkpoints.ts";
import {
  checkpointAccessible,
  threadMemorySpaces,
} from "../../../shared/access.ts";
import { certifiedHistoryBoundary } from "../../../shared/source.ts";
import { reserveMemoryCheckpoint } from "../../../shared/reservation.ts";

export const MEMORY_RESOURCE_ID = "copilotz.long_term";

/** Model-facing proposal accepted directly by `consolidate_memory`. */

export const memoryContextResource:
  & ContextResource
  & Readonly<{ historyAfterMessageId?: string }> = {
    id: MEMORY_RESOURCE_ID,
    type: "context",
    purposes: ["conversation"] as const,
    async compact(input) {
      const config = memoryConfig(input.context);
      const enabled = config.enabled;
      if (!enabled || input.historyScopeId) return false;
      const context = input.context as unknown as MemoryProcessorContext;
      const trigger = await context.collections.message.get({
        id: input.triggerMessageId,
      });
      if (!trigger || String(trigger.threadId) !== input.thread.id) {
        return false;
      }
      const checkpoint = await reserveMemoryCheckpoint(
        context,
        trigger,
        config,
        {
          ownerParticipantId: input.participant.id,
          force: true,
          maxSourceEstimatedTokens: Math.floor(input.limitEstimatedTokens / 3),
        },
      );
      if (!checkpoint) return false;
      let pollDelayMs = 50;
      for (;;) {
        input.signal.throwIfAborted();
        const current = await context.collections.longTermMemory.get({
          id: checkpoint.id,
        });
        if (!current) {
          throw new Error(
            "Memory checkpoint '" + checkpoint.id + "' disappeared.",
          );
        }
        if (current.status === "failed" || current.status === "cancelled") {
          const detail = optionalText(record(current.error).message);
          throw new Error(
            "Memory checkpoint '" + checkpoint.id + "' " + current.status +
              (detail ? ": " + detail : "."),
          );
        }
        if (current.status === "ready") {
          const thread = await loadThreadRecord(context, input.thread.id);
          const boundary = thread && certifiedHistoryBoundary(current, {
            agentId: input.agent.id,
            participantId: input.participant.id,
            thread,
          });
          if (!boundary) {
            throw new Error(
              "Memory checkpoint '" + checkpoint.id +
                "' became ready without certified coverage.",
            );
          }
          return boundary !== input.historyAfterMessageId;
        }
        await new Promise<void>((resolve, reject) => {
          const abort = () => {
            clearTimeout(timer);
            reject(input.signal.reason);
          };
          const timer = setTimeout(() => {
            input.signal.removeEventListener("abort", abort);
            resolve();
          }, pollDelayMs);
          input.signal.addEventListener("abort", abort, { once: true });
          if (input.signal.aborted) abort();
        });
        pollDelayMs = Math.min(pollDelayMs * 2, 1_000);
      }
    },
    async contribute(input) {
      const config = memoryConfig(input.context);
      const enabled = config.enabled;
      if (!enabled) return null;
      // Context resources intentionally receive capabilities, not the processor object.
      const checkpointCollection = input.collections.longTermMemory;
      const accessCollection = input.collections.memorySpaceAccess;
      if (!checkpointCollection || !accessCollection) return null;
      const spaces = await threadMemorySpaces({
        collections: input.collections,
      }, input.thread.id);
      const peers = spaces.filter((space) =>
        space.access === "read" && space.scopeType === "thread"
      );
      const records = peers.length
        ? (await activeMemoryRecords({ collections: input.collections }, peers))
          .filter(isEditoriallyVisible)
        : [];
      const shared: ContextContribution[] = records.length
        ? [{
          id: `${MEMORY_RESOURCE_ID}:peers`,
          title: "SHARED SPACE MEMORY (READ ONLY)",
          role: "context",
          content: renderLongTermMemory({
            records,
            relations: [],
            maxContentEstimatedTokens: config.maxContentEstimatedTokens,
          }),
        }]
        : [];
      const checkpoint = (await checkpoints(
        { collections: input.collections } as Pick<
          MemoryProcessorContext,
          "collections"
        >,
        input.thread.id,
        input.agent.id,
        "ready",
      )).find((item) => checkpointAccessible(item, spaces));
      if (
        !checkpoint || !Array.isArray(checkpoint.content) ||
        !checkpoint.content.length
      ) return shared.length ? shared : null;
      const boundary = certifiedHistoryBoundary(checkpoint, {
        agentId: input.agent.id,
        participantId: input.participant.id,
        historyScopeId: input.historyScopeId,
        thread: input.thread,
      });
      // A scope-incompatible checkpoint may contain private material. Do not
      // expose it as ordinary context. A compatible but uncertified checkpoint
      // remains useful semantic context, but cannot trim raw history.
      const coverage = record(record(checkpoint.metadata).coverage);
      if (coverage.schema === "copilotz.memory.coverage.v1" && !boundary) {
        return shared.length ? shared : null;
      }
      const own = {
        id: checkpoint.id,
        title: "YOUR PERSISTENT MEMORY",
        role: "context" as const,
        content: checkpoint.content.length === 1
          ? checkpoint.content[0] as ContentRef
          : {
            type: "json" as const,
            value: checkpoint.content,
            role: "memory.refs",
          },
        capturedAt: checkpoint.updatedAt,
        ...(boundary ? { historyAfterMessageId: boundary } : {}),
      };
      return shared.length ? [own, ...shared] : own;
    },
  };

export default memoryContextResource;
