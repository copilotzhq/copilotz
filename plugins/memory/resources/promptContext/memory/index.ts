import { memoryConfig } from "../../memory/config/index.ts";
/** Contributes settled memory and coordinates foreground compaction. @module */
import {
  type ContextContribution,
  type ContextResource,
  loadThreadRecord,
} from "@copilotz/copilotz/core";

import type { MemoryProcessorContext } from "../../../shared/contracts.ts";
import { optionalText, record } from "../../../shared/input.ts";
import {
  activeMemoryRecords,
  recordRelations,
} from "../../../shared/retrieval.ts";
import {
  isEditoriallyVisible,
  renderLongTermMemory,
} from "../../../authoring/consolidation/index.ts";
import { memoryTaskOwnsTurn } from "../../../shared/task.ts";
import { settleCheckpointError } from "../../../shared/checkpoints.ts";
import { readyCheckpoint } from "../../../shared/checkpoints.ts";
import { threadMemorySpaces } from "../../../shared/access.ts";
import {
  certifiedHistoryBoundary,
  historyBoundaryAdvances,
  sourceMessagesFromTranscript,
} from "../../../shared/source.ts";
import { reserveMemoryCheckpoint } from "../../../shared/reservation.ts";

export const MEMORY_RESOURCE_ID = "copilotz.long_term";

/** Model-facing proposal accepted directly by `consolidate_memory`. */

export const memoryContextResource:
  & ContextResource
  & Readonly<{ historyAfterMessageId?: string }> = {
    id: MEMORY_RESOURCE_ID,
    type: "context",
    purposes: ["conversation"] as const,
    async onHistoryPrepared(input) {
      const config = memoryConfig(input.context);
      if (!config.enabled || input.historyScopeId) return;
      const context = input.context as unknown as MemoryProcessorContext;
      const sources = sourceMessagesFromTranscript(context, {
        messages: input.history,
        model:
          (input.agent.models.generate ?? input.agent.models.session ?? [])[0],
      }, input.transcript);
      if (
        sources.reduce((sum, item) => sum + (item.estimatedTokens ?? 0), 0) <
          config.triggerEstimatedTokens
      ) return;
      await reserveMemoryCheckpoint(context, input.trigger, config, {
        ownerParticipantId: input.participant.id,
        historyLimitEstimatedTokens: input.historyLimitEstimatedTokens,
        historyAfterMessageId: input.historyAfterMessageId,
        prepared: {
          owner: input.participant,
          thread: input.thread,
          messages: input.history,
          sources,
        },
      });
    },
    async onTurnPreparationError(input) {
      if (input.turn.completeOn?.action !== "consolidate_memory") return false;
      const context = input.context as unknown as MemoryProcessorContext;
      if (
        !await memoryTaskOwnsTurn(context, input.turn, input.triggerMessageId)
      ) return false;
      await settleCheckpointError(
        context,
        input.turn.id,
        context.signal.aborted ? "cancelled" : "failed",
        input.error,
      );
      return true;
    },
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
      const observed = new Set<string>();
      for (;;) {
        const checkpoint = await reserveMemoryCheckpoint(
          context,
          trigger,
          config,
          {
            ownerParticipantId: input.participant.id,
            force: true,
            historyLimitEstimatedTokens: input.historyLimitEstimatedTokens,
            historyAfterMessageId: input.historyAfterMessageId,
          },
        );
        if (!checkpoint) return false;
        if (observed.has(checkpoint.id)) {
          throw new Error(
            "Memory reservation did not advance the conversation history boundary.",
          );
        }
        observed.add(checkpoint.id);
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
            if (
              await historyBoundaryAdvances(
                context,
                input.thread.id,
                boundary,
                input.historyAfterMessageId,
              )
            ) return true;
            // Another turn may already have consumed this pending range.
            // Refresh reservation for the remaining tail rather than failing.
            break;
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
      const records = spaces.length
        ? (await activeMemoryRecords(
          { collections: input.collections },
          spaces,
        ))
          .filter(isEditoriallyVisible)
        : [];
      const shared: ContextContribution[] = [];
      const relations = await recordRelations(
        { collections: input.collections },
        new Set(records.map((item) => item.id)),
      );
      for (const access of ["read_write", "read"] as const) {
        const ids = new Set(
          spaces.filter((space) => space.access === access).map((space) =>
            space.id
          ),
        );
        const selected = records.filter((item) => ids.has(item.memorySpaceId));
        const selectedIds = new Set(selected.map((item) => item.id));
        if (selected.length) {
          shared.push({
            id: `${MEMORY_RESOURCE_ID}:${
              access === "read" ? "peers" : "records"
            }`,
            title: access === "read"
              ? "SHARED SPACE MEMORY (READ ONLY)"
              : "YOUR SEMANTIC MEMORY",
            role: "context",
            content: renderLongTermMemory({
              records: selected,
              relations: relations.filter((relation) =>
                selectedIds.has(relation.sourceId) &&
                selectedIds.has(relation.targetId)
              ),
              maxContentEstimatedTokens: config.maxContentEstimatedTokens,
            }),
          });
        }
      }
      const checkpoint = await readyCheckpoint(
        { collections: input.collections } as Pick<
          MemoryProcessorContext,
          "collections"
        >,
        {
          thread: input.thread,
          agentId: input.agent.id,
          participantId: input.participant.id,
          historyScopeId: input.historyScopeId,
        },
      );
      if (!checkpoint) return shared.length ? shared : null;
      const boundary = certifiedHistoryBoundary(checkpoint, {
        agentId: input.agent.id,
        participantId: input.participant.id,
        historyScopeId: input.historyScopeId,
        thread: input.thread,
      });
      const coverage = record(record(checkpoint.metadata).coverage);
      if (!boundary) {
        return shared.length ? shared : null;
      }
      const own = {
        id: checkpoint.id,
        title: "YOUR PERSISTENT MEMORY",
        role: "context" as const,
        content: {
          type: "text" as const,
          text: `Conversation continuity:\n${optionalText(
            coverage.continuity,
          )!}`,
          role: "memory.continuity",
        },
        capturedAt: checkpoint.updatedAt,
        ...(boundary ? { historyAfterMessageId: boundary } : {}),
      };
      return shared.length ? [own, ...shared] : own;
    },
  };

export default memoryContextResource;
