import type { VectorWrite } from "@copilotz/copilotz/actions";
import { memoryConfig } from "../../resources/memory/config/index.ts";
/** Validates and commits one semantic-memory consolidation proposal. @module */
import {
  type ActionDefinition,
  type ActionSchema,
  defineAction,
} from "@copilotz/copilotz/actions";
import {
  type ContextSourceRef,
  loadThreadRecord,
} from "@copilotz/copilotz/core";

import {
  isEditoriallyVisible,
  type MemoryRecordProjection,
  parseConsolidateMemoryInput,
  proposalDrafts,
  stableMemoryRecordId,
} from "../../authoring/consolidation/index.ts";
import { consolidationInputSchema } from "../../authoring/consolidation/schema.ts";
import { memoryRecordCollection } from "../../collections/memory-record/index.ts";
import {
  type AssertionMemoryDraft,
  defaultMemoryLifecycle,
  MEMORY_FORMS,
  type MemoryDraftBase,
  memoryLifecycleAllows,
  memorySourceKey,
  type ProposedMemoryRef,
} from "../../authoring/ontology/index.ts";

import type {
  ConsolidateMemoryActionInput,
  ConsolidateMemoryActionResult,
  MemoryActionContext,
} from "../../shared/contracts.ts";
import {
  checkpointSourceMessages,
  MemorySourceInvalidatedError,
} from "../../shared/source.ts";
import { optionalText, record, requiredText } from "../../shared/input.ts";
import {
  assertedBy,
  draftData,
  intentOrInquiryStatus,
  recordRelations,
  resolveRef,
  sourceCatalog,
  stableJson,
  validateMemoryKindData,
} from "./proposal.ts";
import {
  commitMemoryConsolidation,
  type MemoryRecordWrite,
  type MemoryRelationWrite,
} from "./commit.ts";
import { threadMemorySpaces } from "../../shared/access.ts";
import {
  activeMemoryRecords,
  candidateRecords,
  finiteEmbedding,
  lexicalScore,
  terminalStatus,
} from "../../shared/retrieval.ts";
import { frozenSnapshot, memoryKinds } from "../../shared/snapshot.ts";
import {
  activeSpacesForCheckpoint,
  checkpointForConsolidation,
  prepareCheckpointSettlement,
  settleCheckpoint,
} from "../../shared/checkpoint.ts";
import { settleCheckpointError } from "../../shared/checkpoints.ts";

export const CONSOLIDATE_MEMORY_ACTION_ID =
  "copilotz.memory.consolidation.commit";
const consolidationOutputSchema: ActionSchema = {
  type: "object",
  additionalProperties: false,
  required: ["outcome"],
  properties: {
    outcome: {
      enum: ["already_settled", "no_changes", "changes", "invalidated"],
    },
    continuity: {
      type: "string",
      minLength: 1,
      description:
        "Certified replacement summary for the compacted source range when consolidation succeeds.",
    },
    created: {
      type: "integer",
      minimum: 0,
      description:
        "Total records created; createdRecords is a bounded audit list of at most 100 entries.",
    },
    reused: {
      type: "integer",
      minimum: 0,
      description:
        "Total records reused; reusedRecords is a bounded audit list of at most 100 entries.",
    },
    lifecycleChanged: { type: "integer", minimum: 0 },
    unresolved: {
      type: "integer",
      minimum: 0,
      description:
        "Total unresolved lifecycle reconciliations; unresolvedReconciliations contains at most 100 details.",
    },
    createdRecords: {
      type: "array",
      maxItems: 100,
      description:
        "Bounded localId-to-memoryId audit list for created records; compare with created for the total.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["localId", "memoryId", "form", "status", "summary"],
        properties: {
          localId: { type: "string" },
          memoryId: { type: "string" },
          form: { enum: MEMORY_FORMS },
          status: { type: "string" },
          summary: { type: "string" },
        },
      },
    },
    reusedRecords: {
      type: "array",
      maxItems: 100,
      description:
        "Bounded localId-to-memoryId audit list for reused records; compare with reused for the total.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["localId", "memoryId", "form", "status", "summary"],
        properties: {
          localId: { type: "string" },
          memoryId: { type: "string" },
          form: { enum: MEMORY_FORMS },
          status: { type: "string" },
          summary: { type: "string" },
        },
      },
    },
    unresolvedReconciliations: {
      type: "array",
      maxItems: 100,
      description:
        "Bounded reconciliation details; compare with unresolved for the total.",
      items: { type: "object" },
    },
  },
};

export const consolidateMemoryAction: ActionDefinition<
  ConsolidateMemoryActionInput,
  ConsolidateMemoryActionResult,
  MemoryActionContext,
  ActionSchema,
  ActionSchema
> = defineAction({
  id: CONSOLIDATE_MEMORY_ACTION_ID,
  inputSchema: consolidationInputSchema(),
  outputSchema: consolidationOutputSchema,
  async execute(
    proposal: ConsolidateMemoryActionInput,
    context: MemoryActionContext,
  ): Promise<ConsolidateMemoryActionResult> {
    const config = memoryConfig(context);
    const checkpoint = await checkpointForConsolidation(context);
    const checkpointId = requiredText(checkpoint.id, "Memory checkpoint id");
    const raw = proposal;
    const embed = context.adapters.memoryEmbedding?.default;
    const profile = context.resources.memory?.embeddingProfile;
    if (embed && !profile) {
      throw new Error(
        "Memory embedding requires resources.memory.embeddingProfile.",
      );
    }
    const vectors: VectorWrite[] = [];
    if (checkpoint.status === "ready") {
      const prior = record(record(checkpoint.metadata).result);
      const outcome = optionalText(prior.outcome);
      if (
        outcome === "changes" || outcome === "no_changes" ||
        outcome === "already_settled"
      ) {
        return { ...structuredClone(prior), outcome };
      }
      return { outcome: "already_settled" };
    }
    if (checkpoint.status !== "pending") {
      throw new Error(`Memory checkpoint '${checkpointId}' is not pending.`);
    }
    // An ordinary on-demand call owns its just-reserved checkpoint. Unlike
    // the private processor path, no processor will settle it after this
    // Action rejects, so settle the still-pending reservation here.
    const onDemand = record(checkpoint.metadata).onDemand === true;
    try {
      const threadId = requiredText(checkpoint.threadId, "Memory thread id");
      const agentId = requiredText(checkpoint.agentId, "Memory agent id");
      const agent = context.resources.agents[agentId];
      if (!agent) throw new Error(`Agent '${agentId}' was not found.`);
      const thread = await loadThreadRecord(context, threadId);
      if (!thread) {
        throw new Error(`Memory thread '${threadId}' was not found.`);
      }
      const spaces = activeSpacesForCheckpoint(
        checkpoint,
        await threadMemorySpaces(context, threadId),
      );
      const range = await checkpointSourceMessages(context, checkpoint);
      const snapshot = frozenSnapshot(checkpoint);
      const catalog = sourceCatalog(range, snapshot);
      const kindDefinitions = memoryKinds(context);
      const currentRecords = await activeMemoryRecords(
        context,
        spaces,
      );
      const currentRecordIds = new Set(currentRecords.map((item) => item.id));
      const currentRelations = await recordRelations(
        context,
        currentRecordIds,
      );
      const visible = currentRecords.filter((item) =>
        isEditoriallyVisible(item) && !terminalStatus(item.status)
      );
      const parsed = parseConsolidateMemoryInput(raw, {
        kinds: new Map(kindDefinitions.map((kind) => [kind.id, kind])),
        writableMemorySpaceIds: new Set(
          spaces.filter((space) => space.access === "read_write").map((
            space,
          ) => space.id),
        ),
        defaultWriteMemorySpaceId: spaces.find((space) =>
          space.defaultWrite
        )!.id,
        allowedEvidenceSources: catalog.keys,
        defaultEvidenceSources: catalog.evidence,
        visibleMemoryIds: new Set(visible.map((item) => item.id)),
        visibleNodeIds: catalog.nodes,
      });
      if (parsed.outcome === "no_changes") {
        const result = {
          outcome: "no_changes" as const,
          continuity: parsed.continuity,
          created: 0,
          reused: 0,
          lifecycleChanged: 0,
          createdRecords: [],
          reusedRecords: [],
          unresolvedReconciliations: [],
        };
        await settleCheckpoint(context, {
          checkpoint,
          agentId,
          spaces,
          config,
          result,
        });
        return result;
      }

      const drafts = proposalDrafts(parsed);
      const localIds = new Map(
        drafts.map((
          { draft },
        ) => [
          draft.localId,
          stableMemoryRecordId(checkpointId, draft.localId),
        ]),
      );
      const retrieved = new Map<
        string,
        Awaited<ReturnType<typeof candidateRecords>>
      >();
      for (const { form, draft } of drafts) {
        retrieved.set(
          draft.localId,
          await candidateRecords(context, {
            query: draft.summary,
            form,
            kind: draft.kind,
            spaces,
            agent,
            threadId,
            checkpointId,
            limit: config.retrievalLimit,
            embed,
          }),
        );
      }
      const persisted = new Map<string, string>();
      const retrievedIds = new Set<string>();
      const createdRecords = new Map<string, Record<string, unknown>>();
      const updatedRecords = new Map<string, Record<string, unknown>>();
      const projectedRecords = new Map(
        currentRecords.map((item) => [item.id, item] as const),
      );
      const stagedRelations = new Map<string, MemoryRelationWrite>();
      const stageUpdate = (
        id: string,
        patch: Readonly<Record<string, unknown>>,
      ) => {
        updatedRecords.set(id, {
          ...(updatedRecords.get(id) ?? {}),
          ...structuredClone(patch),
        });
      };
      const stageRelation = (relation: MemoryRelationWrite) => {
        const existing = stagedRelations.get(relation.id);
        if (existing && stableJson(existing) !== stableJson(relation)) {
          throw new Error(
            `Memory relation ID '${relation.id}' has conflicting definitions.`,
          );
        }
        stagedRelations.set(relation.id, relation);
      };
      let created = 0;
      let reused = 0;
      for (const { form, draft } of drafts) {
        const memorySpaceId = requiredText(
          draft.spaceId,
          `Memory '${draft.localId}' space ID`,
        );
        const data = draftData(
          form,
          draft as MemoryDraftBase & Record<string, unknown>,
          localIds,
        );
        const kindDefinition = kindDefinitions.find((kind) =>
          kind.id === draft.kind
        );
        if (kindDefinition?.schema) {
          validateMemoryKindData(
            kindDefinition.schema,
            data,
            `Memory '${draft.localId}' does not satisfy kind '${draft.kind}'`,
          );
        }
        const candidates = retrieved.get(draft.localId) ?? [];
        candidates.forEach((item) => retrievedIds.add(item.record.id));
        const exact = candidates.find((item) =>
          item.record.memorySpaceId === memorySpaceId &&
          stableJson(item.record.data) === stableJson(data)
        );
        if (exact) {
          const rawRecord = exact.raw;
          const pending = updatedRecords.get(exact.record.id);
          const provenance = record(
            pending?.provenance ?? rawRecord.provenance,
          );
          const existingSources = Array.isArray(provenance.sources)
            ? provenance.sources as ContextSourceRef[]
            : [];
          const sources = [...existingSources, ...draft.sources].filter((
            source,
            index,
            all,
          ) =>
            all.findIndex((candidate) =>
              memorySourceKey(candidate) === memorySourceKey(source)
            ) === index
          );
          stageUpdate(exact.record.id, {
            provenance: { ...provenance, sources },
          });
          persisted.set(draft.localId, exact.record.id);
          reused++;
          continue;
        }
        const id = localIds.get(draft.localId)!;
        if (embed) {
          const values = await embed([draft.summary], {
            agent,
            thread,
            checkpointId,
            context,
          });
          if (!finiteEmbedding(values[0])) {
            throw new Error("Memory embedder returned an invalid vector.");
          }
          vectors.push({
            ownerType: "memory_record",
            ownerId: id,
            field: "summary",
            sourceField: "summary",
            source: draft.summary,
            values: values[0],
            profile: profile!,
          });
        }
        const status = intentOrInquiryStatus(
          form,
          draft as unknown as Record<string, unknown>,
        );
        const temporalInput = record(
          (draft as unknown as Record<string, unknown>).temporal,
        );
        const temporal = {
          ...(optionalText(temporalInput.validFrom)
            ? { validFrom: optionalText(temporalInput.validFrom) }
            : {}),
          ...(optionalText(temporalInput.validTo)
            ? { validTo: optionalText(temporalInput.validTo) }
            : {}),
          recordedAt: checkpoint.createdAt,
        };
        const author = assertedBy(draft.sources, range);
        const newRecord = {
          id,
          memorySpaceId,
          consolidationId: checkpointId,
          createdByAgentId: agentId,
          originThreadId: threadId,
          form,
          kind: draft.kind,
          summary: draft.summary,
          content: [],
          status,
          validity: { status: "valid" },
          temporal,
          epistemic: form === "assertion"
            ? structuredClone((draft as AssertionMemoryDraft).epistemic)
            : null,
          provenance: {
            sources: draft.sources,
            ...(author ? { assertedBy: author } : {}),
            recordedBy: { type: "agent", id: agentId },
            consolidationId: checkpointId,
          },
          data,
          metadata: {},
        };
        createdRecords.set(id, newRecord);
        projectedRecords.set(id, {
          id,
          memorySpaceId,
          form,
          kind: draft.kind,
          summary: draft.summary,
          status,
          validity: "valid",
          data,
        });
        persisted.set(draft.localId, id);
        created++;
      }

      const resolve = (ref: ProposedMemoryRef) =>
        resolveRef(
          ref,
          new Map(
            [...localIds].map((
              [localId],
            ) => [localId, persisted.get(localId) ?? localIds.get(localId)!]),
          ),
        );
      const relations = parsed.relations ?? [];
      for (const relation of relations) {
        const from = resolve(relation.from);
        const to = resolve(relation.to);
        const id = `memory-relation:${
          encodeURIComponent(
            `${from.type}:${from.id}:${relation.type}:${to.type}:${to.id}`,
          )
        }`;
        stageRelation({
          id,
          type: relation.type,
          source: from,
          target: to,
          metadata: { checkpointId, sources: relation.sources ?? [] },
        });
      }
      for (const { form, draft } of drafts) {
        if (form !== "assertion") continue;
        const data = draftData(
          form,
          draft as MemoryDraftBase & Record<string, unknown>,
          localIds,
        );
        for (const candidate of retrieved.get(draft.localId) ?? []) {
          if (
            stableJson(candidate.record.data.subject) !==
              stableJson(data.subject) ||
            candidate.record.data.predicate !== data.predicate ||
            stableJson(candidate.record.data.object) ===
              stableJson(data.object)
          ) continue;
          const sourceId = persisted.get(draft.localId)!;
          const id = `memory-relation:${
            encodeURIComponent(
              `${sourceId}:contradicts:${candidate.record.id}`,
            )
          }`;
          stageRelation({
            id,
            type: "contradicts",
            source: { type: memoryRecordCollection.name, id: sourceId },
            target: {
              type: memoryRecordCollection.name,
              id: candidate.record.id,
            },
            metadata: { checkpointId },
          });
        }
      }

      const unresolved: unknown[] = [];
      let lifecycleChanged = 0;
      for (const change of parsed.lifecycle ?? []) {
        let targets: readonly MemoryRecordProjection[] = [];
        if ("memoryId" in change.target) {
          const memoryId = change.target.memoryId;
          targets = visible.filter((item) => item.id === memoryId);
        } else {
          const match = change.target.match;
          targets = visible.filter((item) =>
            item.form === match.form &&
            (!match.kind || item.kind === match.kind) &&
            lexicalScore(match.query, item.summary) > 0
          );
        }
        if (targets.length !== 1) {
          unresolved.push({
            change,
            candidateIds: targets.map((item) => item.id),
          });
          continue;
        }
        const target = targets[0];
        if (
          !spaces.some((space) =>
            space.id === target.memorySpaceId && space.access === "read_write"
          )
        ) {
          throw new Error("Cannot change a read-only peer memory record.");
        }
        if (!memoryLifecycleAllows(target.form, change.status)) {
          unresolved.push({
            change,
            candidateIds: [target.id],
            reason: "status_not_allowed_for_form",
          });
          continue;
        }
        const rawTarget = await context.collections.memoryRecord
          .get({ id: target.id });
        const pendingTarget = updatedRecords.get(target.id);
        stageUpdate(target.id, {
          status: change.status,
          temporal: {
            ...record(pendingTarget?.temporal ?? rawTarget?.temporal),
            invalidatedAt: new Date().toISOString(),
          },
        });
        projectedRecords.set(target.id, {
          ...target,
          status: change.status,
        });
        lifecycleChanged++;
        if (change.replacement) {
          const replacement = resolve(change.replacement);
          const id = `memory-relation:${
            encodeURIComponent(`${replacement.id}:supersedes:${target.id}`)
          }`;
          stageRelation({
            id,
            type: "supersedes",
            source: replacement,
            target: { type: memoryRecordCollection.name, id: target.id },
            metadata: { checkpointId },
          });
        }
      }
      const auditRecords = drafts.map(({ form, draft }) => ({
        localId: draft.localId,
        memoryId: persisted.get(draft.localId)!,
        form,
        status: projectedRecords.get(persisted.get(draft.localId)!)?.status ??
          defaultMemoryLifecycle(form),
        summary: draft.summary,
      }));
      const result = {
        outcome: "changes" as const,
        continuity: parsed.continuity,
        created,
        reused,
        lifecycleChanged,
        unresolved: unresolved.length,
        createdRecords: auditRecords.filter((item) =>
          createdRecords.has(item.memoryId)
        ).slice(0, 100),
        reusedRecords: auditRecords.filter((item) =>
          !createdRecords.has(item.memoryId)
        ).slice(0, 100),
        unresolvedReconciliations: unresolved.slice(0, 100),
      };
      const recordWrites: MemoryRecordWrite[] = [
        ...[...createdRecords.values()].map((record) => ({
          operation: "create" as const,
          record: record as Record<string, unknown> & { id: string },
        })),
        ...[...updatedRecords].map(([id, patch]) => ({
          operation: "update" as const,
          id,
          patch,
        })),
      ];
      const relationWrites = [...stagedRelations.values()];
      const projectedIds = new Set(projectedRecords.keys());
      const projectedRelationMap = new Map(
        currentRelations.map((relation) =>
          [
            `${relation.sourceId}\0${relation.type}\0${relation.targetId}`,
            relation,
          ] as const
        ),
      );
      for (const relation of relationWrites) {
        if (
          relation.source.type !== memoryRecordCollection.name ||
          relation.target.type !== memoryRecordCollection.name ||
          !projectedIds.has(relation.source.id) ||
          !projectedIds.has(relation.target.id)
        ) continue;
        projectedRelationMap.set(
          `${relation.source.id}\0${relation.type}\0${relation.target.id}`,
          {
            sourceId: relation.source.id,
            targetId: relation.target.id,
            type: relation.type,
          },
        );
      }
      const settlement = await prepareCheckpointSettlement(context, {
        checkpoint,
        agentId,
        spaces,
        config,
        result,
        retrievedIds: [...retrievedIds],
        unresolved,
        records: [...projectedRecords.values()],
        relations: [...projectedRelationMap.values()],
      });
      await commitMemoryConsolidation(context, {
        checkpointId,
        records: recordWrites,
        vectors,
        relations: relationWrites,
        checkpointPatch: settlement.patch,
        checkpointContent: settlement.content,
      });
      return result;
    } catch (error) {
      if (error instanceof MemorySourceInvalidatedError) {
        await settleCheckpointError(context, checkpointId, "failed", error);
        // Invalid source material cannot be repaired by this frozen task.
        // A terminal result closes its Core turn without another model call.
        return { outcome: "invalidated" as const };
      }
      if (onDemand) {
        await settleCheckpointError(context, checkpointId, "failed", error);
      }
      throw error;
    }
  },
});
export type { ConsolidateMemoryActionInput, ConsolidateMemoryActionResult };

export default consolidateMemoryAction;
