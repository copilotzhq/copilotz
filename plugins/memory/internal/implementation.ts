/**
 * Shared semantic-memory mechanics used by the canonical primitive owners.
 *
 * @module
 */

import {
  type AgentResource,
  coreAgentTurnMetadata,
  coreLlmCallMetadata,
  coreToolActionMetadata,
  coreToolPlanMetadata,
  withCoreAgentTurnMetadata,
  workflowMetadata,
} from "@copilotz/copilotz/core";
import type {
  ContentRef,
  PreparedAsset,
  PreparedContent,
} from "@copilotz/copilotz/content";
import type {
  CollectionRecord,
  GraphRelationUpsertInput,
} from "@copilotz/copilotz/collections";
import type {
  ConversationMessage,
  ConversationThread,
  Participant,
} from "@copilotz/copilotz/core";
import {
  type ActionCallOptions,
  type ActionContext,
  type ActionDefinition,
  type ActionSchema,
  parseActionLifecycleEvent,
} from "@copilotz/copilotz/actions";
import { addFormats, Ajv } from "../../../dependencies/ajv.ts";
import {
  listThreadMessageRecords,
  loadParticipantRecord,
  loadThreadRecord,
} from "@copilotz/copilotz/core";
import { estimateTextTokens } from "@copilotz/copilotz/llm/tokens";
import {
  collectContextContributions,
  type ContextResource,
  type ContextSourceRef,
  type FrozenContextContribution,
} from "@copilotz/copilotz/core";
import type { Processor, ProcessorContext } from "@copilotz/copilotz/plugins";
import { deriveWorkflowId } from "@copilotz/copilotz/events";
import { createThreadMessage } from "../../core-collections/actions/create-thread-message/index.ts";
import {
  buildMemoryConsolidationInstruction,
  isEditoriallyVisible,
  type MemoryRecordProjection,
  type MemoryRecordRelation,
  type MemorySourceMessage,
  type MemorySpaceDescriptor,
  parseConsolidateMemoryInput,
  proposalDrafts,
  renderLongTermMemory,
  selectLongTermMemoryRange,
  stableMemoryRecordId,
} from "../authoring/consolidation/index.ts";
import { memoryRecordCollection } from "../collections/internal/definitions.ts";
import {
  type AssertionMemoryDraft,
  CORE_MEMORY_KINDS,
  defaultMemoryLifecycle,
  defineMemoryKind,
  MEMORY_FORMS,
  MEMORY_RELATION_TYPES,
  type MemoryDraftBase,
  type MemoryForm,
  type MemoryKindDefinition,
  memoryLifecycleAllows,
  type MemoryNodeRef,
  memorySourceKey,
  type ProposedMemoryRef,
} from "../authoring/ontology/index.ts";
import type {
  MemoryAdapters,
  MemoryEmbed,
  MemoryResources,
} from "../authoring/contracts/index.ts";
import {
  DEFAULT_LONG_TERM_MEMORY_CONFIG,
  type LongTermMemoryConfig,
} from "../resources/config/index.ts";

const MEMORY_RESOURCE_ID = "copilotz.long_term";

/** Model-facing proposal accepted directly by `consolidate_memory`. */
export type ConsolidateMemoryActionInput = unknown;

export type ConsolidateMemoryActionResult = Readonly<
  & {
    outcome: "already_settled" | "no_changes" | "changes";
  }
  & Record<string, unknown>
>;

export type MemoryActionCallers = Readonly<{
  consolidate_memory(
    input: ConsolidateMemoryActionInput,
    options?: ActionCallOptions,
  ): Promise<ConsolidateMemoryActionResult>;
  list_knowledge_spaces(
    input: unknown,
    options?: ActionCallOptions,
  ): Promise<unknown>;
  search_memory(input: unknown, options?: ActionCallOptions): Promise<unknown>;
  inspect_memory(input: unknown, options?: ActionCallOptions): Promise<unknown>;
  set_memory_status(
    input: unknown,
    options?: ActionCallOptions,
  ): Promise<unknown>;
}>;

export type MemoryActionContext = ActionContext<
  MemoryResources,
  MemoryAdapters,
  MemoryActionCallers
>;

export type MemoryProcessorContext = ProcessorContext<
  MemoryResources,
  MemoryAdapters,
  MemoryActionCallers
>;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function requiredText(value: unknown, label: string): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) throw new TypeError(`${label} must be non-empty.`);
  return normalized;
}

function optionalText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function positiveInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}

function nonNegativeInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : fallback;
}

type AjvValidator = ((value: unknown) => boolean) & {
  errors?: readonly unknown[] | null;
};

const memoryKindValidators = new WeakMap<object, AjvValidator>();
// deno-lint-ignore no-explicit-any
const memoryKindAjv = new (Ajv as any)({
  strict: false,
  allErrors: true,
  useDefaults: false,
});
// deno-lint-ignore no-explicit-any
(addFormats as any)(memoryKindAjv);

function validateMemoryKindData(
  schema: object,
  value: unknown,
  label: string,
): void {
  let validator = memoryKindValidators.get(schema);
  if (!validator) {
    validator = memoryKindAjv.compile(schema) as AjvValidator;
    memoryKindValidators.set(schema, validator);
  }
  if (validator(structuredClone(value))) return;
  const details = memoryKindAjv.errorsText(validator.errors ?? [], {
    separator: "; ",
  });
  throw new TypeError(`${label}: ${details}`);
}

export function normalizedConfig(
  value?: Partial<LongTermMemoryConfig>,
): LongTermMemoryConfig {
  return Object.freeze({
    triggerEstimatedTokens: positiveInteger(
      value?.triggerEstimatedTokens,
      DEFAULT_LONG_TERM_MEMORY_CONFIG.triggerEstimatedTokens,
    ),
    retainRecentEstimatedTokens: nonNegativeInteger(
      value?.retainRecentEstimatedTokens,
      DEFAULT_LONG_TERM_MEMORY_CONFIG.retainRecentEstimatedTokens,
    ),
    maxContentEstimatedTokens: positiveInteger(
      value?.maxContentEstimatedTokens,
      DEFAULT_LONG_TERM_MEMORY_CONFIG.maxContentEstimatedTokens,
    ),
    retrievalLimit: positiveInteger(
      value?.retrievalLimit,
      DEFAULT_LONG_TERM_MEMORY_CONFIG.retrievalLimit,
    ),
  });
}

type MemoryRecordWrite =
  | Readonly<{
    operation: "create";
    record: Readonly<Record<string, unknown>> & { id: string };
  }>
  | Readonly<{
    operation: "update";
    id: string;
    patch: Readonly<Record<string, unknown>>;
  }>;

type MemoryRelationWrite = Readonly<{
  id: string;
  type: string;
  source: GraphRelationUpsertInput["source"];
  target: GraphRelationUpsertInput["target"];
  metadata?: Readonly<Record<string, unknown>>;
  weight?: number;
}>;

type CommitMemoryConsolidationInput = Readonly<{
  checkpointId: string;
  records: readonly MemoryRecordWrite[];
  relations: readonly MemoryRelationWrite[];
  checkpointPatch: Readonly<Record<string, unknown>>;
  checkpointContent: PreparedContent;
}>;

async function commitMemoryConsolidation(
  context: MemoryActionContext,
  input: CommitMemoryConsolidationInput,
) {
  return await context.transaction(async (tx) => {
    for (const write of input.records) {
      if (write.operation === "create") {
        if (write.record.consolidationId !== input.checkpointId) {
          throw new TypeError(
            `Memory record '${write.record.id}' must belong to checkpoint '${input.checkpointId}'.`,
          );
        }
        await tx.collections.memoryRecord.create(
          write.record as never,
          { operationKey: `memory-record:create:${write.record.id}` },
        );
        continue;
      }
      await tx.collections.memoryRecord.update({
        id: write.id,
        set: write.patch,
      }, { operationKey: `memory-record:update:${write.id}` });
    }

    for (const relation of input.relations) {
      await tx.relations.upsert(relation);
    }

    const checkpointPatch: Record<string, unknown> = {
      ...input.checkpointPatch,
      content: input.checkpointContent,
    };
    await tx.collections.longTermMemory.commands.completeConsolidation({
      id: input.checkpointId,
      ...checkpointPatch,
    }, { operationKey: `memory-checkpoint:ready:${input.checkpointId}` });

    return Object.freeze({
      checkpointId: input.checkpointId,
      createdRecordIds: Object.freeze(
        input.records.flatMap((write) =>
          write.operation === "create" ? [write.record.id] : []
        ),
      ),
      updatedRecordIds: Object.freeze(
        input.records.flatMap((write) =>
          write.operation === "update" ? [write.id] : []
        ),
      ),
      relationIds: Object.freeze(
        input.relations.map((relation) => relation.id),
      ),
    });
  }, { operationKey: `memory:${input.checkpointId}:commit` });
}

function checkpointSequence(value: CollectionRecord | null): number {
  const sequence = Number(value?.sequence);
  return Number.isSafeInteger(sequence) && sequence > 0 ? sequence : 0;
}

function participantAgentId(participant: Participant): string {
  return participant.agentId ?? participant.externalId;
}

async function checkpoints(
  context: MemoryProcessorContext,
  threadId: string,
  agentId: string,
  status?: "pending" | "ready" | "failed" | "cancelled",
) {
  const values = await context.collections.longTermMemory.list({
    where: { threadId, agentId, ...(status ? { status } : {}) },
    limit: 1_000,
  });
  return Object.freeze(
    values.filter((item) =>
      item.threadId === threadId && item.agentId === agentId &&
      (!status || item.status === status)
    ).sort((left, right) =>
      checkpointSequence(right) - checkpointSequence(left)
    ),
  );
}

async function threadMemorySpaces(
  context: MemoryProcessorContext,
  threadId: string,
): Promise<readonly MemorySpaceDescriptor[]> {
  const grants = await context.collections.memorySpaceAccess
    .list({ where: { threadId }, limit: 1_000 });
  const spaces: MemorySpaceDescriptor[] = [];
  for (const grant of grants) {
    const memorySpaceId = optionalText(grant.memorySpaceId);
    if (!memorySpaceId) continue;
    const space = await context.collections.memorySpace.get({
      id: memorySpaceId,
    });
    if (!space) continue;
    const access = grant.access === "read_write" ? "read_write" : "read";
    spaces.push(Object.freeze({
      id: memorySpaceId,
      name: optionalText(space.name) ?? `memory:${memorySpaceId}`,
      description: optionalText(space.description) ?? null,
      scopeType: optionalText(space.scopeType) ?? "custom",
      access,
      defaultWrite: access === "read_write" && grant.defaultWrite === true,
    }));
  }
  const ordered = spaces.sort((left, right) =>
    Number(right.defaultWrite) - Number(left.defaultWrite) ||
    left.id.localeCompare(right.id)
  );
  const firstWritable = ordered.find((space) => space.access === "read_write");
  if (firstWritable && !ordered.some((space) => space.defaultWrite)) {
    ordered[ordered.indexOf(firstWritable)] = Object.freeze({
      ...firstWritable,
      defaultWrite: true,
    });
  }
  let usedDefault = false;
  return Object.freeze(ordered.map((space) => {
    if (!space.defaultWrite) return space;
    if (!usedDefault) {
      usedDefault = true;
      return space;
    }
    return Object.freeze({ ...space, defaultWrite: false });
  }));
}

async function ensureWritableMemorySpace(
  context: MemoryProcessorContext,
  threadId: string,
) {
  const current = await threadMemorySpaces(context, threadId);
  if (current.some((space) => space.access === "read_write")) return current;
  const memorySpaceId = `memory-space:thread:${threadId}`;
  await context.collections.memorySpace.create({
    id: memorySpaceId,
    name: `Thread ${threadId}`,
    scopeType: "thread",
    scopeId: threadId,
    kind: "thread",
    ownerNodeId: threadId,
    threadId,
    access: "read_write",
    defaultWrite: true,
    description: "Default thread memory space",
    metadata: {},
  }, { operationKey: `space:create:${memorySpaceId}` });
  const grantId = `memory-space-access:${threadId}:${memorySpaceId}`;
  await context.collections.memorySpaceAccess.create({
    id: grantId,
    threadId,
    memorySpaceId,
    access: "read_write",
    defaultWrite: true,
    metadata: {},
  }, { operationKey: `space:grant:${grantId}` });
  return await threadMemorySpaces(context, threadId);
}

function checkpointAccessible(
  checkpoint: CollectionRecord,
  spaces: readonly MemorySpaceDescriptor[],
): boolean {
  const readable = new Set(spaces.map((space) => space.id));
  const ids = Array.isArray(checkpoint.readMemorySpaceIds)
    ? checkpoint.readMemorySpaceIds.filter((id): id is string =>
      typeof id === "string"
    )
    : [];
  return ids.length > 0 && ids.every((id) => readable.has(id));
}

async function latestReadyCheckpoint(
  context: MemoryProcessorContext,
  threadId: string,
  agentId: string,
  spaces: readonly MemorySpaceDescriptor[],
  beforeSequence = Number.POSITIVE_INFINITY,
) {
  return (await checkpoints(context, threadId, agentId, "ready")).find((item) =>
    checkpointSequence(item) < beforeSequence &&
    checkpointAccessible(item, spaces)
  ) ?? null;
}

async function messageText(
  context: MemoryProcessorContext,
  message: ConversationMessage,
): Promise<string> {
  const resolved = await context.content.resolveMany(message.content);
  return resolved.map((item) =>
    item.text ??
      (item.value !== undefined
        ? JSON.stringify(item.value)
        : `[${item.ref.kind}:${item.ref.name ?? item.ref.mediaType}]`)
  ).join("\n");
}

async function sourceMessages(
  context: MemoryProcessorContext,
  messages: readonly ConversationMessage[],
): Promise<readonly MemorySourceMessage[]> {
  const result: MemorySourceMessage[] = [];
  for (const message of messages) {
    const metadata = record(message.metadata);
    const toolCalls = Array.isArray(metadata.llmToolCalls)
      ? structuredClone(metadata.llmToolCalls)
      : undefined;
    let reasoning: string | undefined;
    const reasoningRefs = Array.isArray(metadata.llmReasoning)
      ? metadata.llmReasoning as ContentRef[]
      : [];
    if (reasoningRefs[0]) {
      const resolved = await context.content.resolve(reasoningRefs[0]);
      reasoning = resolved.text ?? new TextDecoder().decode(resolved.bytes);
    }
    result.push(Object.freeze({
      id: message.id,
      senderType: message.sender.participantType,
      senderId: message.sender.externalId,
      text: await messageText(context, message),
      ...(toolCalls !== undefined ? { toolCalls } : {}),
      ...(reasoning ? { reasoning } : {}),
    }));
  }
  return Object.freeze(result);
}

function memoryRecord(value: CollectionRecord): MemoryRecordProjection | null {
  const form = optionalText(value.form) as MemoryForm | undefined;
  const memorySpaceId = optionalText(value.memorySpaceId);
  const kind = optionalText(value.kind);
  const summary = optionalText(value.summary);
  const status = optionalText(value.status);
  const validity = optionalText(record(value.validity).status);
  return form && MEMORY_FORMS.includes(form) && memorySpaceId && kind &&
      summary && status &&
      (validity === "valid" || validity === "retracted" ||
        validity === "superseded" || validity === "archived")
    ? Object.freeze({
      id: value.id,
      memorySpaceId,
      form,
      kind,
      summary,
      status,
      validity,
      data: record(value.data),
    })
    : null;
}

async function activeMemoryRecords(
  context: MemoryProcessorContext,
  spaces: readonly MemorySpaceDescriptor[],
  agentId: string,
) {
  const readable = new Set(spaces.map((space) => space.id));
  const values = await context.collections.memoryRecord.list({
    where: { createdByAgentId: agentId },
    limit: 1_000,
  });
  return Object.freeze(values.flatMap((value) => {
    if (!readable.has(String(value.memorySpaceId))) return [];
    const mapped = memoryRecord(value);
    return mapped ? [mapped] : [];
  }));
}

function terminalStatus(status: string): boolean {
  return [
    "superseded",
    "retracted",
    "cancelled",
    "obsolete",
    "deprecated",
    "merged",
    "archived",
  ].includes(status);
}

function finiteEmbedding(value: unknown): value is readonly number[] {
  return Array.isArray(value) && value.length > 0 &&
    value.every((item) => typeof item === "number" && Number.isFinite(item));
}

function cosine(left: readonly number[], right: readonly number[]): number {
  if (left.length !== right.length || !left.length) return 0;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index++) {
    dot += left[index] * right[index];
    leftNorm += left[index] ** 2;
    rightNorm += right[index] ** 2;
  }
  return leftNorm && rightNorm ? dot / Math.sqrt(leftNorm * rightNorm) : 0;
}

function lexicalScore(query: string, candidate: string): number {
  const words = (value: string) =>
    new Set(value.toLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? []);
  const wanted = words(query);
  const found = words(candidate);
  if (!wanted.size || !found.size) return 0;
  let overlap = 0;
  for (const word of wanted) if (found.has(word)) overlap++;
  return overlap / Math.sqrt(wanted.size * found.size);
}

async function candidateRecords(
  context: MemoryProcessorContext,
  input: Readonly<{
    query: string;
    form: MemoryForm;
    kind: string;
    spaces: readonly MemorySpaceDescriptor[];
    agent: AgentResource;
    threadId: string;
    checkpointId: string;
    limit: number;
    embed?: MemoryEmbed;
  }>,
) {
  const thread = await loadThreadRecord(context, input.threadId);
  if (!thread) {
    throw new Error(`Memory thread '${input.threadId}' was not found.`);
  }
  const readable = new Set(input.spaces.map((space) => space.id));
  const candidates = (await context.collections.memoryRecord.list({
    where: {
      form: input.form,
      kind: input.kind,
      createdByAgentId: input.agent.id,
    },
    limit: 1_000,
  })).filter((item) =>
    readable.has(String(item.memorySpaceId)) &&
    isEditoriallyVisible(memoryRecord(item)!) &&
    !terminalStatus(String(item.status))
  );
  let queryEmbedding: readonly number[] | undefined;
  if (input.embed && input.query) {
    const values = await input.embed([input.query], {
      agent: input.agent,
      thread,
      checkpointId: input.checkpointId,
      context,
    });
    if (finiteEmbedding(values[0])) queryEmbedding = values[0];
  }
  return Object.freeze(
    candidates.flatMap((item) => {
      const mapped = memoryRecord(item);
      if (!mapped) return [];
      const embedding = finiteEmbedding(item.embedding)
        ? item.embedding
        : undefined;
      return [{
        raw: item,
        record: mapped,
        score: queryEmbedding && embedding
          ? cosine(queryEmbedding, embedding)
          : lexicalScore(input.query, mapped.summary),
      }];
    }).sort((left, right) =>
      right.score - left.score || left.record.id.localeCompare(right.record.id)
    ).slice(0, input.limit),
  );
}

function combinePrepared(values: readonly PreparedContent[]): PreparedContent {
  const assets = new Map<string, PreparedAsset>();
  for (const value of values) {
    for (const asset of value.assets) assets.set(asset.id, asset);
  }
  return Object.freeze({
    content: Object.freeze(values.flatMap((value) => value.content)),
    assets: Object.freeze([...assets.values()]),
  });
}

function frozenSnapshot(
  value: CollectionRecord,
): readonly FrozenContextContribution[] {
  if (!Array.isArray(value.contextSnapshot)) return Object.freeze([]);
  return Object.freeze(value.contextSnapshot.flatMap((item) => {
    const input = record(item);
    if (!Array.isArray(input.content)) return [];
    const role = input.role === "evidence" ? "evidence" : "context";
    return [Object.freeze({
      id: requiredText(input.id, "Frozen context id"),
      resourceId: requiredText(input.resourceId, "Frozen context resource id"),
      title: requiredText(input.title, "Frozen context title"),
      role,
      content: Object.freeze(structuredClone(input.content) as ContentRef[]),
      ...(input.source
        ? { source: structuredClone(input.source) as ContextSourceRef }
        : {}),
      capturedAt: requiredText(input.capturedAt, "Frozen context capture time"),
      ...(optionalText(input.historyAfterMessageId)
        ? { historyAfterMessageId: optionalText(input.historyAfterMessageId) }
        : {}),
    })];
  }));
}

async function captureContextSnapshot(
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
  const snapshot = Object.freeze(
    contributed.map((item, index) =>
      Object.freeze({
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
      })
    ),
  );
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

function rangeMessages(
  all: readonly ConversationMessage[],
  checkpoint: CollectionRecord,
) {
  const start = all.findIndex((message) =>
    message.id === checkpoint.sourceStartMessageId
  );
  const end = all.findIndex((message) =>
    message.id === checkpoint.sourceEndMessageId
  );
  if (start < 0 || end < start) {
    throw new Error("Reserved memory message range is unavailable.");
  }
  return Object.freeze(all.slice(start, end + 1));
}

function memoryKinds(
  context: MemoryActionContext | MemoryProcessorContext,
) {
  return Object.freeze(
    Object.values(context.resources.memoryKinds).filter((
      value,
    ): value is MemoryKindDefinition => !!value).map(defineMemoryKind),
  );
}

function memoryActionProvenance(context: MemoryActionContext): Readonly<{
  threadId: string;
  agentId: string;
}> {
  return Object.freeze({
    threadId: requiredText(
      context.action.metadata.threadId,
      "Memory Action thread id",
    ),
    agentId: requiredText(
      context.action.metadata.agentId,
      "Memory Action agent id",
    ),
  });
}

async function reserveOnDemandCheckpoint(
  context: MemoryActionContext,
  provenance: NonNullable<ReturnType<typeof coreToolActionMetadata>>,
): Promise<CollectionRecord> {
  const id = `memory:on-demand:${await deriveWorkflowId(
    "memory-on-demand",
    provenance.planId,
    String(provenance.planIndex),
    String(provenance.stageIndex),
  )}`;
  const existing = await context.collections.longTermMemory.get({ id });
  if (existing) return existing;
  const spaces = await ensureWritableMemorySpace(context, provenance.threadId);
  const previous = await latestReadyCheckpoint(
    context,
    provenance.threadId,
    provenance.agentId,
    spaces,
  );
  const history = await listThreadMessageRecords(context, provenance.threadId);
  const triggerIndex = history.findIndex((message) =>
    message.id === provenance.triggerMessageId
  );
  if (triggerIndex < 0) {
    throw new Error("Memory Tool trigger Message is unavailable.");
  }
  const after = optionalText(previous?.sourceEndMessageId);
  const start = after
    ? history.findIndex((message) => message.id === after) + 1
    : 0;
  if (start < 0 || start > triggerIndex) {
    throw new Error("Memory Tool has no unconsolidated source range.");
  }
  const range = history.slice(start, triggerIndex + 1);
  if (!range.length) throw new Error("Memory Tool has no source Messages.");
  const writable = spaces.filter((space) => space.access === "read_write");
  const defaultSpace = spaces.find((space) => space.defaultWrite);
  if (!defaultSpace || !writable.length) {
    throw new Error("Thread has no default writable memory space.");
  }
  const sequence = Math.max(
    checkpointSequence(previous),
    ...(await checkpoints(context, provenance.threadId, provenance.agentId))
      .map(
        checkpointSequence,
      ),
  ) + 1;
  try {
    await context.collections.longTermMemory.create({
      id,
      name:
        `Thread ${provenance.threadId} / ${provenance.agentId} / ${sequence}`,
      threadId: provenance.threadId,
      schemaVersion: "4",
      strategy: "semantic_graph",
      status: "pending",
      memorySpaceId: defaultSpace.id,
      readMemorySpaceIds: spaces.map((space) => space.id),
      writeMemorySpaceIds: writable.map((space) => space.id),
      defaultWriteMemorySpaceId: defaultSpace.id,
      sequence,
      agentId: provenance.agentId,
      sourceStartMessageId: range[0]!.id,
      sourceEndMessageId: range.at(-1)!.id,
      content: [],
      contextSnapshotContent: [],
      contextSnapshot: null,
      embedding: null,
      contentHash: null,
      tokenEstimate: null,
      error: null,
      metadata: {
        agentParticipantId: provenance.agentParticipantId,
        initiatorParticipantId: provenance.initiatorParticipantId,
        onDemand: true,
      },
    }, { operationKey: `checkpoint:on-demand:${id}` });
  } catch (error) {
    const concurrent = await context.collections.longTermMemory.get({ id });
    if (concurrent) return concurrent;
    throw error;
  }
  const created = await context.collections.longTermMemory.get({ id });
  if (!created) throw new Error(`Memory checkpoint '${id}' was not created.`);
  return created;
}

async function checkpointForConsolidation(
  context: MemoryActionContext,
): Promise<CollectionRecord> {
  const provenance = coreToolActionMetadata(context.action.metadata);
  if (!provenance) {
    throw new Error(
      "consolidate_memory requires trusted Core Tool provenance.",
    );
  }
  const turn = provenance.agentTurn;
  if (!turn) return await reserveOnDemandCheckpoint(context, provenance);
  if (turn.ownerParticipantId !== provenance.agentParticipantId) {
    throw new Error("Memory Agent turn owner does not match Tool provenance.");
  }
  if (
    !await memoryTaskOwnsTurn(
      context,
      turn,
      provenance.triggerMessageId,
    )
  ) {
    throw new Error(
      "Memory Agent turn provenance does not own this checkpoint.",
    );
  }
  const checkpoint = await context.collections.longTermMemory.get({
    id: turn.id,
  });
  if (
    !checkpoint || checkpoint.threadId !== provenance.threadId ||
    checkpoint.agentId !== provenance.agentId ||
    record(checkpoint.metadata).agentParticipantId !==
      provenance.agentParticipantId
  ) {
    throw new Error(
      "Memory checkpoint does not match trusted Tool provenance.",
    );
  }
  return checkpoint;
}

async function settleCheckpointError(
  context: MemoryProcessorContext,
  checkpointId: string,
  status: "failed" | "cancelled",
  error: unknown,
) {
  const checkpoint = await context.collections.longTermMemory
    .get({ id: checkpointId });
  if (!checkpoint || checkpoint.status !== "pending") return;
  await context.collections.longTermMemory.update(
    {
      id: checkpointId,
      set: {
        status,
        error: {
          name: error instanceof Error ? error.name : "Error",
          message: error instanceof Error ? error.message : String(error),
        },
      },
    },
    { operationKey: `checkpoint:${checkpointId}:${status}` },
  );
}

function activeSpacesForCheckpoint(
  checkpoint: CollectionRecord,
  spaces: readonly MemorySpaceDescriptor[],
) {
  const readable = new Set(
    Array.isArray(checkpoint.readMemorySpaceIds)
      ? checkpoint.readMemorySpaceIds
      : [],
  );
  const writable = new Set(
    Array.isArray(checkpoint.writeMemorySpaceIds)
      ? checkpoint.writeMemorySpaceIds
      : [],
  );
  const defaultId = optionalText(checkpoint.defaultWriteMemorySpaceId);
  const active = spaces.filter((space) => readable.has(space.id)).map((space) =>
    Object.freeze({
      ...space,
      access: writable.has(space.id) && space.access === "read_write"
        ? "read_write" as const
        : "read" as const,
      defaultWrite: space.id === defaultId && writable.has(space.id),
    })
  );
  if (
    !active.some((space) => space.defaultWrite && space.access === "read_write")
  ) {
    throw new Error(
      "Memory checkpoint has no accessible default writable space.",
    );
  }
  return Object.freeze(active);
}

function sourceCatalog(
  messages: readonly ConversationMessage[],
  snapshot: readonly FrozenContextContribution[],
) {
  const evidence: ContextSourceRef[] = [];
  const nodes = new Set<string>();
  for (const message of messages) {
    evidence.push({ type: "message", id: message.id });
    for (const ref of message.content) {
      evidence.push({ type: "asset", id: ref.assetId });
    }
  }
  for (const item of snapshot) {
    if (item.role === "evidence" && item.source) evidence.push(item.source);
    if (item.source?.type === "collection_record") {
      nodes.add(`${item.source.collection}:${item.source.id}`);
    }
  }
  return Object.freeze({
    evidence: Object.freeze(evidence),
    keys: new Set(evidence.map(memorySourceKey)),
    nodes,
  });
}

function assertedBy(
  sources: readonly ContextSourceRef[],
  messages: readonly ConversationMessage[],
): MemoryNodeRef | undefined {
  const byId = new Map(messages.map((message) => [message.id, message]));
  const participantIds = new Set(
    sources.flatMap((source) => {
      if (source.type !== "message") return [];
      const participantId = byId.get(source.id)?.sender.id;
      return participantId ? [participantId] : [];
    }),
  );
  return participantIds.size === 1
    ? { type: "participant", id: [...participantIds][0] }
    : undefined;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${
      Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
        a.localeCompare(b)
      ).map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(
        ",",
      )
    }}`;
  }
  return JSON.stringify(value);
}

function resolveRef(
  ref: ProposedMemoryRef,
  local: ReadonlyMap<string, string>,
): MemoryNodeRef {
  if ("localId" in ref) {
    return {
      type: memoryRecordCollection.name,
      id: requiredText(
        local.get(ref.localId),
        `Memory local ref '${ref.localId}'`,
      ),
    };
  }
  if ("memoryId" in ref) {
    return { type: memoryRecordCollection.name, id: ref.memoryId };
  }
  return ref.node;
}

function draftData(
  form: MemoryForm,
  draft: MemoryDraftBase & Record<string, unknown>,
  local: ReadonlyMap<string, string>,
) {
  const copy = structuredClone(draft) as Record<string, unknown>;
  for (
    const key of [
      "localId",
      "kind",
      "summary",
      "spaceId",
      "sources",
      "epistemic",
      "temporal",
      "status",
    ]
  ) delete copy[key];
  const mapRef = (value: unknown) =>
    resolveRef(value as ProposedMemoryRef, local);
  if (form === "assertion") {
    copy.subject = mapRef(copy.subject);
    const object = record(copy.object);
    if (object.ref) copy.object = { ref: mapRef(object.ref) };
  } else if (form === "occurrence" && Array.isArray(copy.participants)) {
    copy.participants = copy.participants.map(mapRef);
  } else if (form === "intent") {
    if (copy.owner) copy.owner = mapRef(copy.owner);
    if (copy.target) copy.target = mapRef(copy.target);
  } else if (form === "inquiry") {
    if (Array.isArray(copy.about)) copy.about = copy.about.map(mapRef);
    if (copy.answer) copy.answer = mapRef(copy.answer);
  }
  return Object.freeze(copy);
}

function intentOrInquiryStatus(
  form: MemoryForm,
  draft: Record<string, unknown>,
) {
  return (form === "intent" || form === "inquiry") &&
      typeof draft.status === "string"
    ? draft.status
    : defaultMemoryLifecycle(form);
}

async function recordRelations(
  context: MemoryProcessorContext,
  ids: ReadonlySet<string>,
) {
  return Object.freeze(
    (await context.collections.memoryRecord.relations.list({
      types: MEMORY_RELATION_TYPES,
      limit: 1_000,
    }))
      .filter((relation) =>
        ids.has(relation.source.id) && ids.has(relation.target.id)
      )
      .map((relation): MemoryRecordRelation => ({
        sourceId: relation.source.id,
        targetId: relation.target.id,
        type: relation.type,
      })),
  );
}

async function prepareCheckpointSettlement(
  context: MemoryProcessorContext,
  input: Readonly<{
    checkpoint: CollectionRecord;
    agentId: string;
    spaces: readonly MemorySpaceDescriptor[];
    config: LongTermMemoryConfig;
    result: Readonly<Record<string, unknown>>;
    retrievedIds?: readonly string[];
    unresolved?: readonly unknown[];
    records?: readonly MemoryRecordProjection[];
    relations?: readonly MemoryRecordRelation[];
  }>,
) {
  const records = input.records ?? await activeMemoryRecords(
    context,
    input.spaces,
    input.agentId,
  );
  const ids = new Set(records.map((item) => item.id));
  const relations = input.relations ?? await recordRelations(context, ids);
  const text = renderLongTermMemory({
    records,
    relations,
    maxContentEstimatedTokens: input.config.maxContentEstimatedTokens,
  });
  const prepared = await context.content.prepare({
    type: "text",
    text,
    role: "memory.snapshot",
  }, {
    operationKey: `checkpoint:${input.checkpoint.id}:content`,
  });
  return Object.freeze({
    content: prepared,
    patch: Object.freeze({
      status: "ready",
      contentHash: prepared.assets[0]?.digest ?? null,
      tokenEstimate: estimateTextTokens(text),
      error: null,
      metadata: {
        ...record(input.checkpoint.metadata),
        processorVersion: "v4",
        memoryOntologyVersion: "1",
        result: input.result,
        retrievedMemoryIds: input.retrievedIds ?? [],
        unresolvedReconciliations: input.unresolved ?? [],
      },
    }),
  });
}

async function settleCheckpoint(
  context: MemoryProcessorContext,
  input: Parameters<typeof prepareCheckpointSettlement>[1],
) {
  const settlement = await prepareCheckpointSettlement(context, input);
  await context.collections.longTermMemory.update(
    {
      id: input.checkpoint.id,
      set: {
        ...settlement.patch,
        content: settlement.content,
      },
    },
    { operationKey: `checkpoint:${input.checkpoint.id}:ready` },
  );
}

const consolidationInputSchemaBase: ActionSchema = {
  type: "object",
  additionalProperties: false,
  required: ["outcome"],
  example: { outcome: "no_changes" },
  $defs: {
    source: {
      description:
        "Trusted evidence reference. Explicit references must use canonical IDs authorized for the current checkpoint; do not invent IDs. Omit draft sources when no authorized ID is available.",
      oneOf: [
        {
          type: "object",
          additionalProperties: false,
          required: ["type", "id"],
          properties: {
            type: { enum: ["message", "asset", "external"] },
            id: {
              type: "string",
              minLength: 1,
              description:
                "Canonical source ID supplied by trusted context or a discovery Tool.",
            },
          },
        },
        {
          type: "object",
          additionalProperties: false,
          required: ["type", "collection", "id"],
          properties: {
            type: { const: "collection_record" },
            collection: { type: "string", minLength: 1 },
            id: {
              type: "string",
              minLength: 1,
              description:
                "Canonical record ID supplied by the frozen trusted context.",
            },
            version: { type: ["string", "number"] },
            updatedAt: { type: "string" },
            fragment: { type: "string" },
          },
        },
      ],
    },
    ref: {
      oneOf: [
        {
          type: "object",
          additionalProperties: false,
          required: ["localId"],
          properties: {
            localId: {
              type: "string",
              minLength: 1,
              example: "project",
              description:
                "Temporary ID defined by another draft in this same payload.",
            },
          },
        },
        {
          type: "object",
          additionalProperties: false,
          required: ["memoryId"],
          properties: { memoryId: { type: "string", minLength: 1 } },
        },
        {
          type: "object",
          additionalProperties: false,
          required: ["node"],
          properties: {
            node: {
              type: "object",
              additionalProperties: false,
              required: ["type", "id"],
              description:
                "Domain node visible in the frozen checkpoint context. Both type and canonical ID must come from trusted context.",
              properties: {
                type: { type: "string", minLength: 1 },
                id: { type: "string", minLength: 1 },
              },
            },
          },
        },
      ],
    },
  },
  oneOf: [
    {
      properties: { outcome: { const: "changes" } },
      anyOf: [
        { required: ["entities"], properties: { entities: { minItems: 1 } } },
        {
          required: ["assertions"],
          properties: { assertions: { minItems: 1 } },
        },
        {
          required: ["occurrences"],
          properties: { occurrences: { minItems: 1 } },
        },
        { required: ["intents"], properties: { intents: { minItems: 1 } } },
        {
          required: ["inquiries"],
          properties: { inquiries: { minItems: 1 } },
        },
        {
          required: ["procedures"],
          properties: { procedures: { minItems: 1 } },
        },
        {
          required: ["relations"],
          properties: { relations: { minItems: 1 } },
        },
        {
          required: ["lifecycle"],
          properties: { lifecycle: { minItems: 1 } },
        },
      ],
    },
    {
      properties: { outcome: { const: "no_changes" } },
      allOf: [
        { properties: { entities: { maxItems: 0 } } },
        { properties: { assertions: { maxItems: 0 } } },
        { properties: { occurrences: { maxItems: 0 } } },
        { properties: { intents: { maxItems: 0 } } },
        { properties: { inquiries: { maxItems: 0 } } },
        { properties: { procedures: { maxItems: 0 } } },
        { properties: { relations: { maxItems: 0 } } },
        { properties: { lifecycle: { maxItems: 0 } } },
      ],
    },
  ],
  properties: {
    outcome: {
      enum: ["changes", "no_changes"],
      example: "no_changes",
      description:
        "Use changes when at least one draft, relation, or lifecycle change is present. Use no_changes alone when nothing durable should be written.",
    },
    entities: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["localId", "kind", "summary", "name"],
        properties: {
          localId: { type: "string" },
          kind: { type: "string" },
          summary: { type: "string" },
          name: {
            type: "string",
            minLength: 1,
            description: "Canonical display name of the entity.",
          },
          aliases: {
            type: "array",
            uniqueItems: true,
            items: { type: "string", minLength: 1 },
          },
          externalIds: {
            type: "object",
            additionalProperties: { type: "string", minLength: 1 },
          },
          spaceId: { type: "string" },
          attributes: { type: "object" },
          sources: { type: "array", items: { $ref: "#/$defs/source" } },
        },
      },
    },
    assertions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "localId",
          "kind",
          "summary",
          "subject",
          "predicate",
          "object",
          "epistemic",
        ],
        properties: {
          localId: { type: "string" },
          kind: { type: "string" },
          summary: { type: "string" },
          spaceId: { type: "string" },
          attributes: { type: "object" },
          sources: { type: "array", items: { $ref: "#/$defs/source" } },
          subject: { $ref: "#/$defs/ref" },
          predicate: {
            type: "string",
            minLength: 1,
            description: "Stable domain predicate relating subject and object.",
          },
          object: {
            oneOf: [{
              type: "object",
              additionalProperties: false,
              required: ["ref"],
              properties: { ref: { $ref: "#/$defs/ref" } },
            }, {
              type: "object",
              additionalProperties: false,
              required: ["value"],
              properties: {
                value: { type: ["string", "number", "boolean", "null"] },
              },
            }],
          },
          epistemic: {
            type: "object",
            additionalProperties: false,
            required: ["basis", "stance"],
            properties: {
              basis: { enum: ["observed", "reported", "inferred", "assumed"] },
              stance: { enum: ["affirmed", "denied", "tentative", "disputed"] },
            },
          },
          temporal: {
            type: "object",
            additionalProperties: false,
            properties: {
              validFrom: { type: "string" },
              validTo: { type: "string" },
            },
          },
        },
      },
    },
    occurrences: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["localId", "kind", "summary"],
        properties: {
          localId: { type: "string" },
          kind: { type: "string" },
          summary: { type: "string" },
          spaceId: { type: "string" },
          attributes: { type: "object" },
          sources: { type: "array", items: { $ref: "#/$defs/source" } },
          participants: { type: "array", items: { $ref: "#/$defs/ref" } },
          temporal: {
            type: "object",
            additionalProperties: false,
            properties: {
              startedAt: { type: "string" },
              endedAt: { type: "string" },
            },
          },
        },
      },
    },
    intents: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["localId", "kind", "summary", "status"],
        properties: {
          localId: { type: "string" },
          kind: { type: "string" },
          summary: { type: "string" },
          spaceId: { type: "string" },
          attributes: { type: "object" },
          sources: { type: "array", items: { $ref: "#/$defs/source" } },
          owner: { $ref: "#/$defs/ref" },
          target: { $ref: "#/$defs/ref" },
          status: { enum: ["proposed", "active", "completed", "cancelled"] },
          dueAt: { type: "string" },
        },
      },
    },
    inquiries: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["localId", "kind", "summary", "question", "status"],
        properties: {
          localId: { type: "string" },
          kind: { type: "string" },
          summary: { type: "string" },
          question: {
            type: "string",
            minLength: 1,
            description:
              "The unresolved or answered question in explicit form.",
          },
          spaceId: { type: "string" },
          attributes: { type: "object" },
          sources: { type: "array", items: { $ref: "#/$defs/source" } },
          about: { type: "array", items: { $ref: "#/$defs/ref" } },
          answer: { $ref: "#/$defs/ref" },
          status: { enum: ["open", "answered", "obsolete"] },
        },
      },
    },
    procedures: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["localId", "kind", "summary", "steps"],
        properties: {
          localId: { type: "string" },
          kind: { type: "string" },
          summary: { type: "string" },
          spaceId: { type: "string" },
          attributes: { type: "object" },
          sources: { type: "array", items: { $ref: "#/$defs/source" } },
          trigger: { type: "string" },
          preconditions: {
            type: "array",
            uniqueItems: true,
            items: { type: "string", minLength: 1 },
          },
          steps: {
            type: "array",
            minItems: 1,
            uniqueItems: true,
            items: { type: "string", minLength: 1 },
            description: "Ordered, non-empty reusable procedure steps.",
          },
          expectedOutcome: { type: "string" },
          applicability: { type: "string" },
        },
      },
    },
    relations: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["from", "type", "to"],
        properties: {
          from: { $ref: "#/$defs/ref" },
          type: {
            enum: [
              "about",
              "same_as",
              "supports",
              "contradicts",
              "depends_on",
              "contributes_to",
              "blocks",
              "answers",
            ],
          },
          to: { $ref: "#/$defs/ref" },
          sources: {
            type: "array",
            minItems: 1,
            items: { $ref: "#/$defs/source" },
            description:
              "Optional explicit relation evidence. When present it must contain at least one authorized canonical source.",
          },
        },
      },
    },
    lifecycle: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["target", "status", "sources"],
        properties: {
          target: {
            oneOf: [{
              type: "object",
              additionalProperties: false,
              required: ["memoryId"],
              properties: { memoryId: { type: "string" } },
            }, {
              type: "object",
              additionalProperties: false,
              required: ["match"],
              properties: {
                match: {
                  type: "object",
                  additionalProperties: false,
                  required: ["form", "query"],
                  properties: {
                    form: { enum: MEMORY_FORMS },
                    kind: {
                      type: "string",
                      minLength: 1,
                      description:
                        "Optional kind used to narrow visible candidates. Use a registered kind for the selected form; resolution remains state-dependent.",
                    },
                    subject: {
                      $ref: "#/$defs/ref",
                      description:
                        "Optional subject filter accepted by the parser. Any memoryId or node reference must come from visible trusted context.",
                    },
                    predicate: {
                      type: "string",
                      minLength: 1,
                      description:
                        "Optional stable predicate used to narrow lifecycle candidates.",
                    },
                    query: {
                      type: "string",
                      minLength: 1,
                      description:
                        "Lexical query that must resolve exactly one visible memory; zero or multiple matches are returned as unresolved.",
                    },
                  },
                },
              },
            }],
          },
          status: {
            enum: [
              "superseded",
              "retracted",
              "completed",
              "cancelled",
              "answered",
              "obsolete",
              "deprecated",
            ],
            description:
              "Lifecycle transition of the described object. Use invalidate_memory, not lifecycle, for editorial invalidation of the memory record.",
          },
          replacement: { $ref: "#/$defs/ref" },
          sources: {
            type: "array",
            minItems: 1,
            items: { $ref: "#/$defs/source" },
          },
        },
      },
    },
  },
};

type MutableActionSchema = Record<string, unknown>;

function mutableSchemaObject(
  value: unknown,
  label: string,
): MutableActionSchema {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`Invalid consolidate_memory schema node '${label}'.`);
  }
  return value as MutableActionSchema;
}

function memoryKindInputSchema(
  form: MemoryForm,
  kinds: readonly MemoryKindDefinition[],
): ActionSchema {
  const registered = kinds.filter((kind) => kind.form === form);
  const catalogue = registered.map((kind) =>
    `${kind.id} — ${kind.description}${
      kind.schema
        ? ` Persisted semantic data schema: ${JSON.stringify(kind.schema)}`
        : " No additional kind-specific data schema is registered."
    }`
  ).join(" ");
  return {
    type: "string",
    enum: registered.map((kind) => kind.id),
    description:
      `Registered ${form} kind. Choose by semantics; arbitrary strings are rejected. ${catalogue}`,
    oneOf: registered.map((kind) => ({
      const: kind.id,
      title: kind.id,
      description: kind.schema
        ? `${kind.description} Persisted semantic data must also satisfy: ${
          JSON.stringify(kind.schema)
        }`
        : `${kind.description} No additional kind-specific fields are registered.`,
    })),
  };
}

function consolidationInputSchema(
  kinds: readonly MemoryKindDefinition[],
): ActionSchema {
  const schema = structuredClone(consolidationInputSchemaBase);
  const properties = mutableSchemaObject(schema.properties, "properties");
  const groups: Readonly<Record<MemoryForm, string>> = {
    entity: "entities",
    assertion: "assertions",
    occurrence: "occurrences",
    intent: "intents",
    inquiry: "inquiries",
    procedure: "procedures",
  };
  for (const form of MEMORY_FORMS) {
    const group = mutableSchemaObject(properties[groups[form]], groups[form]);
    const items = mutableSchemaObject(group.items, `${groups[form]}.items`);
    const itemProperties = mutableSchemaObject(
      items.properties,
      `${groups[form]}.items.properties`,
    );
    itemProperties.localId = {
      ...mutableSchemaObject(itemProperties.localId, `${form}.localId`),
      minLength: 1,
      example: `${form}-1`,
      description:
        "Unique temporary ID within this payload. Use { localId } references to connect drafts before canonical memory IDs exist.",
    };
    itemProperties.kind = memoryKindInputSchema(form, kinds);
    itemProperties.summary = {
      ...mutableSchemaObject(itemProperties.summary, `${form}.summary`),
      minLength: 1,
      description:
        "Self-contained durable summary used for retrieval. Preserve uncertainty, negation, ownership, and temporal meaning.",
    };
    itemProperties.spaceId = {
      ...mutableSchemaObject(itemProperties.spaceId, `${form}.spaceId`),
      description:
        "Optional writable memory-space ID. Omit it to use the checkpoint's trusted default writable space.",
    };
    itemProperties.attributes = {
      ...mutableSchemaObject(itemProperties.attributes, `${form}.attributes`),
      description:
        "Optional namespaced semantic attributes. When the selected kind documents an additional persisted-data schema, the final semantic data (including these attributes) must satisfy it.",
    };
    itemProperties.sources = {
      ...mutableSchemaObject(itemProperties.sources, `${form}.sources`),
      minItems: 1,
      description:
        "Optional explicit evidence. IDs must be authorized for this checkpoint. If omitted, the runtime currently uses the checkpoint's trusted default evidence; use explicit sources only when canonical IDs are actually available.",
    };
  }
  return schema;
}

const consolidationOutputSchema: ActionSchema = {
  type: "object",
  additionalProperties: false,
  required: ["outcome"],
  properties: {
    outcome: { enum: ["already_settled", "no_changes", "changes"] },
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

export function createConsolidateMemoryAction(
  config: LongTermMemoryConfig,
  kinds: readonly MemoryKindDefinition[] = CORE_MEMORY_KINDS,
): Pick<
  ActionDefinition<
    ConsolidateMemoryActionInput,
    ConsolidateMemoryActionResult,
    MemoryActionContext,
    ActionSchema
  >,
  "inputSchema" | "outputSchema" | "execute"
> {
  const kindDefinitions = Object.freeze(kinds.map(defineMemoryKind));
  return {
    inputSchema: consolidationInputSchema(kindDefinitions),
    outputSchema: consolidationOutputSchema,
    async execute(
      proposal: ConsolidateMemoryActionInput,
      context: MemoryActionContext,
    ): Promise<ConsolidateMemoryActionResult> {
      const checkpoint = await checkpointForConsolidation(context);
      const checkpointId = requiredText(checkpoint.id, "Memory checkpoint id");
      const raw = proposal;
      const embed = context.adapters.memoryEmbedding.default;
      if (checkpoint.status === "ready") {
        const prior = record(record(checkpoint.metadata).result);
        const outcome = optionalText(prior.outcome);
        if (
          outcome === "changes" || outcome === "no_changes" ||
          outcome === "already_settled"
        ) {
          return Object.freeze({ ...structuredClone(prior), outcome });
        }
        return Object.freeze({ outcome: "already_settled" });
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
        const allMessages = await listThreadMessageRecords(context, threadId);
        const range = rangeMessages(allMessages, checkpoint);
        const snapshot = frozenSnapshot(checkpoint);
        const catalog = sourceCatalog(range, snapshot);
        const kindDefinitions = memoryKinds(context);
        const currentRecords = await activeMemoryRecords(
          context,
          spaces,
          agentId,
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
          const result = Object.freeze({
            outcome: "no_changes",
            created: 0,
            reused: 0,
            lifecycleChanged: 0,
            createdRecords: [],
            reusedRecords: [],
            unresolvedReconciliations: [],
          });
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
          let embedding: readonly number[] | null = null;
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
            embedding = values[0];
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
            embedding,
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
        const auditRecords = drafts.map(({ form, draft }) =>
          Object.freeze({
            localId: draft.localId,
            memoryId: persisted.get(draft.localId)!,
            form,
            status:
              projectedRecords.get(persisted.get(draft.localId)!)?.status ??
                defaultMemoryLifecycle(form),
            summary: draft.summary,
          })
        );
        const result = Object.freeze({
          outcome: "changes" as const,
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
        });
        const recordWrites: MemoryRecordWrite[] = [
          ...[...createdRecords.values()].map((record) =>
            Object.freeze({
              operation: "create" as const,
              record: record as Record<string, unknown> & { id: string },
            })
          ),
          ...[...updatedRecords].map(([id, patch]) =>
            Object.freeze({ operation: "update" as const, id, patch })
          ),
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
          relations: relationWrites,
          checkpointPatch: settlement.patch,
          checkpointContent: settlement.content,
        });
        return result;
      } catch (error) {
        if (onDemand) {
          await settleCheckpointError(context, checkpointId, "failed", error);
        }
        throw error;
      }
    },
  };
}

export function listSpacesAction(): Pick<
  ActionDefinition<unknown, unknown, MemoryActionContext, ActionSchema>,
  "inputSchema" | "execute"
> {
  return {
    inputSchema: {
      type: "object",
      properties: { limit: { type: "integer", minimum: 1, maximum: 1_000 } },
    },
    async execute(raw, context) {
      const limit = positiveInteger(record(raw).limit, 100);
      const values = (await threadMemorySpaces(
        context,
        memoryActionProvenance(context).threadId,
      )).slice(0, Math.min(limit, 1_000));
      return { knowledgeSpaces: values, totalKnowledgeSpaces: values.length };
    },
  };
}

export function searchMemoryAction(): Pick<
  ActionDefinition<unknown, unknown, MemoryActionContext, ActionSchema>,
  "inputSchema" | "execute"
> {
  return {
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        form: { enum: MEMORY_FORMS },
        kind: { type: "string" },
        status: { type: "string" },
        includeHistory: { type: "boolean" },
        limit: { type: "integer", minimum: 1, maximum: 100 },
      },
    },
    async execute(raw, context) {
      const input = record(raw);
      const spaces = await threadMemorySpaces(
        context,
        memoryActionProvenance(context).threadId,
      );
      const readable = new Set(spaces.map((space) => space.id));
      const values = await context.collections.memoryRecord.list({
        limit: 1_000,
      });
      const query = optionalText(input.query) ?? "";
      const selected = values.flatMap((item) => {
        const mapped = memoryRecord(item);
        if (!mapped || !readable.has(mapped.memorySpaceId)) return [];
        if (
          input.form && mapped.form !== input.form ||
          input.kind && mapped.kind !== input.kind ||
          input.status && mapped.status !== input.status
        ) return [];
        if (
          input.includeHistory !== true &&
          (!isEditoriallyVisible(mapped) || terminalStatus(mapped.status))
        ) {
          return [];
        }
        return [{
          ...mapped,
          similarity: query ? lexicalScore(query, mapped.summary) : 1,
          provenance: item.provenance,
          temporal: item.temporal,
          validity: item.validity,
        }];
      }).sort((left, right) => right.similarity - left.similarity).slice(
        0,
        Math.min(positiveInteger(input.limit, 20), 100),
      );
      return { memories: selected, total: selected.length };
    },
  };
}

export function inspectMemoryAction(): Pick<
  ActionDefinition<unknown, unknown, MemoryActionContext, ActionSchema>,
  "inputSchema" | "execute"
> {
  return {
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: { id: { type: "string" } },
      additionalProperties: false,
    },
    async execute(raw, context) {
      const id = requiredText(record(raw).id, "Memory id");
      const item = await context.collections.memoryRecord
        .get({ id });
      if (!item) throw new Error(`Memory '${id}' was not found.`);
      const spaces = new Set(
        (await threadMemorySpaces(
          context,
          memoryActionProvenance(context).threadId,
        )).map((
          space,
        ) => space.id),
      );
      if (!spaces.has(String(item.memorySpaceId))) {
        throw new Error(`Memory '${id}' is not accessible from this thread.`);
      }
      const relations = await context.collections.memoryRecord.relations
        .list({
          id,
          direction: "both",
          limit: 1_000,
        });
      const accessibleMemoryIds = new Set(
        (await context.collections.memoryRecord.list({
          limit: 1_000,
        })).filter((candidate) => spaces.has(String(candidate.memorySpaceId)))
          .map((candidate) => candidate.id),
      );
      const visibleRelations = relations.filter((relation) =>
        (relation.source.type !== memoryRecordCollection.name ||
          accessibleMemoryIds.has(relation.source.id)) &&
        (relation.target.type !== memoryRecordCollection.name ||
          accessibleMemoryIds.has(relation.target.id))
      );
      return { memory: item, relations: visibleRelations };
    },
  };
}

const invalidateMemoryInputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "disposition", "reason"],
  properties: {
    id: { type: "string", minLength: 1 },
    disposition: { enum: ["retracted", "superseded", "archived"] },
    reason: { type: "string", minLength: 1 },
    replacementMemoryId: { type: "string", minLength: 1 },
    sources: { type: "array", items: { type: "object" }, maxItems: 20 },
  },
} as const;

const invalidateMemoryOutputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["memory"],
  properties: {
    memory: {
      type: "object",
      additionalProperties: false,
      required: ["id", "status", "previousValidity", "validity"],
      properties: {
        id: { type: "string" },
        status: { type: "string" },
        previousValidity: { type: "object" },
        validity: { type: "object" },
        replacementMemoryId: { type: "string" },
      },
    },
  },
} as const;

function invalidationSources(
  value: unknown,
  triggerMessageId: string,
): readonly ContextSourceRef[] {
  const defaultSource: ContextSourceRef = Object.freeze({
    type: "message",
    id: triggerMessageId,
  });
  if (value === undefined) return Object.freeze([defaultSource]);
  if (!Array.isArray(value) || !value.length) {
    throw new TypeError("Invalidation sources must be a non-empty array.");
  }
  const sources = value.map((raw) => {
    const source = record(raw);
    if (source.type !== "message" || source.id !== triggerMessageId) {
      throw new TypeError(
        "Invalidation sources may only cite the trusted triggering message.",
      );
    }
    return defaultSource;
  });
  return Object.freeze(
    sources.filter((source, index) =>
      sources.findIndex((candidate) =>
        memorySourceKey(candidate) === memorySourceKey(source)
      ) === index
    ),
  );
}

export function invalidateMemoryAction():
  & Pick<
    ActionDefinition<unknown, unknown, MemoryActionContext, ActionSchema>,
    "inputSchema" | "execute"
  >
  & Readonly<{ outputSchema: typeof invalidateMemoryOutputSchema }> {
  return {
    inputSchema: invalidateMemoryInputSchema,
    outputSchema: invalidateMemoryOutputSchema,
    async execute(raw, context) {
      const input = record(raw);
      const id = requiredText(input.id, "Memory id");
      const disposition = requiredText(input.disposition, "Memory disposition");
      if (
        disposition !== "retracted" && disposition !== "superseded" &&
        disposition !== "archived"
      ) {
        throw new TypeError("Memory disposition is invalid.");
      }
      const reason = requiredText(input.reason, "Memory invalidation reason");
      const provenance = coreToolActionMetadata(context.action.metadata);
      if (!provenance) {
        throw new Error(
          "invalidate_memory requires trusted Core Tool provenance.",
        );
      }
      const sources = invalidationSources(
        input.sources,
        provenance.triggerMessageId,
      );
      const writable = new Set(
        (await threadMemorySpaces(context, provenance.threadId)).filter((
          space,
        ) => space.access === "read_write").map((space) => space.id),
      );
      const item = await context.collections.memoryRecord.get({ id });
      const mapped = item ? memoryRecord(item) : null;
      if (!mapped) throw new Error(`Memory '${id}' was not found.`);
      if (!writable.has(mapped.memorySpaceId)) {
        throw new Error(`Memory '${id}' is not writable from this thread.`);
      }
      const replacementMemoryId = disposition === "superseded"
        ? requiredText(input.replacementMemoryId, "Replacement memory id")
        : undefined;
      if (replacementMemoryId === id) {
        throw new TypeError("A memory cannot supersede itself.");
      }
      if (replacementMemoryId) {
        const replacement = await context.collections.memoryRecord.get({
          id: replacementMemoryId,
        });
        const mappedReplacement = replacement
          ? memoryRecord(replacement)
          : null;
        if (
          !mappedReplacement || !writable.has(mappedReplacement.memorySpaceId)
        ) {
          throw new Error(
            `Replacement memory '${replacementMemoryId}' is not writable from this thread.`,
          );
        }
      } else if (input.replacementMemoryId !== undefined) {
        throw new TypeError(
          "replacementMemoryId is only valid for disposition 'superseded'.",
        );
      }
      const nextValidity = Object.freeze({
        status: disposition,
        changedAt: context.now().toISOString(),
        reason,
        sources,
        ...(replacementMemoryId ? { replacementMemoryId } : {}),
      });
      const previousValidity = record(item!.validity);
      const operationKey = `memory-invalidate:${id}:${disposition}:${
        replacementMemoryId ?? ""
      }`;
      await context.transaction(async (tx) => {
        await tx.collections.memoryRecord.commands.invalidate({
          id,
          validity: nextValidity,
        }, { operationKey });
        if (replacementMemoryId) {
          await tx.relations.upsert({
            id: `memory-relation:${
              encodeURIComponent(`${replacementMemoryId}:supersedes:${id}`)
            }`,
            type: "supersedes",
            source: {
              type: memoryRecordCollection.name,
              id: replacementMemoryId,
            },
            target: { type: memoryRecordCollection.name, id },
            metadata: { sources, reason },
          });
        }
      }, { operationKey });
      const saved = await context.collections.memoryRecord.get({ id });
      const validity = saved ? record(saved.validity) : nextValidity;
      return {
        memory: {
          id,
          status: mapped.status,
          previousValidity,
          validity,
          ...(replacementMemoryId ? { replacementMemoryId } : {}),
        },
      };
    },
  };
}

export { invalidateMemoryInputSchema, invalidateMemoryOutputSchema };

export function setMemoryStatusAction(): Pick<
  ActionDefinition<unknown, unknown, MemoryActionContext, ActionSchema>,
  "inputSchema" | "execute"
> {
  return {
    inputSchema: {
      type: "object",
      required: ["id", "status"],
      properties: { id: { type: "string" }, status: { type: "string" } },
      additionalProperties: false,
    },
    async execute(raw, context) {
      const input = record(raw);
      const id = requiredText(input.id, "Memory id");
      const status = requiredText(input.status, "Memory status");
      const item = await context.collections.memoryRecord
        .get({ id });
      const mapped = item ? memoryRecord(item) : null;
      if (!mapped) throw new Error(`Memory '${id}' was not found.`);
      const spaces = new Set(
        (await threadMemorySpaces(
          context,
          memoryActionProvenance(context).threadId,
        )).filter((
          space,
        ) => space.access === "read_write").map((space) => space.id),
      );
      if (!spaces.has(mapped.memorySpaceId)) {
        throw new Error(`Memory '${id}' is not writable from this thread.`);
      }
      if (!memoryLifecycleAllows(mapped.form, status)) {
        throw new TypeError(
          `Status '${status}' is invalid for '${mapped.form}'.`,
        );
      }
      await context.collections.memoryRecord.update({
        id,
        set: {
          status,
          temporal: {
            ...record(item!.temporal),
            invalidatedAt: terminalStatus(status)
              ? context.now().toISOString()
              : undefined,
          },
        },
      }, { operationKey: `memory-status:${id}:${status}` });
      return { id, status };
    },
  };
}

export function memoryReservationProcessor(
  config: LongTermMemoryConfig,
): Omit<Processor<MemoryProcessorContext>, "id"> {
  return {
    on: [{ eventType: "message.created" }],
    settlement: "detached",
    async handle(event, context) {
      if (event.visibility?.kind === "internal") return;
      if (!event.durable || !event.threadId || !event.subject) return;
      const messageRecord = await context.collections.message.get({
        id: event.subject.id,
      });
      if (!messageRecord) return;
      // Tool-call projections are intermediate Agent output. Consolidating
      // them would race the Tool result/final answer and could reserve an
      // incomplete turn, preventing the actual terminal output from being
      // selected while that checkpoint remains pending.
      if (coreToolPlanMetadata(messageRecord.metadata)) return;
      const sender = await loadParticipantRecord(
        context,
        String(messageRecord.senderId),
      );
      if (!sender || sender.participantType !== "agent") return;
      const message = Object.freeze({
        ...messageRecord,
        threadId: String(messageRecord.threadId),
        sender,
      });
      const agentId = participantAgentId(message.sender);
      if (!context.resources.agents[agentId]) return;
      if (
        (await checkpoints(context, message.threadId, agentId, "pending"))
          .length
      ) return;
      const spaces = await ensureWritableMemorySpace(context, message.threadId);
      const thread = await loadThreadRecord(context, message.threadId);
      const workflowInitiator = workflowMetadata(messageRecord.metadata)
        ?.initiatorParticipantId;
      const humanParticipants =
        thread?.participants.filter((participant) =>
          participant.participantType === "human"
        ) ?? [];
      const initiatorParticipantId = workflowInitiator ??
        (humanParticipants.length === 1 ? humanParticipants[0]?.id : undefined);
      if (!initiatorParticipantId) {
        throw new Error(
          "Memory maintenance requires trusted initiating human provenance.",
        );
      }
      const previous = await latestReadyCheckpoint(
        context,
        message.threadId,
        agentId,
        spaces,
      );
      const history = await listThreadMessageRecords(
        context,
        message.threadId,
      );
      const range = selectLongTermMemoryRange({
        messages: await sourceMessages(context, history),
        triggerMessageId: message.id,
        previousBoundaryMessageId: optionalText(previous?.sourceEndMessageId),
        triggerEstimatedTokens: config.triggerEstimatedTokens,
        retainRecentEstimatedTokens: config.retainRecentEstimatedTokens,
      });
      if (!range) return;
      const writable = spaces.filter((space) => space.access === "read_write");
      const defaultSpace = spaces.find((space) => space.defaultWrite);
      if (!defaultSpace || !writable.length) {
        throw new Error("Thread has no default writable memory space.");
      }
      const sequence = Math.max(
        checkpointSequence(previous),
        ...(await checkpoints(context, message.threadId, agentId)).map(
          checkpointSequence,
        ),
      ) + 1;
      const id = `memory:${message.threadId}:${agentId}:${sequence}`;
      try {
        await context.collections.longTermMemory.create({
          id,
          name: `Thread ${message.threadId} / ${agentId} / ${sequence}`,
          threadId: message.threadId,
          schemaVersion: "4",
          strategy: "semantic_graph",
          status: "pending",
          memorySpaceId: defaultSpace.id,
          readMemorySpaceIds: spaces.map((space) => space.id),
          writeMemorySpaceIds: writable.map((space) => space.id),
          defaultWriteMemorySpaceId: defaultSpace.id,
          sequence,
          agentId,
          sourceStartMessageId: range.sourceStartMessageId,
          sourceEndMessageId: range.sourceEndMessageId,
          content: [],
          contextSnapshotContent: [],
          contextSnapshot: null,
          embedding: null,
          contentHash: null,
          tokenEstimate: null,
          error: null,
          metadata: {
            agentParticipantId: message.sender.id,
            initiatorParticipantId,
            estimatedTokens: range.estimatedTokens,
            retainedEstimatedTokens: range.retainedEstimatedTokens,
            retainedMessageCount: range.retainedMessageCount,
          },
        }, { operationKey: `checkpoint:reserve:${id}` });
      } catch (error) {
        if (
          (await checkpoints(context, message.threadId, agentId, "pending"))
            .length
        ) return;
        throw error;
      }
    },
  };
}

const MEMORY_TASK_METADATA_KEY = "copilotzMemory";

function memoryTaskCheckpointId(value: unknown): string | undefined {
  return optionalText(
    record(record(value)[MEMORY_TASK_METADATA_KEY]).checkpointId,
  );
}

function memoryTaskMetadata(checkpointId: string, ownerParticipantId: string) {
  return withCoreAgentTurnMetadata({
    [MEMORY_TASK_METADATA_KEY]: { checkpointId },
  }, {
    schema: "copilotz.core.agent-turn.v1",
    id: checkpointId,
    ownerParticipantId,
    completeOn: { action: "consolidate_memory" },
  });
}

/**
 * Verifies both the Memory-owned root task and the current Core continuation.
 *
 * A repaired turn may be triggered by a projected Tool result rather than the
 * original task Message. The opaque turn id remains the stable ownership
 * cursor; the current Message must still be internal and in that exact scope.
 */
async function memoryTaskOwnsTurn(
  context: MemoryActionContext | MemoryProcessorContext,
  turn: NonNullable<ReturnType<typeof coreAgentTurnMetadata>>,
  currentTriggerMessageId: string,
): Promise<boolean> {
  const rootTaskId = await deriveWorkflowId(
    "message",
    "memory-agent-turn",
    turn.id,
  );
  const [rootTask, currentTrigger] = await Promise.all([
    context.collections.message.get({ id: rootTaskId }),
    context.collections.message.get({ id: currentTriggerMessageId }),
  ]);
  const rootTurn = rootTask ? coreAgentTurnMetadata(rootTask.metadata) : null;
  const currentTurn = currentTrigger
    ? coreAgentTurnMetadata(currentTrigger.metadata)
    : null;
  return Boolean(
    rootTask && currentTrigger &&
      record(rootTask.visibility).kind === "internal" &&
      rootTask.historyScopeId === turn.id &&
      memoryTaskCheckpointId(rootTask.metadata) === turn.id &&
      rootTurn?.id === turn.id &&
      rootTurn.ownerParticipantId === turn.ownerParticipantId &&
      record(currentTrigger.visibility).kind === "internal" &&
      currentTrigger.historyScopeId === turn.id &&
      currentTurn?.id === turn.id &&
      currentTurn.ownerParticipantId === turn.ownerParticipantId,
  );
}

/** Emits the Memory-owned task Message that Core routes as an ordinary Agent turn. */
export function dispatchMemoryConsolidationProcessor(): Omit<
  Processor<MemoryProcessorContext>,
  "id"
> {
  return {
    on: [{ eventType: "long_term_memory.created" }],
    settlement: "detached",
    async handle(event, context) {
      if (!event.durable || !event.subject) return;
      let checkpoint = await context.collections.longTermMemory
        .get({ id: event.subject.id });
      if (!checkpoint || checkpoint.status !== "pending") return;
      if (record(checkpoint.metadata).onDemand === true) return;
      const threadId = requiredText(checkpoint.threadId, "Memory thread id");
      const agentId = requiredText(checkpoint.agentId, "Memory agent id");
      const participantId = requiredText(
        record(checkpoint.metadata).agentParticipantId,
        "Memory participant id",
      );
      const participant = await loadParticipantRecord(context, participantId);
      const thread = await loadThreadRecord(context, threadId);
      if (!participant || participant.participantType !== "agent" || !thread) {
        throw new Error(
          "Memory checkpoint participant or thread is unavailable.",
        );
      }
      const messages = rangeMessages(
        await listThreadMessageRecords(context, threadId),
        checkpoint,
      );
      await captureContextSnapshot(context, {
        checkpoint,
        agent: context.resources.agents[agentId]!,
        participant,
        thread,
        rangeMessages: messages,
      });
      checkpoint = await context.collections.longTermMemory.get({
        id: checkpoint.id,
      }) ?? checkpoint;
      const spaces = activeSpacesForCheckpoint(
        checkpoint,
        await threadMemorySpaces(context, threadId),
      );
      const previous = (await activeMemoryRecords(
        context,
        spaces,
        agentId,
      )).filter((item) =>
        isEditoriallyVisible(item) && !terminalStatus(item.status)
      ).slice(0, 100);
      const instruction = buildMemoryConsolidationInstruction({
        spaces,
        sourceMessages: await sourceMessages(context, messages),
        kinds: memoryKinds(context),
        previousRecords: previous,
        context: frozenSnapshot(checkpoint),
      });
      const initiatorParticipantId = requiredText(
        record(checkpoint.metadata).initiatorParticipantId,
        "Memory initiating human participant id",
      );
      const initiator = await loadParticipantRecord(
        context,
        initiatorParticipantId,
      );
      if (!initiator || initiator.participantType !== "human") {
        throw new Error("Memory initiating human participant is unavailable.");
      }
      const id = await deriveWorkflowId(
        "message",
        "memory-agent-turn",
        checkpoint.id,
      );
      await createThreadMessage({
        id,
        threadId,
        sender: initiator,
        recipientIds: [participant.id],
        visibility: { kind: "internal" },
        historyScopeId: checkpoint.id,
        content: [
          { type: "text", role: "memory.task", text: instruction },
          ...frozenSnapshot(checkpoint).flatMap((item) => item.content),
        ],
        metadata: memoryTaskMetadata(checkpoint.id, participant.id),
      }, context);
    },
  };
}

/** Settles only Memory-owned scoped Agent turns; Core remains semantic-neutral. */
export function settleMemoryConsolidationProcessor(): Omit<
  Processor<MemoryProcessorContext>,
  "id"
> {
  return {
    on: [
      { eventType: "llm.call.completed" },
      { eventType: "llm.call.failed" },
      { eventType: "llm.call.cancelled" },
    ],
    settlement: "detached",
    async handle(event, context) {
      const lifecycle = parseActionLifecycleEvent(event, {
        actionId: "llm.call",
        statuses: ["completed", "failed", "cancelled"],
        requireRoot: true,
      });
      if (!lifecycle) return;
      const metadata = coreLlmCallMetadata(lifecycle.metadata);
      const turn = metadata?.agentTurn;
      if (
        !metadata || !turn?.completeOn ||
        turn.completeOn.action !== "consolidate_memory" ||
        metadata.agentParticipantId !== turn.ownerParticipantId
      ) return;
      const checkpoint = await context.collections.longTermMemory.get({
        id: turn.id,
      });
      if (!checkpoint || checkpoint.status !== "pending") return;
      if (
        !await memoryTaskOwnsTurn(
          context,
          turn,
          metadata.triggerMessageId,
        )
      ) return;
      if (lifecycle.status === "failed" || lifecycle.status === "cancelled") {
        await settleCheckpointError(
          context,
          checkpoint.id,
          lifecycle.status === "cancelled" ? "cancelled" : "failed",
          lifecycle.error,
        );
        return;
      }
      const output = lifecycle.status === "completed"
        ? record((lifecycle as Readonly<{ output?: unknown }>).output)
        : {};
      if (Array.isArray(output.toolCalls) && output.toolCalls.length) return;
      const attempts = Number(
        record(checkpoint.metadata).omittedToolAttempts ?? 0,
      );
      if (attempts >= 1) {
        await settleCheckpointError(
          context,
          checkpoint.id,
          "failed",
          new Error(
            "The Memory Agent turn ended twice without consolidate_memory.",
          ),
        );
        return;
      }
      await context.collections.longTermMemory.update({
        id: checkpoint.id,
        set: {
          metadata: {
            ...record(checkpoint.metadata),
            omittedToolAttempts: attempts + 1,
          },
        },
      }, { operationKey: `memory:${checkpoint.id}:repair-count` });
      const repairId = await deriveWorkflowId(
        "message",
        "memory-agent-turn",
        checkpoint.id,
        "repair",
      );
      const sender = await loadParticipantRecord(
        context,
        metadata.initiatorParticipantId,
      );
      if (!sender || sender.participantType !== "human") {
        throw new Error("Memory repair initiator is unavailable.");
      }
      await createThreadMessage({
        id: repairId,
        threadId: metadata.threadId,
        sender,
        recipientIds: [turn.ownerParticipantId],
        visibility: { kind: "internal" },
        historyScopeId: turn.id,
        content: {
          type: "text",
          role: "memory.repair",
          text:
            "This internal task is unfinished. Call consolidate_memory now; do not answer the user.",
        },
        metadata: memoryTaskMetadata(checkpoint.id, turn.ownerParticipantId),
      }, context);
    },
  };
}

export function createMemoryContextResource(
  enabled: boolean,
): ContextResource & Readonly<{ historyAfterMessageId?: string }> {
  return Object.freeze({
    id: MEMORY_RESOURCE_ID,
    type: "context",
    purposes: Object.freeze(["conversation"] as const),
    async contribute(input) {
      if (!enabled) return null;
      // Context resources intentionally receive capabilities, not the processor object.
      const checkpointCollection = input.collections.longTermMemory;
      const accessCollection = input.collections.memorySpaceAccess;
      if (!checkpointCollection || !accessCollection) return null;
      const grants = await accessCollection.list({
        where: { threadId: input.thread.id },
        limit: 1_000,
      });
      const readable = new Set(
        grants.map((grant) => String(grant.memorySpaceId)),
      );
      const values = await checkpointCollection.list({
        where: {
          threadId: input.thread.id,
          agentId: input.agent.id,
          status: "ready",
        },
        limit: 1_000,
      });
      const checkpoint = values.filter((item) =>
        item.status === "ready" && (Array.isArray(item.readMemorySpaceIds)
          ? item.readMemorySpaceIds.every((id) =>
            readable.has(String(id))
          )
          : false)
      ).sort((a, b) => checkpointSequence(b) - checkpointSequence(a))[0];
      if (
        !checkpoint || !Array.isArray(checkpoint.content) ||
        !checkpoint.content.length
      ) return null;
      return Object.freeze({
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
        historyAfterMessageId: requiredText(
          checkpoint.sourceEndMessageId,
          "Memory history boundary",
        ),
      });
    },
  });
}
