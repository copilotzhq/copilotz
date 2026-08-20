import type { Agent } from "../resources/index.ts";
import type {
  ContentRef,
  PreparedAsset,
  PreparedContent,
} from "../content/index.ts";
import type { CollectionRecord } from "../domain/index.ts";
import type {
  ConversationMessage,
  ConversationThread,
  Participant,
  SafeWorkflowError,
} from "../domain/index.ts";
import { llmAttemptContent, toolExecutionContent } from "../content/index.ts";
import type { CopilotzProcessorContext } from "../engine/index.ts";
import {
  listThreadMessageRecords,
  loadParticipantRecord,
  loadThreadRecord,
  mapLlmAttemptRecord,
} from "../engine/collection-graph.ts";
import {
  generateChainFromResources,
  runGenerateChain,
} from "../llm/generate-chain.ts";
import type {
  ChatResponse,
  ProviderConfig,
  ToolInvocation,
} from "../llm/types.ts";
import { estimateTextTokens } from "../tokens/index.ts";
import {
  collectContextContributions,
  type CollectedContextContribution,
  type ContextResource,
  type FrozenContextContribution,
} from "../context/index.ts";
import {
  type CopilotzPlugin,
  definePlugin,
  defineProcessor,
  type Processor,
} from "../plugins/index.ts";
import { buildAgentTextPrompt } from "../agents/index.ts";
import { recordProviderAttemptLifecycle } from "../llm/attempt-lifecycle.ts";
import {
  withWorkflowMetadata,
  workflowMetadata,
} from "../events/workflow-metadata.ts";
import type {
  WorkflowTool,
  WorkflowToolExecutionContext,
} from "../tools/types.ts";
import {
  agentTextBaseConfig,
  staticAgentTextConfig,
} from "../agents/config.ts";
import { validateToolCall } from "../tools/validation.ts";
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
} from "./consolidation.ts";
import {
  longTermMemoryCollection,
  memoryRecordCollection,
  memorySpaceAccessCollection,
  memorySpaceCollection,
} from "./collections.ts";
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
  type MemorySourceRef,
  type ProposedMemoryRef,
} from "./ontology.ts";
import type { CreateLongTermMemoryPluginOptions } from "./types.ts";
import type { MemoryRecordWrite, MemoryRelationWrite } from "./repository.ts";
import {
  DEFAULT_LONG_TERM_MEMORY_CONFIG,
  type LongTermMemoryConfig,
} from "./resources.ts";

const DEFAULT_PLUGIN_ID = "@copilotz/core-long-term-memory";
const DEFAULT_PLUGIN_VERSION = "4.0.0";
const MEMORY_RESOURCE_ID = "copilotz.long_term";
const CONSOLIDATE_MEMORY_TOOL_ID = "consolidate_memory";
const LIST_MEMORY_SPACES_TOOL_ID = "list_knowledge_spaces";
const SEARCH_MEMORY_TOOL_ID = "search_memory";
const INSPECT_MEMORY_TOOL_ID = "inspect_memory";
const SET_MEMORY_STATUS_TOOL_ID = "set_memory_status";

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

function normalizedConfig(
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

function collection(context: CopilotzProcessorContext, name: string) {
  const value = context.collections[name];
  if (!value) {
    throw new Error(`Long-term memory requires collection '${name}'.`);
  }
  return value;
}

function checkpointSequence(value: CollectionRecord | null): number {
  const sequence = Number(value?.sequence);
  return Number.isSafeInteger(sequence) && sequence > 0 ? sequence : 0;
}

function participantAgentId(participant: Participant): string {
  return participant.agentId ?? participant.externalId;
}

async function checkpoints(
  context: CopilotzProcessorContext,
  threadId: string,
  agentId: string,
  status?: "pending" | "ready" | "failed",
) {
  const values = await collection(context, longTermMemoryCollection.name).list({
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
  context: CopilotzProcessorContext,
  threadId: string,
): Promise<readonly MemorySpaceDescriptor[]> {
  const grants = await collection(context, memorySpaceAccessCollection.name)
    .list({ where: { threadId }, limit: 1_000 });
  const spaces: MemorySpaceDescriptor[] = [];
  for (const grant of grants) {
    const memorySpaceId = optionalText(grant.memorySpaceId);
    if (!memorySpaceId) continue;
    const space = await collection(context, memorySpaceCollection.name).get({
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
  context: CopilotzProcessorContext,
  threadId: string,
) {
  const current = await threadMemorySpaces(context, threadId);
  if (current.some((space) => space.access === "read_write")) return current;
  const memorySpaceId = `memory-space:thread:${threadId}`;
  await collection(context, memorySpaceCollection.name).create({
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
  await collection(context, memorySpaceAccessCollection.name).create({
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
  context: CopilotzProcessorContext,
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
  context: CopilotzProcessorContext,
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
  context: CopilotzProcessorContext,
  messages: readonly ConversationMessage[],
): Promise<readonly MemorySourceMessage[]> {
  const result: MemorySourceMessage[] = [];
  for (const message of messages) {
    const workflow = workflowMetadata(message.metadata);
    let toolCalls: unknown;
    let reasoning: string | undefined;
    if (workflow?.llmAttemptId) {
      const attempt = await context.collections.llm_attempt.get({
        id: workflow.llmAttemptId,
      });
      if (attempt) {
        const content = llmAttemptContent(attempt);
        if (content.toolCalls) {
          const resolved = await context.content.resolve(content.toolCalls);
          toolCalls = resolved.value ?? resolved.text;
        }
        if (content.reasoning) {
          const resolved = await context.content.resolve(content.reasoning);
          reasoning = resolved.text ?? new TextDecoder().decode(resolved.bytes);
        }
      }
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
  context: CopilotzProcessorContext,
  spaces: readonly MemorySpaceDescriptor[],
  agentId: string,
) {
  const readable = new Set(spaces.map((space) => space.id));
  const values = await collection(context, memoryRecordCollection.name).list({
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
  context: CopilotzProcessorContext,
  input: Readonly<{
    query: string;
    form: MemoryForm;
    kind: string;
    spaces: readonly MemorySpaceDescriptor[];
    agent: Agent;
    threadId: string;
    checkpointId: string;
    limit: number;
    embed?: CreateLongTermMemoryPluginOptions["embed"];
  }>,
) {
  const thread = await loadThreadRecord(context, input.threadId);
  if (!thread) {
    throw new Error(`Memory thread '${input.threadId}' was not found.`);
  }
  const readable = new Set(input.spaces.map((space) => space.id));
  const candidates =
    (await collection(context, memoryRecordCollection.name).list({
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
        ? { source: structuredClone(input.source) as MemorySourceRef }
        : {}),
      capturedAt: requiredText(input.capturedAt, "Frozen context capture time"),
      ...(optionalText(input.historyAfterMessageId)
        ? { historyAfterMessageId: optionalText(input.historyAfterMessageId) }
        : {}),
    })];
  }));
}

async function captureContextSnapshot(
  context: CopilotzProcessorContext,
  input: Readonly<{
    checkpoint: CollectionRecord;
    agent: Agent;
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
  await collection(context, longTermMemoryCollection.name).update(
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

function memoryKinds(context: CopilotzProcessorContext) {
  return Object.freeze(
    context.resources.list<MemoryKindDefinition>("memoryKinds").map(
      defineMemoryKind,
    ),
  );
}

function workflowToolContext(value?: WorkflowToolExecutionContext) {
  if (!value?.processor) {
    throw new Error("This tool requires an event-native Copilotz context.");
  }
  return value;
}

function memoryCheckpointId(value: unknown): string {
  return requiredText(record(value).memoryCheckpointId, "Memory checkpoint id");
}

function parseToolArgs(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

async function toolCallsFromAttempt(
  context: CopilotzProcessorContext,
  attempt: CollectionRecord,
) {
  const ref = llmAttemptContent(attempt).toolCalls;
  if (!ref) return Object.freeze([] as ToolInvocation[]);
  const resolved = await context.content.resolve(ref);
  const value = resolved.value ??
    (resolved.text ? parseToolArgs(resolved.text) : undefined);
  return Object.freeze(Array.isArray(value) ? value as ToolInvocation[] : []);
}

function safeError(
  code: string,
  message: string,
  retryable = false,
): SafeWorkflowError {
  return Object.freeze({
    name: "MemoryConsolidationError",
    code,
    message,
    retryable,
  });
}

async function failCheckpoint(
  context: CopilotzProcessorContext,
  checkpointId: string,
  error: unknown,
) {
  const checkpoint = await collection(context, longTermMemoryCollection.name)
    .get({ id: checkpointId });
  if (!checkpoint || checkpoint.status !== "pending") return;
  await collection(context, longTermMemoryCollection.name).update(
    {
      id: checkpointId,
      set: {
        status: "failed",
        error: {
          name: error instanceof Error ? error.name : "Error",
          message: error instanceof Error ? error.message : String(error),
        },
      },
    },
    { operationKey: `checkpoint:${checkpointId}:failed` },
  );
}

async function repairOrFail(
  context: CopilotzProcessorContext,
  input: Readonly<{
    checkpointId: string;
    attemptId: string;
    reason: string;
    maxRepairAttempts: number;
  }>,
) {
  const attempt = await context.collections.llm_attempt.get({
    id: input.attemptId,
  });
  const repairIndex = Number(record(attempt?.metadata).memoryRepairIndex ?? 0);
  if (!attempt || repairIndex >= input.maxRepairAttempts) {
    await failCheckpoint(context, input.checkpointId, new Error(input.reason));
    return;
  }
  const nextIndex = repairIndex + 1;
  const metadata = withWorkflowMetadata({
    memoryCheckpointId: input.checkpointId,
    memoryRepairIndex: nextIndex,
    memoryRepairReason: input.reason,
  }, {
    kind: "memory_consolidation",
    agentParticipantId: optionalText(attempt.participantId),
  });
  await context.features.llmAttempt.create({
    id: `${input.checkpointId}:llm:${nextIndex}`,
    threadId: attempt.threadId,
    messageId: attempt.messageId,
    participantId: attempt.participantId,
    initiatorParticipantId: attempt.initiatorParticipantId,
    agentId: attempt.agentId,
    parentAttemptId: attempt.id,
    inputMessageIds: attempt.inputMessageIds,
    availableToolIds: [CONSOLIDATE_MEMORY_TOOL_ID],
    status: "running",
    metadata,
  }, {
    operationKey: `memory-attempt:${input.checkpointId}:${nextIndex}`,
    identity: { metadata },
  });
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
  const evidence: MemorySourceRef[] = [];
  const nodes = new Set<string>();
  for (const message of messages) {
    evidence.push({ type: "message", id: message.id });
    for (const ref of message.content) {
      evidence.push({ type: "asset", id: ref.assetId });
    }
    const workflow = workflowMetadata(message.metadata);
    if (workflow?.toolExecutionId) {
      evidence.push({ type: "tool_execution", id: workflow.toolExecutionId });
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
  sources: readonly MemorySourceRef[],
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
  context: CopilotzProcessorContext,
  ids: ReadonlySet<string>,
) {
  return Object.freeze(
    (await context.relations.list({
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
  context: CopilotzProcessorContext,
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
  context: CopilotzProcessorContext,
  input: Parameters<typeof prepareCheckpointSettlement>[1],
) {
  const settlement = await prepareCheckpointSettlement(context, input);
  await collection(context, longTermMemoryCollection.name).update(
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

function consolidationInputSchema() {
  const source = {
    type: "object",
    required: ["type", "id"],
    properties: {
      type: {
        enum: [
          "message",
          "tool_execution",
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
  } as const;
}

function consolidateMemoryTool(
  options: CreateLongTermMemoryPluginOptions,
  config: LongTermMemoryConfig,
): WorkflowTool {
  return Object.freeze({
    id: CONSOLIDATE_MEMORY_TOOL_ID,
    key: CONSOLIDATE_MEMORY_TOOL_ID,
    name: "Consolidate Memory",
    description:
      "Persist one internal, provenance-aware semantic memory consolidation. This tool is granted only during Copilotz memory maintenance.",
    inputSchema: consolidationInputSchema(),
    historyPolicy: { visibility: "requester_only" },
    async execute(raw: unknown, value?: WorkflowToolExecutionContext) {
      const toolContext = workflowToolContext(value);
      const context = toolContext.processor;
      const execution = toolContext.execution;
      const checkpointId = memoryCheckpointId(execution.metadata);
      const checkpoint = await collection(
        context,
        longTermMemoryCollection.name,
      ).get({ id: checkpointId });
      if (!checkpoint) {
        throw new Error(`Memory checkpoint '${checkpointId}' was not found.`);
      }
      if (checkpoint.status === "ready") {
        return record(checkpoint.metadata).result ??
          { outcome: "already_settled" };
      }
      if (checkpoint.status !== "pending") {
        throw new Error(`Memory checkpoint '${checkpointId}' is not pending.`);
      }
      const threadId = requiredText(checkpoint.threadId, "Memory thread id");
      const agentId = requiredText(checkpoint.agentId, "Memory agent id");
      const agent = context.resources.require<Agent>("agents", agentId);
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
            embed: options.embed,
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
          const validation = validateToolCall({
            name: draft.kind,
            arguments: data,
          }, { inputSchema: kindDefinition.schema });
          if (!validation.valid) {
            throw new TypeError(
              `Memory '${draft.localId}' does not satisfy kind '${draft.kind}': ${
                validation.error ?? "invalid kind data"
              }`,
            );
          }
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
            ? provenance.sources as MemorySourceRef[]
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
        if (options.embed) {
          const values = await options.embed([draft.summary], {
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
          content: null,
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
        const rawTarget = await collection(context, memoryRecordCollection.name)
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
      await context.memory.commit({
        threadId,
        checkpointId,
        records: recordWrites,
        relations: relationWrites,
        checkpointPatch: settlement.patch,
        checkpointContent: settlement.content,
      }, {
        operationKey: `memory:${checkpointId}:commit`,
      });
      return result;
    },
  }) as WorkflowTool;
}

function listSpacesTool(): WorkflowTool {
  return Object.freeze({
    id: LIST_MEMORY_SPACES_TOOL_ID,
    key: LIST_MEMORY_SPACES_TOOL_ID,
    name: "List Knowledge Spaces",
    description: "List durable memory spaces visible in the active tenant.",
    inputSchema: {
      type: "object",
      properties: { limit: { type: "integer", minimum: 1, maximum: 1_000 } },
    },
    async execute(raw, value) {
      const context = workflowToolContext(value);
      const limit = positiveInteger(record(raw).limit, 100);
      const values = (await threadMemorySpaces(
        context.processor,
        context.threadId,
      )).slice(0, Math.min(limit, 1_000));
      return { knowledgeSpaces: values, totalKnowledgeSpaces: values.length };
    },
  }) as WorkflowTool;
}

function searchMemoryTool(): WorkflowTool {
  return Object.freeze({
    id: SEARCH_MEMORY_TOOL_ID,
    key: SEARCH_MEMORY_TOOL_ID,
    name: "Search Memory",
    description:
      "Search accessible semantic memory by meaning, form, kind, and lifecycle status.",
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
    async execute(raw, value) {
      const tool = workflowToolContext(value);
      const input = record(raw);
      const spaces = await threadMemorySpaces(tool.processor, tool.threadId);
      const readable = new Set(spaces.map((space) => space.id));
      const values = await collection(
        tool.processor,
        memoryRecordCollection.name,
      ).list({ limit: 1_000 });
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
  }) as WorkflowTool;
}

function inspectMemoryTool(): WorkflowTool {
  return Object.freeze({
    id: INSPECT_MEMORY_TOOL_ID,
    key: INSPECT_MEMORY_TOOL_ID,
    name: "Inspect Memory",
    description:
      "Inspect one accessible semantic memory, its provenance, time, and graph relations.",
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: { id: { type: "string" } },
      additionalProperties: false,
    },
    async execute(raw, value) {
      const tool = workflowToolContext(value);
      const id = requiredText(record(raw).id, "Memory id");
      const item = await collection(tool.processor, memoryRecordCollection.name)
        .get({ id });
      if (!item) throw new Error(`Memory '${id}' was not found.`);
      const spaces = new Set(
        (await threadMemorySpaces(tool.processor, tool.threadId)).map((space) =>
          space.id
        ),
      );
      if (!spaces.has(String(item.memorySpaceId))) {
        throw new Error(`Memory '${id}' is not accessible from this thread.`);
      }
      const relations = await tool.processor.relations.list({
        nodeId: id,
        direction: "both",
        limit: 1_000,
      });
      const accessibleMemoryIds = new Set(
        (await collection(tool.processor, memoryRecordCollection.name).list({
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
  }) as WorkflowTool;
}

function setMemoryStatusTool(): WorkflowTool {
  return Object.freeze({
    id: SET_MEMORY_STATUS_TOOL_ID,
    key: SET_MEMORY_STATUS_TOOL_ID,
    name: "Set Memory Status",
    description:
      "Retract, close, complete, cancel, answer, obsolete, deprecate, or archive one accessible memory without erasing history.",
    inputSchema: {
      type: "object",
      required: ["id", "status"],
      properties: { id: { type: "string" }, status: { type: "string" } },
      additionalProperties: false,
    },
    async execute(raw, value) {
      const tool = workflowToolContext(value);
      const input = record(raw);
      const id = requiredText(input.id, "Memory id");
      const status = requiredText(input.status, "Memory status");
      const item = await collection(tool.processor, memoryRecordCollection.name)
        .get({ id });
      const mapped = item ? memoryRecord(item) : null;
      if (!mapped) throw new Error(`Memory '${id}' was not found.`);
      const spaces = new Set(
        (await threadMemorySpaces(tool.processor, tool.threadId)).filter((
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
      await collection(tool.processor, memoryRecordCollection.name).update({
        id,
        set: {
          status,
          temporal: {
            ...record(item!.temporal),
            invalidatedAt: terminalStatus(status)
              ? new Date().toISOString()
              : undefined,
          },
        },
      }, { operationKey: `memory-status:${id}:${status}` });
      return { id, status };
    },
  }) as WorkflowTool;
}

function memoryReservationProcessor(
  config: LongTermMemoryConfig,
): Processor<CopilotzProcessorContext> {
  return defineProcessor({
    id: "copilotz.memory.reserve",
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
      if (!context.resources.get<Agent>("agents", agentId)) return;
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
        await collection(context, longTermMemoryCollection.name).create({
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
          content: null,
          contextSnapshotContent: null,
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
  });
}

const prepareMemoryAttemptProcessor: Processor<CopilotzProcessorContext> =
  defineProcessor({
    id: "copilotz.memory.prepare-attempt",
    on: [{ eventType: "long_term_memory.created" }],
    async handle(event, context) {
      if (!event.durable || !event.subject) return;
      let checkpoint = await collection(context, longTermMemoryCollection.name)
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
        agent: context.resources.require<Agent>("agents", agentId),
        participant,
        thread,
        rangeMessages: messages,
      });
      checkpoint =
        await collection(context, longTermMemoryCollection.name).get({
          id: checkpoint.id,
        }) ?? checkpoint;
      const metadata = withWorkflowMetadata({
        memoryCheckpointId: checkpoint.id,
        memoryRepairIndex: 0,
      }, {
        kind: "memory_consolidation",
        agentParticipantId: participant.id,
      });
      await context.features.llmAttempt.create({
        id: `${checkpoint.id}:llm:0`,
        threadId,
        messageId: requiredText(
          checkpoint.sourceEndMessageId,
          "Memory source end",
        ),
        participantId: participant.id,
        agentId,
        inputMessageIds: messages.map((message) => message.id),
        availableToolIds: [CONSOLIDATE_MEMORY_TOOL_ID],
        status: "running",
        metadata,
      }, {
        operationKey: `memory-attempt:${checkpoint.id}:0`,
        identity: { metadata },
      });
    },
  });

function executeMemoryAttemptProcessor(
  options: CreateLongTermMemoryPluginOptions,
  consolidateTool: WorkflowTool,
): Processor<CopilotzProcessorContext> {
  return defineProcessor({
    id: "copilotz.memory.execute-attempt",
    on: [{
      eventType: "llm_attempt.created",
      metadata: { copilotzWorkflow: { kind: "memory_consolidation" } },
    }],
    async handle(event, context) {
      if (!event.durable || !event.subject) return;
      const attempt = await context.collections.llm_attempt.get({
        id: event.subject.id,
      });
      if (!attempt || String(attempt.status) !== "running") return;
      const checkpointId = memoryCheckpointId(attempt.metadata);
      const checkpoint = await collection(
        context,
        longTermMemoryCollection.name,
      ).get({ id: checkpointId });
      if (!checkpoint || checkpoint.status !== "pending") return;
      const agent = context.resources.require<Agent>(
        "agents",
        requiredText(attempt.agentId, "Memory agent id"),
      );
      const participant = optionalText(attempt.participantId)
        ? await loadParticipantRecord(
          context,
          optionalText(attempt.participantId)!,
        )
        : null;
      const thread = await loadThreadRecord(context, String(attempt.threadId));
      if (!participant || participant.participantType !== "agent" || !thread) {
        throw new Error("Memory attempt participant or thread is unavailable.");
      }
      const allMessages = await listThreadMessageRecords(
        context,
        String(attempt.threadId),
      );
      const messages = rangeMessages(allMessages, checkpoint);
      const sources = await sourceMessages(context, messages);
      const spaces = activeSpacesForCheckpoint(
        checkpoint,
        await threadMemorySpaces(context, String(attempt.threadId)),
      );
      const previous = (await activeMemoryRecords(context, spaces, agent.id))
        .filter((item) => !terminalStatus(item.status)).slice(0, 100);
      const snapshot = frozenSnapshot(checkpoint);
      const contributions: CollectedContextContribution[] = snapshot.map((
        item,
      ) => ({
        id: item.id,
        resourceId: item.resourceId,
        title: item.title,
        role: item.role,
        content: item.content.length === 1
          ? item.content[0]
          : { type: "json", value: item.content, role: "memory.context_refs" },
        ...(item.source ? { source: item.source } : {}),
        capturedAt: item.capturedAt,
        ...(item.resourceId === MEMORY_RESOURCE_ID
          ? { historyAfterMessageId: item.historyAfterMessageId }
          : {}),
      }));
      const instruction = buildMemoryConsolidationInstruction({
        spaces,
        sourceMessages: sources,
        kinds: memoryKinds(context),
        previousRecords: previous,
        context: snapshot,
        repair: optionalText(record(attempt.metadata).memoryRepairReason),
      });
      const prompt = await buildAgentTextPrompt(context, {
        options: {},
        agent,
        participant,
        attempt,
        sourceEvent: event,
        tools: [consolidateTool],
        purpose: "memory_consolidation",
        contextContributions: contributions,
        sourceRange: {
          startMessageId: messages[0].id,
          endMessageId: messages.at(-1)!.id,
          messages,
        },
        systemSections: [instruction],
      });
      const baseConfig = agentTextBaseConfig(agent);
      const config: ProviderConfig = options.resolveLlmConfig
        ? await options.resolveLlmConfig({
          agent,
          participant,
          attempt: mapLlmAttemptRecord(attempt),
          thread,
          messages: prompt.messages,
          sourceEvent: event,
          context,
          baseConfig,
        })
        : staticAgentTextConfig(agent);
      try {
        const response: ChatResponse = await runGenerateChain(
          generateChainFromResources(context.resources, config),
          {
            request: {
              messages: [...prompt.messages],
              tools: [...prompt.tools],
              signal: context.signal,
              idempotencyKey: context.idempotencyKey,
              strictAttemptLifecycle: true,
              onAttemptLifecycle: (lifecycle) =>
                recordProviderAttemptLifecycle(attempt, lifecycle, context),
            },
            env: { ...(options.env ?? {}) },
          },
        ).result;
        const answer = response.answer
          ? await context.content.prepare({
            type: "text",
            text: response.answer,
            role: "body",
          }, { operationKey: "memory:answer" })
          : undefined;
        const reasoning = response.reasoning
          ? await context.content.prepare({
            type: "text",
            text: response.reasoning,
            role: "reasoning",
          }, { operationKey: "memory:reasoning" })
          : undefined;
        const toolCalls = response.toolCalls?.length
          ? await context.content.prepare({
            type: "json",
            value: response.toolCalls,
            role: "llm.tool_calls",
          }, { operationKey: "memory:tool-calls" })
          : undefined;
        await context.features.llmAttempt.complete({
          id: attempt.id,
          ...(answer ? { answer } : {}),
          ...(reasoning ? { reasoning } : {}),
          ...(toolCalls ? { toolCalls } : {}),
          ...(response.finishReason
            ? { finishReason: response.finishReason }
            : {}),
          usage: response.usage as unknown as Record<string, unknown>,
          cost: response.cost as unknown as Record<string, unknown>,
          metadataPatch: {
            provider: response.provider ?? config.provider,
            model: response.model ?? config.model,
          },
        }, {
          operationKey: "memory:complete",
          identity: { metadata: record(attempt.metadata) },
        });
      } catch (error) {
        const detail = await context.content.prepare({
          type: "text",
          text: error instanceof Error ? error.message : String(error),
          role: "provider.error_detail",
        }, { operationKey: "memory:error" });
        await context.features.llmAttempt.fail({
          id: attempt.id,
          safeError: safeError(
            "memory_provider_error",
            "Memory provider attempt failed.",
            true,
          ),
          errorDetail: detail,
        }, {
          operationKey: "memory:fail",
          identity: { metadata: record(attempt.metadata) },
        });
      }
    },
  });
}

function projectMemoryAttemptProcessor(
  maxRepairAttempts: number,
): Processor<CopilotzProcessorContext> {
  return defineProcessor({
    id: "copilotz.memory.project-attempt",
    on: [
      {
        eventType: "llm_attempt.updated",
        metadata: { copilotzWorkflow: { kind: "memory_consolidation" } },
        data: { record: { status: "completed" } },
      },
      {
        eventType: "llm_attempt.updated",
        metadata: { copilotzWorkflow: { kind: "memory_consolidation" } },
        data: { record: { status: "failed" } },
      },
      {
        eventType: "llm_attempt.updated",
        metadata: { copilotzWorkflow: { kind: "memory_consolidation" } },
        data: { record: { status: "cancelled" } },
      },
    ],
    async handle(event, context) {
      if (!event.durable || !event.subject) return;
      const attempt = await context.collections.llm_attempt.get({
        id: event.subject.id,
      });
      if (!attempt) return;
      const checkpointId = memoryCheckpointId(attempt.metadata);
      if (attempt.status !== "completed") {
        await repairOrFail(context, {
          checkpointId,
          attemptId: attempt.id,
          reason: optionalText(record(attempt.safeError).message) ??
            "Memory LLM attempt did not complete.",
          maxRepairAttempts,
        });
        return;
      }
      const calls = await toolCallsFromAttempt(context, attempt);
      if (
        calls.length !== 1 || calls[0].tool?.id !== CONSOLIDATE_MEMORY_TOOL_ID
      ) {
        await repairOrFail(context, {
          checkpointId,
          attemptId: attempt.id,
          reason: calls.length === 0
            ? "The prior attempt did not call consolidate_memory. Call it exactly once and emit no answer."
            : "The prior attempt produced multiple or unauthorized tool calls. Call consolidate_memory exactly once.",
          maxRepairAttempts,
        });
        return;
      }
      const call = calls[0];
      const prepared = await context.content.prepare({
        type: "json",
        value: parseToolArgs(call.args),
        role: "tool.arguments",
      }, { operationKey: `memory:${checkpointId}:arguments` });
      const metadata = withWorkflowMetadata({
        memoryCheckpointId: checkpointId,
        memoryRepairIndex: record(attempt.metadata).memoryRepairIndex ?? 0,
      }, {
        kind: "memory_consolidation",
        llmAttemptId: attempt.id,
        parentLlmAttemptId: attempt.id,
        toolCallId: call.id,
        agentParticipantId: optionalText(attempt.participantId),
        continuation: "none",
      });
      await context.features.toolExecution.create({
        id: `${checkpointId}:tool:${
          Number(record(attempt.metadata).memoryRepairIndex ?? 0)
        }`,
        threadId: attempt.threadId,
        participantId: attempt.participantId,
        agentId: attempt.agentId,
        toolCallId: call.id,
        tool: { id: CONSOLIDATE_MEMORY_TOOL_ID, name: "Consolidate Memory" },
        status: "running",
        historyVisibility: "requester_only",
        arguments: prepared,
        metadata,
      }, {
        operationKey: `memory:${checkpointId}:tool`,
        identity: { metadata },
      });
    },
  });
}

function settleMemoryToolProcessor(
  maxRepairAttempts: number,
): Processor<CopilotzProcessorContext> {
  return defineProcessor({
    id: "copilotz.memory.settle-tool",
    on: [
      {
        eventType: "tool_execution.updated",
        data: { record: { status: "completed" } },
        metadata: { copilotzWorkflow: { kind: "memory_consolidation" } },
      },
      {
        eventType: "tool_execution.updated",
        data: { record: { status: "failed" } },
        metadata: { copilotzWorkflow: { kind: "memory_consolidation" } },
      },
      {
        eventType: "tool_execution.updated",
        data: { record: { status: "cancelled" } },
        metadata: { copilotzWorkflow: { kind: "memory_consolidation" } },
      },
    ],
    async handle(event, context) {
      if (!event.durable || !event.subject) return;
      const execution = await context.collections.tool_execution.get({
        id: event.subject.id,
      });
      if (
        !execution || String(execution.status) === "running" ||
        String(execution.status) === "completed"
      ) return;
      const checkpointId = memoryCheckpointId(execution.metadata);
      const attemptId = requiredText(
        workflowMetadata(record(execution.metadata))?.parentLlmAttemptId,
        "Memory attempt id",
      );
      let reason = optionalText(record(execution.safeError).message) ??
        "consolidate_memory execution failed.";
      const detail = toolExecutionContent(execution).errorDetail;
      if (detail) {
        const resolved = await context.content.resolve(detail);
        reason = resolved.text ?? reason;
      }
      await repairOrFail(context, {
        checkpointId,
        attemptId,
        reason,
        maxRepairAttempts,
      });
    },
  });
}

function createMemoryContextResource(
  enabled: boolean,
): ContextResource & Readonly<{ historyAfterMessageId?: string }> {
  return Object.freeze({
    id: MEMORY_RESOURCE_ID,
    type: "context",
    purposes: Object.freeze(["conversation", "memory_consolidation"] as const),
    async contribute(input) {
      if (!enabled) return null;
      // Context resources intentionally receive capabilities, not the processor object.
      const checkpointCollection =
        input.collections[longTermMemoryCollection.name];
      const accessCollection =
        input.collections[memorySpaceAccessCollection.name];
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

export function createLongTermMemoryPlugin(
  options: CreateLongTermMemoryPluginOptions = {},
): CopilotzPlugin {
  const enabled = options.enabled !== false;
  const config = normalizedConfig(options.config);
  const consolidate = consolidateMemoryTool(options, config);
  const tools = Object.freeze([
    consolidate,
    listSpacesTool(),
    searchMemoryTool(),
    inspectMemoryTool(),
    setMemoryStatusTool(),
  ]);
  const maxRepairAttempts = nonNegativeInteger(options.maxRepairAttempts, 1);
  const processors = enabled
    ? Object.freeze([
      memoryReservationProcessor(config),
      prepareMemoryAttemptProcessor,
      executeMemoryAttemptProcessor(options, consolidate),
      projectMemoryAttemptProcessor(maxRepairAttempts),
      settleMemoryToolProcessor(maxRepairAttempts),
    ])
    : Object.freeze([] as Processor<CopilotzProcessorContext>[]);
  const collections = Object.freeze([
    memorySpaceCollection,
    memorySpaceAccessCollection,
    longTermMemoryCollection,
    memoryRecordCollection,
  ]);
  const context = createMemoryContextResource(enabled);
  const kinds = Object.freeze(CORE_MEMORY_KINDS.map(defineMemoryKind));
  return definePlugin({
    manifest: {
      id: options.id ?? DEFAULT_PLUGIN_ID,
      version: options.version ?? DEFAULT_PLUGIN_VERSION,
      provides: {
        context: [context.id],
        memoryKinds: kinds.map((kind) => kind.id),
        tools: tools.map((tool) => tool.key),
        processors: processors.map((processor) => processor.id),
        collections: collections.map((definition) => definition.name),
      },
    },
    resources: {
      context: [context],
      memoryKinds: kinds,
      tools,
      processors,
      collections,
    },
  });
}
