/**
 * Shared semantic-memory mechanics used by the canonical primitive owners.
 *
 * @module
 */

import {
  agentInstructionBase,
  type AgentResource,
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
  isSettledActionError,
} from "@copilotz/copilotz/actions";
import { addFormats, Ajv } from "../../../dependencies/ajv.ts";
import {
  listThreadMessageRecords,
  loadParticipantRecord,
  loadThreadRecord,
} from "@copilotz/copilotz/core";
import type {
  LlmCallInput,
  LlmCallOutput,
  LlmJsonObject,
  LlmMessage,
  LlmRequest,
  LlmToolCall,
  LlmToolDefinition,
} from "@copilotz/copilotz/llm";
import { estimateTextTokens } from "@copilotz/copilotz/llm/tokens";
import {
  collectContextContributions,
  type ContextResource,
  type ContextSourceRef,
  type FrozenContextContribution,
} from "@copilotz/copilotz/core";
import type {
  Processor,
  ProcessorContext,
  ProcessorEvent,
} from "@copilotz/copilotz/plugins";
import type { ToolResource } from "@copilotz/copilotz/tools";
import {
  buildMemoryConsolidationInstruction,
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

const memoryLlmContractError = Symbol("copilotz.memory.llm-contract-error");

type MemoryLlmContractErrorCode =
  | "missing_tool_call"
  | "multiple_tool_calls"
  | "unauthorized_tool_call"
  | "invalid_tool_input";

class MemoryLlmContractError extends Error {
  readonly [memoryLlmContractError] = true;

  constructor(
    readonly code: MemoryLlmContractErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "MemoryLlmContractError";
  }
}

function isMemoryLlmContractError(
  error: unknown,
): error is MemoryLlmContractError {
  return error instanceof MemoryLlmContractError &&
    error[memoryLlmContractError] === true;
}

/** Model-facing proposal accepted directly by `consolidate_memory`. */
export type ConsolidateMemoryActionInput = unknown;

export type ConsolidateMemoryActionResult = Readonly<
  & {
    outcome: "already_settled" | "no_changes" | "changes";
  }
  & Record<string, unknown>
>;

export type MaintainMemoryActionInput = Readonly<{
  checkpointId: string;
  sourceEvent: ProcessorEvent;
}>;

export type MaintainMemoryActionResult = Readonly<{
  checkpointId: string;
  result: unknown;
  repairIndex?: number;
}>;

export type MemoryActionCallers = Readonly<{
  consolidate_memory(
    input: ConsolidateMemoryActionInput,
    options?: ActionCallOptions,
  ): Promise<ConsolidateMemoryActionResult>;
  maintainMemory(
    input: MaintainMemoryActionInput,
    options?: ActionCallOptions,
  ): Promise<MaintainMemoryActionResult>;
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
  callLlm(
    input: LlmCallInput,
    options?: ActionCallOptions,
  ): Promise<LlmCallOutput>;
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

type MemoryModelSelection = readonly [string, ...string[]];

export function modelSelection(
  value: unknown,
  label: string,
): MemoryModelSelection | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty array of aliases.`);
  }
  const models = value.map((entry, index) =>
    requiredText(entry, `${label} at index ${index}`)
  );
  if (new Set(models).size !== models.length) {
    throw new TypeError(`${label} must not contain duplicate aliases.`);
  }
  return Object.freeze(models) as unknown as MemoryModelSelection;
}

function optionalText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function positiveInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}

export function nonNegativeInteger(value: unknown, fallback: number): number {
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
  return form && MEMORY_FORMS.includes(form) && memorySpaceId && kind &&
      summary && status
    ? Object.freeze({
      id: value.id,
      memorySpaceId,
      form,
      kind,
      summary,
      status,
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
    purpose: "memory_consolidation",
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

function memoryCheckpointId(value: unknown): string {
  return requiredText(record(value).memoryCheckpointId, "Memory checkpoint id");
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

async function materializeMemoryText(
  context: MemoryActionContext,
  text: string,
  operationKey: string,
) {
  const prepared = await context.content.prepare(
    { type: "text", text, role: "memory.prompt" },
    { operationKey },
  );
  return await context.content.materialize(prepared);
}

function memoryToolDefinition(tool: ToolResource): LlmToolDefinition {
  const inputSchema = tool.inputSchema
    ? structuredClone(tool.inputSchema) as LlmJsonObject
    : undefined;
  return Object.freeze({
    name: requiredText(tool.action, "Memory consolidation Tool Action alias"),
    description: requiredText(
      tool.description,
      "Memory consolidation Tool description",
    ),
    ...(inputSchema ? { inputSchema } : {}),
  });
}

function memoryConsolidationToolCall(
  output: LlmCallOutput,
  tool: ToolResource,
): LlmToolCall {
  const calls = output.toolCalls ?? [];
  if (calls.length === 0) {
    throw new MemoryLlmContractError(
      "missing_tool_call",
      "The model did not call consolidate_memory. Call it exactly once and emit no answer.",
    );
  }
  if (calls.length !== 1) {
    throw new MemoryLlmContractError(
      "multiple_tool_calls",
      "The model produced multiple tool calls. Call consolidate_memory exactly once.",
    );
  }
  const call = calls[0];
  if (call.action !== tool.action) {
    throw new MemoryLlmContractError(
      "unauthorized_tool_call",
      `The model called unauthorized tool '${call.action}'. Call consolidate_memory exactly once.`,
    );
  }
  return call;
}

function memoryHistoryMessage(message: ConversationMessage): LlmMessage {
  const role = message.sender.participantType === "human"
    ? "user" as const
    : "assistant" as const;
  return Object.freeze({
    role,
    content: Object.freeze([...message.content]),
    metadata: Object.freeze({
      messageId: message.id,
      senderId: message.sender.externalId,
      senderType: message.sender.participantType,
    }),
  });
}

async function buildMemoryLlmRequest(
  context: MemoryActionContext,
  input: Readonly<{
    agent: AgentResource;
    checkpointId: string;
    repairIndex: number;
    instruction: string;
    messages: readonly ConversationMessage[];
    snapshot: readonly FrozenContextContribution[];
    tool: ToolResource;
  }>,
): Promise<LlmRequest> {
  const identity = [
    `You are ${input.agent.name}.`,
    `Role: ${input.agent.role}.`,
    input.agent.description,
    input.agent.personality,
    agentInstructionBase(input.agent.instructions),
    input.instruction,
  ].filter((value): value is string => Boolean(value?.trim())).join("\n\n");
  const systemContent = await materializeMemoryText(
    context,
    identity,
    `memory:${input.checkpointId}:prompt:${input.repairIndex}:system`,
  );
  const contextMessages = await Promise.all(
    input.snapshot.map(async (item, index): Promise<LlmMessage> => {
      const heading = await materializeMemoryText(
        context,
        `## Frozen context: ${item.title}`,
        `memory:${input.checkpointId}:prompt:${input.repairIndex}:context:${index}`,
      );
      return Object.freeze({
        role: "system" as const,
        content: Object.freeze([...heading, ...item.content]),
        metadata: Object.freeze({
          contextId: item.id,
          resourceId: item.resourceId,
          capturedAt: item.capturedAt,
        }),
      });
    }),
  );
  return Object.freeze({
    messages: Object.freeze([
      Object.freeze({ role: "system" as const, content: systemContent }),
      ...contextMessages,
      ...input.messages.map(memoryHistoryMessage),
    ]),
    tools: Object.freeze([memoryToolDefinition(input.tool)]),
  });
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

function consolidationInputSchema(): ActionSchema {
  const source = {
    type: "object",
    required: ["type", "id"],
    properties: {
      type: {
        enum: [
          "message",
          "asset",
          "external",
          "collection_record",
        ],
      },
      id: { type: "string" },
      collection: { type: "string" },
      version: { type: ["string", "number"] },
      updatedAt: { type: "string" },
      fragment: { type: "string" },
    },
  };
  const base = {
    type: "object",
    required: ["localId", "kind", "summary", "sources"],
    properties: {
      localId: { type: "string" },
      kind: { type: "string" },
      summary: { type: "string" },
      spaceId: { type: "string" },
      attributes: { type: "object" },
      sources: { type: "array", minItems: 1, items: source },
    },
    additionalProperties: true,
  };
  return {
    type: "object",
    required: ["outcome"],
    properties: {
      outcome: { enum: ["changes", "no_changes"] },
      entities: { type: "array", items: base },
      assertions: { type: "array", items: base },
      occurrences: { type: "array", items: base },
      intents: { type: "array", items: base },
      inquiries: { type: "array", items: base },
      procedures: { type: "array", items: base },
      relations: { type: "array", items: { type: "object" } },
      lifecycle: { type: "array", items: { type: "object" } },
    },
    additionalProperties: false,
  } as unknown as ActionSchema;
}

export function createConsolidateMemoryAction(
  config: LongTermMemoryConfig,
): Pick<
  ActionDefinition<
    ConsolidateMemoryActionInput,
    ConsolidateMemoryActionResult,
    MemoryActionContext,
    ActionSchema
  >,
  "inputSchema" | "execute"
> {
  return {
    inputSchema: consolidationInputSchema(),
    async execute(
      proposal: ConsolidateMemoryActionInput,
      context: MemoryActionContext,
    ): Promise<ConsolidateMemoryActionResult> {
      const checkpointId = memoryCheckpointId(context.action.metadata);
      const raw = proposal;
      const embed = context.adapters.memoryEmbedding.default;
      const checkpoint = await context.collections.longTermMemory.get({
        id: checkpointId,
      });
      if (!checkpoint) {
        throw new Error(`Memory checkpoint '${checkpointId}' was not found.`);
      }
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
      const currentRelations = await recordRelations(context, currentRecordIds);
      const visible = currentRecords.filter((item) =>
        !terminalStatus(item.status)
      );
      const parsed = parseConsolidateMemoryInput(raw, {
        kinds: new Map(kindDefinitions.map((kind) => [kind.id, kind])),
        writableMemorySpaceIds: new Set(
          spaces.filter((space) => space.access === "read_write").map((space) =>
            space.id
          ),
        ),
        defaultWriteMemorySpaceId: spaces.find((space) =>
          space.defaultWrite
        )!.id,
        allowedEvidenceSources: catalog.keys,
        visibleMemoryIds: new Set(visible.map((item) => item.id)),
        visibleNodeIds: catalog.nodes,
      });
      if (parsed.outcome === "no_changes") {
        const result = Object.freeze({
          outcome: "no_changes",
          created: 0,
          reused: 0,
          lifecycleChanged: 0,
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
            stableJson(candidate.record.data.object) === stableJson(data.object)
          ) continue;
          const sourceId = persisted.get(draft.localId)!;
          const id = `memory-relation:${
            encodeURIComponent(`${sourceId}:contradicts:${candidate.record.id}`)
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
      const result = Object.freeze({
        outcome: "changes",
        created,
        reused,
        lifecycleChanged,
        unresolved: unresolved.length,
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
    },
  };
}

export function createMemoryMaintenanceAction(
  models: MemoryModelSelection | undefined,
  consolidateTool: ToolResource<"consolidate_memory">,
  maxRepairAttempts: number,
): Pick<
  ActionDefinition<
    MaintainMemoryActionInput,
    MaintainMemoryActionResult,
    MemoryActionContext
  >,
  "inputSchema" | "execute"
> {
  return {
    async execute(
      input: MaintainMemoryActionInput,
      actionContext: MemoryActionContext,
    ): Promise<MaintainMemoryActionResult> {
      const checkpointId = requiredText(
        input.checkpointId,
        "Memory checkpoint id",
      );
      const llmModels = models;
      if (!llmModels) {
        throw new TypeError(
          "Memory LLM models must be a non-empty array of aliases.",
        );
      }
      const context = actionContext;
      const sourceEvent = input.sourceEvent;
      let repairReason: string | undefined;
      let lastContractError: MemoryLlmContractError | undefined;

      for (
        let repairIndex = 0;
        repairIndex <= maxRepairAttempts;
        repairIndex++
      ) {
        const checkpoint = await context.collections.longTermMemory.get({
          id: checkpointId,
        });
        if (!checkpoint || checkpoint.status !== "pending") {
          if (checkpoint?.status === "ready") {
            return Object.freeze({
              checkpointId,
              result: record(checkpoint.metadata).result ?? null,
            });
          }
          throw new Error(
            `Memory checkpoint '${checkpointId}' is not pending.`,
          );
        }
        const threadId = requiredText(
          checkpoint.threadId,
          "Memory thread id",
        );
        const agentId = requiredText(
          checkpoint.agentId,
          "Memory agent id",
        );
        const participantId = requiredText(
          record(checkpoint.metadata).agentParticipantId,
          "Memory participant id",
        );
        const agent = context.resources.agents[agentId];
        if (!agent) throw new Error(`Agent '${agentId}' was not found.`);
        const participant = await loadParticipantRecord(
          context,
          participantId,
        );
        const thread = await loadThreadRecord(context, threadId);
        if (
          !participant || participant.participantType !== "agent" ||
          !thread
        ) {
          throw new Error(
            "Memory checkpoint participant or thread is unavailable.",
          );
        }
        const messages = rangeMessages(
          await listThreadMessageRecords(context, threadId),
          checkpoint,
        );
        const sources = await sourceMessages(context, messages);
        const spaces = activeSpacesForCheckpoint(
          checkpoint,
          await threadMemorySpaces(context, threadId),
        );
        const previous = (
          await activeMemoryRecords(context, spaces, agent.id)
        ).filter((item) => !terminalStatus(item.status)).slice(0, 100);
        const snapshot = frozenSnapshot(checkpoint);
        const instruction = buildMemoryConsolidationInstruction({
          spaces,
          sourceMessages: sources,
          kinds: memoryKinds(context),
          previousRecords: previous,
          context: snapshot,
          repair: repairReason,
        });
        const request = await buildMemoryLlmRequest(context, {
          agent,
          checkpointId,
          repairIndex,
          instruction,
          messages,
          snapshot,
          tool: consolidateTool,
        });
        const llmInput: LlmCallInput = Object.freeze({
          models: llmModels,
          mode: "generate",
          request,
        });
        const response = await context.actions.callLlm(llmInput, {
          operationKey: `memory:${checkpointId}:llm:${repairIndex}`,
          metadata: {
            schema: "copilotz.memory.llm-call.v1",
            checkpointId,
            repairIndex,
            threadId,
            agentId,
            ...(sourceEvent.durable ? { sourceEventId: sourceEvent.id } : {}),
          },
          signal: actionContext.signal,
        });
        let call: LlmToolCall;
        try {
          call = memoryConsolidationToolCall(response, consolidateTool);
        } catch (error) {
          if (!isMemoryLlmContractError(error)) throw error;
          lastContractError = error;
          repairReason = error.message;
          continue;
        }
        let result: ConsolidateMemoryActionResult;
        try {
          result = await context.actions.consolidate_memory(
            structuredClone(call.input),
            {
              operationKey:
                `memory:${checkpointId}:consolidate:${repairIndex}:${call.id}`,
              metadata: {
                memoryCheckpointId: checkpointId,
              },
              signal: actionContext.signal,
            },
          );
        } catch (error) {
          if (
            isSettledActionError(error) && error instanceof TypeError &&
            error.message.includes("input failed schema validation")
          ) {
            lastContractError = new MemoryLlmContractError(
              "invalid_tool_input",
              `The consolidate_memory input is invalid: ${error.message}`,
            );
            repairReason = lastContractError.message;
            continue;
          }
          throw error;
        }
        return Object.freeze({
          checkpointId,
          repairIndex,
          result: structuredClone(result),
        });
      }

      throw lastContractError ?? new Error(
        "Memory consolidation did not produce a valid result.",
      );
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
        if (input.includeHistory !== true && terminalStatus(mapped.status)) {
          return [];
        }
        return [{
          ...mapped,
          similarity: query ? lexicalScore(query, mapped.summary) : 1,
          provenance: item.provenance,
          temporal: item.temporal,
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

export function prepareMemoryMaintenanceProcessor(): Omit<
  Processor<MemoryProcessorContext>,
  "id"
> {
  return {
    on: [{ eventType: "long_term_memory.created" }],
    async handle(event, context) {
      if (!event.durable || !event.subject) return;
      let checkpoint = await context.collections.longTermMemory
        .get({ id: event.subject.id });
      if (!checkpoint || checkpoint.status !== "pending") return;
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
      try {
        await context.actions.maintainMemory({
          checkpointId: checkpoint.id,
          sourceEvent: event,
        }, {
          operationKey: `memory:${checkpoint.id}:run`,
          signal: context.signal,
        });
      } catch (error) {
        if (!isSettledActionError(error)) throw error;
        await settleCheckpointError(
          context,
          checkpoint.id,
          error instanceof Error && error.name === "AbortError"
            ? "cancelled"
            : "failed",
          error,
        );
      }
    },
  };
}

export function createMemoryContextResource(
  enabled: boolean,
): ContextResource & Readonly<{ historyAfterMessageId?: string }> {
  return Object.freeze({
    id: MEMORY_RESOURCE_ID,
    type: "context",
    purposes: Object.freeze(["conversation", "memory_consolidation"] as const),
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
