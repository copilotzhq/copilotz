/** Validates immutable notes and commits them with checkpoint continuity. @module */
import {
  type ActionDefinition,
  type ActionSchema,
  defineAction,
  type VectorWrite,
} from "@copilotz/copilotz/actions";
import { loadThreadRecord } from "@copilotz/copilotz/core";
import { estimateTextTokens } from "@copilotz/copilotz/llm/tokens";
import {
  assertMemoryContinuityFits,
  type MemoryProposal,
  MemoryProposalConflict,
  memoryProposalSchema,
  prepareMemoryProposal,
} from "../../authoring/notes/index.ts";
import { memoryConfig } from "../../resources/memory/config/index.ts";
import type {
  ConsolidateMemoryActionInput,
  ConsolidateMemoryActionResult,
  MemoryActionContext,
} from "../../shared/contracts.ts";
import {
  checkpointSourceMessages,
  MemorySourceInvalidatedError,
} from "../../shared/source.ts";
import { record, requiredText } from "../../shared/input.ts";
import { ownedTurnToolSources, sourceCatalog } from "../../shared/evidence.ts";
import { commitMemoryConsolidation } from "./commit.ts";
import { threadMemorySpaces } from "../../shared/access.ts";
import { finiteEmbedding, memoryNote } from "../../shared/retrieval.ts";
import { frozenSnapshot } from "../../shared/snapshot.ts";
import {
  activeSpacesForCheckpoint,
  checkpointForConsolidation,
  prepareCheckpointSettlement,
} from "../../shared/checkpoint.ts";
import { settleCheckpointError } from "../../shared/checkpoints.ts";

export const CONSOLIDATE_MEMORY_ACTION_ID =
  "copilotz.memory.consolidation.commit";
const outputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["outcome"],
  properties: {
    outcome: {
      enum: ["already_settled", "no_changes", "changes", "invalidated"],
    },
    created: { type: "integer", minimum: 0 },
    reused: { type: "integer", minimum: 0 },
    retired: { type: "integer", minimum: 0 },
  },
} as const;

export const consolidateMemoryAction: ActionDefinition<
  ConsolidateMemoryActionInput,
  ConsolidateMemoryActionResult,
  MemoryActionContext,
  ActionSchema,
  typeof outputSchema
> = defineAction({
  id: CONSOLIDATE_MEMORY_ACTION_ID,
  inputSchema: memoryProposalSchema,
  outputSchema,
  async execute(raw, context) {
    const checkpoint = await checkpointForConsolidation(context);
    if (checkpoint.status === "ready") return { outcome: "already_settled" };
    if (checkpoint.status !== "pending") {
      throw new Error(`Memory checkpoint '${checkpoint.id}' is not pending.`);
    }
    const onDemand = record(checkpoint.metadata).onDemand === true;
    try {
      const config = memoryConfig(context);
      if (
        estimateTextTokens(JSON.stringify(raw)) >
          config.maxContentEstimatedTokens
      ) {
        throw new MemoryProposalConflict(
          "The proposal exceeds the configured memory content allowance. Compress continuity and notes without losing meaning, or cite an existing artifact for large procedures.",
        );
      }
      const threadId = requiredText(checkpoint.threadId, "Memory thread");
      const agentId = requiredText(checkpoint.agentId, "Memory agent");
      const spaces = activeSpacesForCheckpoint(
        checkpoint,
        await threadMemorySpaces(context, threadId),
      );
      const writeScope = spaces.find((space) =>
        space.defaultWrite && space.access === "read_write"
      )!;
      const writeScopeId = writeScope.id;
      const writeGrantId = requiredText(
        writeScope.writeGrantId,
        "Memory write grant",
      );
      const range = await checkpointSourceMessages(context, checkpoint);
      const proposal = raw as MemoryProposal; // The Action input schema is validated before execution.
      assertMemoryContinuityFits(
        proposal.continuity,
        config.maxContentEstimatedTokens,
      );
      const targets = [
        ...new Set([
          ...(proposal.retire ?? []).map((note) => note.id),
          ...(proposal.remember ?? []).flatMap((note) => note.replaces ?? []),
        ]),
      ];
      const texts = [
        ...new Set((proposal.remember ?? []).map((note) => note.text)),
      ];
      // One batch read for explicit targets and exact reuse candidates; no
      // per-note similarity search, embedding call or source lookup.
      const existing = targets.length || texts.length
        ? await context.collections.memoryNote.list({
          where: { memorySpaceId: writeScopeId, retirement: null },
          filter: {
            or: [{ field: "id", in: targets }, { field: "text", in: texts }],
          },
          order: { field: "id" },
          limit: 1_001,
        })
        : [];
      if (existing.length > 1_000) {
        throw new MemoryProposalConflict(
          "Too many existing exact-match candidates; split this proposal into smaller changes.",
        );
      }
      const toolSources = proposal.remember?.some((note) =>
          note.sources?.some((handle) =>
            handle.startsWith("tool:")
          )
        )
        ? await ownedTurnToolSources(context)
        : [];
      const prepared = prepareMemoryProposal(raw, {
        checkpointId: checkpoint.id,
        writeScopeId,
        notes: existing.map(memoryNote),
        sources: sourceCatalog(
          range,
          frozenSnapshot(checkpoint),
          requiredText(
            record(checkpoint.metadata).agentParticipantId,
            "Memory participant",
          ),
          toolSources,
        ),
      });
      const fresh = prepared.notes.filter((note) => !note.reused);
      const vectors: VectorWrite[] = [];
      const embed = context.adapters.memoryEmbedding?.default;
      if (embed && fresh.length) {
        const profile = context.resources.memory?.embeddingProfile;
        const agent = context.resources.agents[agentId];
        const thread = await loadThreadRecord(context, threadId);
        if (!profile || !agent || !thread) {
          throw new Error(
            "Memory embeddings require a profile, agent and current thread.",
          );
        }
        const values = await embed(fresh.map((note) => note.text), {
          agent,
          thread,
          checkpointId: checkpoint.id,
          context,
        });
        if (
          values.length !== fresh.length ||
          values.some((value) => !finiteEmbedding(value))
        ) throw new Error("Memory embedding returned invalid vectors.");
        for (let index = 0; index < fresh.length; index++) {
          vectors.push({
            ownerType: "memory_note",
            ownerId: fresh[index].id,
            field: "text",
            profile,
            values: values[index],
            sourceField: "text",
            source: fresh[index].text,
          });
        }
      }
      const result = {
        outcome: fresh.length || prepared.notes.some((note) =>
            note.sources.length || note.replaces.length
          ) ||
            prepared.retire.length
          ? "changes" as const
          : "no_changes" as const,
        created: fresh.length,
        reused: prepared.notes.length - fresh.length,
        retired: prepared.retire.length +
          prepared.notes.reduce((sum, note) =>
            sum + note.replaces.length, 0),
      };
      const settlement = await prepareCheckpointSettlement(context, {
        checkpoint,
        result,
        continuity: prepared.continuity,
      });
      await commitMemoryConsolidation(context, {
        checkpointId: checkpoint.id,
        writeScopeId,
        writeGrantId,
        agentId,
        threadId,
        recordedAt: context.now().toISOString(),
        proposal: prepared,
        vectors,
        checkpointPatch: settlement.patch,
        checkpointContent: settlement.content,
      });
      return result;
    } catch (error) {
      if (error instanceof MemorySourceInvalidatedError) {
        await settleCheckpointError(context, checkpoint.id, "failed", error);
        return { outcome: "invalidated" };
      }
      if (onDemand) {
        await settleCheckpointError(context, checkpoint.id, "failed", error);
      }
      throw error;
    }
  },
});
export type { ConsolidateMemoryActionInput, ConsolidateMemoryActionResult };
export default consolidateMemoryAction;
