import type { Agent } from "../resources/index.ts";
import type { ContentRef } from "../content/index.ts";
import {
  type CollectionRecord,
  type ConversationMessage,
  type ConversationThread,
  llmAttemptContent,
  type Participant,
  type SafeWorkflowError,
} from "../domain/index.ts";
import type { CopilotzProcessorContext } from "../engine/index.ts";
import { chat as defaultChat } from "../llm/index.ts";
import type {
  ChatMessage,
  ChatResponse,
  LLMAttemptLifecycleEvent,
  ProviderConfig,
} from "../llm/types.ts";
import { estimateTextTokens } from "../tokens/index.ts";
import {
  type CopilotzPlugin,
  definePlugin,
  defineProcessor,
  type Processor,
} from "../plugins/index.ts";
import { recordProviderAttemptLifecycle } from "../workflows/llm-lifecycle.ts";
import {
  agentTextBaseConfig,
  providerRegistry,
  staticAgentTextConfig,
  withWorkflowMetadata,
  workflowMetadata,
} from "../workflows/resources.ts";
import { buildTextTranscript } from "../workflows/transcript.ts";
import type {
  WorkflowTool,
  WorkflowToolExecutionContext,
} from "../workflows/types.ts";
import {
  applyContinuityPatch,
  buildMemoryConsolidationInstruction,
  createEmptyContinuity,
  createWorkingMemoryNodeDrafts,
  extractVisibleBrainNodeIds,
  MEMORY_RELATION_TYPES,
  type MemoryBrainNode,
  type MemoryBrainRelation,
  type MemoryConsolidationProposal,
  type MemorySourceMessage,
  type MemorySpaceDescriptor,
  parseMemoryConsolidationProposal,
  readContinuity,
  renderLongTermMemory,
  type RetrievedMemoryBrainNode,
  selectLongTermMemoryRange,
  stableMemoryNodeId,
} from "./consolidation.ts";
import {
  brainNodeCollection,
  longTermMemoryCollection,
  memorySpaceAccessCollection,
  memorySpaceCollection,
} from "./collections.ts";
import type {
  CreateLongTermMemoryPluginOptions,
  LongTermMemoryResource,
  MemoryConsolidator,
  MemoryConsolidatorResult,
} from "./types.ts";
import {
  DEFAULT_LONG_TERM_MEMORY_CONFIG,
  type LongTermMemoryConfig,
} from "./resources.ts";

const DEFAULT_PLUGIN_ID = "@copilotz/core-long-term-memory";
const DEFAULT_PLUGIN_VERSION = "3.0.0";
const MEMORY_RESOURCE_ID = "copilotz.long_term";
const LIST_KNOWLEDGE_SPACES_TOOL_ID = "list_knowledge_spaces";

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function requiredText(value: unknown, name: string): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) throw new TypeError(`${name} must be non-empty.`);
  return normalized;
}

function optionalText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function workflowToolContext(
  value: WorkflowToolExecutionContext | undefined,
): WorkflowToolExecutionContext {
  if (!value?.processor) {
    throw new Error("This tool requires an event-native Copilotz context.");
  }
  return value;
}

function listKnowledgeSpacesTool(): WorkflowTool {
  return Object.freeze({
    id: LIST_KNOWLEDGE_SPACES_TOOL_ID,
    key: LIST_KNOWLEDGE_SPACES_TOOL_ID,
    name: "List Knowledge Spaces",
    description: "List durable memory spaces in the active tenant namespace.",
    inputSchema: {
      type: "object",
      properties: {
        after: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 1_000 },
      },
    },
    async execute(
      raw: unknown,
      value?: WorkflowToolExecutionContext,
    ) {
      const context = workflowToolContext(value);
      const input = record(raw);
      const limit = input.limit === undefined
        ? 100
        : positiveInteger(input.limit, 100);
      if (limit > 1_000) {
        throw new TypeError("limit must not exceed 1000.");
      }
      const collection = context.processor.collections[
        memorySpaceCollection.name
      ];
      if (!collection) {
        throw new Error("Memory-space collection is not available.");
      }
      const spaces = await collection.list({
        ...(optionalText(input.after)
          ? { after: optionalText(input.after) }
          : {}),
        limit,
      });
      return {
        knowledgeSpaces: spaces.map((space) => ({
          id: space.id,
          name: optionalText(space.name) ?? `memory:${space.id}`,
          scopeType: optionalText(space.scopeType),
          scopeId: optionalText(space.scopeId),
          kind: optionalText(space.kind),
          description: optionalText(space.description),
          metadata: record(space.metadata),
          createdAt: space.createdAt,
          updatedAt: space.updatedAt,
        })),
        totalKnowledgeSpaces: spaces.length,
      };
    },
  }) as WorkflowTool;
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
  value: Partial<LongTermMemoryConfig> | undefined,
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

function collection(
  context: CopilotzProcessorContext,
  name: string,
) {
  const value = context.collections[name];
  if (!value) {
    throw new Error(`Long-term memory requires collection '${name}'.`);
  }
  return value;
}

function participantAgentId(participant: Participant): string {
  return participant.agentId ?? participant.externalId;
}

function checkpointSequence(value: CollectionRecord): number {
  const sequence = Number(value.sequence);
  return Number.isSafeInteger(sequence) && sequence > 0 ? sequence : 0;
}

function checkpointStatus(value: CollectionRecord): string {
  return typeof value.status === "string" ? value.status : "";
}

function checkpointForAgent(
  value: CollectionRecord,
  threadId: string,
  agentId: string,
): boolean {
  return value.threadId === threadId && value.agentId === agentId;
}

async function checkpoints(
  context: CopilotzProcessorContext,
  threadId: string,
  agentId: string,
  status?: "pending" | "ready" | "failed",
): Promise<readonly CollectionRecord[]> {
  const values = await collection(context, longTermMemoryCollection.name).list({
    where: {
      threadId,
      agentId,
      ...(status ? { status } : {}),
    },
    limit: 1_000,
  });
  return Object.freeze(
    values
      .filter((value) => checkpointForAgent(value, threadId, agentId))
      .sort((left, right) =>
        checkpointSequence(right) - checkpointSequence(left) ||
        right.createdAt.localeCompare(left.createdAt) ||
        right.id.localeCompare(left.id)
      ),
  );
}

async function resolvedCheckpointContent(
  context: CopilotzProcessorContext,
  checkpoint: CollectionRecord | null | undefined,
): Promise<string | undefined> {
  if (!checkpoint) return undefined;
  if (typeof checkpoint.content === "string") {
    return checkpoint.content.trim() || undefined;
  }
  if (!Array.isArray(checkpoint.content) || checkpoint.content.length === 0) {
    return undefined;
  }
  const resolved = await context.content.resolveMany(
    checkpoint.content as ContentRef[],
  );
  const parts = resolved.map((item) => {
    if (item.text !== undefined) return item.text;
    if (item.value !== undefined) return JSON.stringify(item.value);
    return new TextDecoder().decode(item.bytes);
  }).filter(Boolean);
  return parts.join("\n").trim() || undefined;
}

async function threadMemorySpaces(
  context: CopilotzProcessorContext,
  threadId: string,
): Promise<readonly MemorySpaceDescriptor[]> {
  const accessCollection = collection(
    context,
    memorySpaceAccessCollection.name,
  );
  const spaceCollection = collection(context, memorySpaceCollection.name);
  const access = await accessCollection.list({
    where: { threadId },
    limit: 1_000,
  });
  const spaces: MemorySpaceDescriptor[] = [];
  for (const grant of access) {
    if (grant.threadId !== threadId) continue;
    const memorySpaceId = optionalText(grant.memorySpaceId);
    if (!memorySpaceId) continue;
    const space = await spaceCollection.get(memorySpaceId);
    if (!space) continue;
    const mode = grant.access === "read_write" ? "read_write" : "read";
    spaces.push(Object.freeze({
      id: space.id,
      name: optionalText(space.name) ?? `memory:${space.id}`,
      description: optionalText(space.description) ?? null,
      scopeType: optionalText(space.scopeType) ?? "custom",
      access: mode,
      defaultWrite: mode === "read_write" && grant.defaultWrite === true,
    }));
  }
  const sorted = spaces.sort((left, right) =>
    Number(right.defaultWrite) - Number(left.defaultWrite) ||
    left.name.localeCompare(right.name) || left.id.localeCompare(right.id)
  );
  const firstWritable = sorted.find((space) => space.access === "read_write");
  if (firstWritable && !sorted.some((space) => space.defaultWrite)) {
    const index = sorted.indexOf(firstWritable);
    sorted[index] = Object.freeze({ ...firstWritable, defaultWrite: true });
  }
  let foundDefault = false;
  return Object.freeze(sorted.map((space) => {
    if (!space.defaultWrite) return space;
    if (!foundDefault) {
      foundDefault = true;
      return space;
    }
    return Object.freeze({ ...space, defaultWrite: false });
  }));
}

async function ensureWritableMemorySpace(
  context: CopilotzProcessorContext,
  threadId: string,
): Promise<readonly MemorySpaceDescriptor[]> {
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
    description: "Default thread memory space",
    metadata: {},
  }, { operationKey: `space:create:${memorySpaceId}` });
  const accessId = `memory-space-access:${threadId}:${memorySpaceId}`;
  await collection(context, memorySpaceAccessCollection.name).create({
    id: accessId,
    threadId,
    memorySpaceId,
    access: "read_write",
    defaultWrite: true,
    metadata: {},
  }, { operationKey: `space:grant:${accessId}` });
  return await threadMemorySpaces(context, threadId);
}

function checkpointIsAccessible(
  checkpoint: CollectionRecord,
  spaces: readonly MemorySpaceDescriptor[],
): boolean {
  const readable = new Set(spaces.map((space) => space.id));
  const ids = Array.isArray(checkpoint.readMemorySpaceIds)
    ? checkpoint.readMemorySpaceIds.filter((id): id is string =>
      typeof id === "string"
    )
    : optionalText(checkpoint.memorySpaceId)
    ? [String(checkpoint.memorySpaceId)]
    : [];
  return ids.length > 0 && ids.every((id) => readable.has(id));
}

async function latestAccessibleReadyCheckpoint(
  context: CopilotzProcessorContext,
  threadId: string,
  agentId: string,
  spaces: readonly MemorySpaceDescriptor[],
  beforeSequence = Number.POSITIVE_INFINITY,
): Promise<CollectionRecord | null> {
  return (await checkpoints(context, threadId, agentId, "ready"))
    .find((checkpoint) =>
      checkpointSequence(checkpoint) < beforeSequence &&
      checkpointIsAccessible(checkpoint, spaces)
    ) ?? null;
}

async function messageText(
  context: CopilotzProcessorContext,
  message: ConversationMessage,
): Promise<string> {
  const resolved = await context.content.resolveMany(message.content);
  return resolved.map((item) => {
    if (item.text !== undefined) return item.text;
    if (item.value !== undefined) return JSON.stringify(item.value);
    return `[${item.ref.kind}:${item.ref.name ?? item.ref.mediaType}]`;
  }).join("\n");
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
      const attempt = await context.llmAttempts.get(workflow.llmAttemptId);
      if (attempt) {
        const content = llmAttemptContent(attempt);
        if (content.toolCalls) {
          const value = await context.content.resolve(content.toolCalls);
          toolCalls = value.value ?? value.text;
        }
        if (content.reasoning) {
          const value = await context.content.resolve(content.reasoning);
          reasoning = value.text ?? new TextDecoder().decode(value.bytes);
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

function safeError(error: unknown): SafeWorkflowError {
  return Object.freeze({
    name: error instanceof Error ? error.name : "MemoryConsolidationError",
    message: error instanceof Error ? error.message : String(error),
    code: "memory_consolidation_failed",
    retryable: true,
  });
}

function shiftedLifecycle(
  lifecycle: LLMAttemptLifecycleEvent,
  callIndex: number,
): LLMAttemptLifecycleEvent {
  return {
    ...lifecycle,
    attemptIndex: lifecycle.attemptIndex + callIndex * 1_000,
    attemptId: `${lifecycle.attemptId}:memory-call:${callIndex}`,
  } as LLMAttemptLifecycleEvent;
}

function createDefaultConsolidator(
  options: CreateLongTermMemoryPluginOptions,
): MemoryConsolidator {
  const runChat = options.chat ?? defaultChat;
  return async (input): Promise<MemoryConsolidatorResult> => {
    const baseConfig = agentTextBaseConfig(input.agent);
    const resolved = options.resolveLlmConfig
      ? await options.resolveLlmConfig({
        agent: input.agent,
        participant: input.participant,
        attempt: input.attempt,
        thread: input.thread,
        messages: input.messages,
        sourceEvent: input.sourceEvent,
        context: input.context,
        baseConfig,
      })
      : staticAgentTextConfig(input.agent);
    const config: ProviderConfig = {
      ...resolved,
      outputReasoning: false,
      responseType: "json",
    };
    const providers = providerRegistry(input.context.resources);
    if (!providers[String(config.provider)]) {
      throw new Error(
        `LLM provider resource '${String(config.provider)}' is not registered.`,
      );
    }
    const instruction = buildMemoryConsolidationInstruction({
      spaces: input.spaces,
      sourceMessages: input.sourceMessages,
      hasPreviousMemoryCheckpoint: Boolean(input.previousContent),
    });
    const baseMessages: ChatMessage[] = [
      ...(input.previousContent
        ? [{
          role: "system" as const,
          content: `## PREVIOUS LONG-TERM MEMORY\n${input.previousContent}`,
        }]
        : []),
      ...input.messages.map((message) => structuredClone(message)),
      { role: "user", content: instruction },
    ];
    const routing = {
      writableMemorySpaceIds: new Set(
        input.spaces.filter((space) => space.access === "read_write")
          .map((space) => space.id),
      ),
      defaultWriteMemorySpaceId:
        input.spaces.find((space) => space.defaultWrite)!.id,
    };
    const invoke = async (
      messages: ChatMessage[],
      callIndex: number,
    ): Promise<ChatResponse> =>
      await runChat(
        {
          messages,
          tools: [],
          signal: input.context.signal,
          idempotencyKey: `${input.context.idempotencyKey}:memory:${callIndex}`,
          strictAttemptLifecycle: true,
          onAttemptLifecycle: (lifecycle) =>
            recordProviderAttemptLifecycle(
              input.attempt,
              shiftedLifecycle(lifecycle, callIndex),
              input.context,
            ),
        },
        config,
        { ...(options.env ?? {}) },
        undefined,
        providers,
      );

    let response = await invoke(baseMessages, 0);
    const parse = (candidate: ChatResponse) => {
      if (candidate.toolCalls?.length) {
        throw new Error(
          "Long-term-memory consolidation must not produce tool calls.",
        );
      }
      return parseMemoryConsolidationProposal(
        candidate.answer,
        new Set(input.sourceMessages.map((message) => message.id)),
        input.olderNodeIds,
        routing,
      );
    };
    let proposal: MemoryConsolidationProposal;
    try {
      proposal = parse(response);
    } catch (firstError) {
      response = await invoke([
        ...baseMessages,
        { role: "assistant", content: response.answer },
        {
          role: "user",
          content: [
            "The prior JSON failed validation.",
            firstError instanceof Error
              ? firstError.message
              : String(firstError),
            "Return one corrected JSON object only.",
          ].join("\n"),
        },
      ], 1);
      proposal = parse(response);
    }
    return Object.freeze({ proposal, response });
  };
}

async function completeLogicalAttempt(
  context: CopilotzProcessorContext,
  attemptId: string,
  result: MemoryConsolidatorResult,
): Promise<void> {
  const response = result.response;
  let usage = response?.usage as unknown as Record<string, unknown> | undefined;
  let cost = response?.cost as unknown as Record<string, unknown> | undefined;
  let metricsFinalizedAt: string | undefined;
  if (response?.usageFinalized) {
    const finalized = await response.usageFinalized;
    if (finalized) {
      usage = finalized.usage as unknown as Record<string, unknown>;
      cost = finalized.cost as unknown as Record<string, unknown> | undefined;
      metricsFinalizedAt = finalized.finalizedAt;
    }
  }
  const answerText = response?.answer ?? JSON.stringify(result.proposal);
  const answer = await context.content.prepare({
    type: "text",
    text: answerText,
    role: "body",
  }, { operationKey: `memory-attempt:${attemptId}:answer` });
  const reasoning = response?.reasoning
    ? await context.content.prepare({
      type: "text",
      text: response.reasoning,
      role: "reasoning",
    }, { operationKey: `memory-attempt:${attemptId}:reasoning` })
    : undefined;
  await context.llmAttempts.complete({
    id: attemptId,
    answer,
    ...(reasoning ? { reasoning } : {}),
    ...(response?.finishReason ? { finishReason: response.finishReason } : {}),
    ...(usage ? { usage } : {}),
    ...(cost ? { cost } : {}),
    ...(metricsFinalizedAt ? { metricsFinalizedAt } : {}),
    metadataPatch: {
      ...(response?.provider ? { provider: response.provider } : {}),
      ...(response?.model ? { model: response.model } : {}),
    },
  }, { operationKey: `memory-attempt:${attemptId}:complete` });
}

async function proposalFromCompletedAttempt(
  context: CopilotzProcessorContext,
  threadId: string,
  checkpointId: string,
  sourceIds: ReadonlySet<string>,
  olderIds: ReadonlySet<string>,
  spaces: readonly MemorySpaceDescriptor[],
): Promise<MemoryConsolidationProposal | null> {
  const attempts = await context.llmAttempts.list(threadId, { limit: 1_000 });
  const attempt = [...attempts].reverse().find((candidate) =>
    candidate.status === "completed" &&
    record(candidate.metadata).memoryCheckpointId === checkpointId
  );
  const answer = attempt ? llmAttemptContent(attempt).answer : undefined;
  if (!answer) return null;
  const resolved = await context.content.resolve(answer);
  const text = resolved.text ?? new TextDecoder().decode(resolved.bytes);
  const writable = spaces.filter((space) => space.access === "read_write");
  const defaultSpace = spaces.find((space) => space.defaultWrite);
  if (!defaultSpace || !writable.length) return null;
  return parseMemoryConsolidationProposal(text, sourceIds, olderIds, {
    writableMemorySpaceIds: new Set(writable.map((space) => space.id)),
    defaultWriteMemorySpaceId: defaultSpace.id,
  });
}

function finiteEmbedding(value: unknown): value is readonly number[] {
  return Array.isArray(value) && value.length > 0 &&
    value.every((entry) => typeof entry === "number" && Number.isFinite(entry));
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
    new Set(
      value.toLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? [],
    );
  const wanted = words(query);
  const available = words(candidate);
  if (!wanted.size || !available.size) return 0;
  let overlap = 0;
  for (const word of wanted) if (available.has(word)) overlap++;
  return overlap / Math.sqrt(wanted.size * available.size);
}

function brainNode(value: CollectionRecord): MemoryBrainNode | null {
  const name = optionalText(value.name);
  const content = optionalText(value.content);
  const kind = optionalText(value.kind);
  const memorySpaceId = optionalText(value.memorySpaceId);
  return name && content && kind && memorySpaceId
    ? Object.freeze({ id: value.id, name, content, kind, memorySpaceId })
    : null;
}

async function retrieveOlderBrainNodes(
  context: CopilotzProcessorContext,
  input: Readonly<{
    agent: Agent;
    thread: ConversationThread;
    checkpointId: string;
    query: string;
    spaces: readonly MemorySpaceDescriptor[];
    pinnedIds: ReadonlySet<string>;
    limit: number;
    embed?: CreateLongTermMemoryPluginOptions["embed"];
  }>,
): Promise<readonly RetrievedMemoryBrainNode[]> {
  const readable = new Set(input.spaces.map((space) => space.id));
  const records = await collection(context, brainNodeCollection.name).list({
    where: { createdByAgentId: input.agent.id, status: "active" },
    limit: 1_000,
  });
  const candidates = records.filter((value) =>
    value.createdByAgentId === input.agent.id && value.status === "active" &&
    readable.has(String(value.memorySpaceId)) &&
    value.checkpointId !== input.checkpointId
  );
  let queryEmbedding: readonly number[] | undefined;
  if (input.embed && input.query.trim()) {
    const embeddings = await input.embed([input.query], {
      agent: input.agent,
      thread: input.thread,
      checkpointId: input.checkpointId,
      context,
    });
    if (finiteEmbedding(embeddings[0])) queryEmbedding = embeddings[0];
  }
  const ranked = candidates.flatMap((value): RetrievedMemoryBrainNode[] => {
    const node = brainNode(value);
    if (!node) return [];
    const embedding = finiteEmbedding(value.embedding) ? value.embedding : null;
    const similarity = queryEmbedding && embedding
      ? cosine(queryEmbedding, embedding)
      : lexicalScore(input.query, `${node.name}\n${node.content}`);
    return [{ node, similarity }];
  }).sort((left, right) =>
    Number(input.pinnedIds.has(right.node.id)) -
      Number(input.pinnedIds.has(left.node.id)) ||
    right.similarity - left.similarity ||
    left.node.id.localeCompare(right.node.id)
  );
  return Object.freeze(ranked.slice(0, input.limit));
}

function checkpointVisibleIds(
  checkpoint: CollectionRecord | null,
  content: string | undefined,
): ReadonlySet<string> {
  const metadata = record(checkpoint?.metadata);
  const persisted = Array.isArray(metadata.visibleBrainNodeIds)
    ? metadata.visibleBrainNodeIds.filter((id): id is string =>
      typeof id === "string"
    )
    : [];
  return new Set([
    ...persisted,
    ...extractVisibleBrainNodeIds(content ?? ""),
  ]);
}

async function embedNewNodes(
  context: CopilotzProcessorContext,
  input: Readonly<{
    embed?: CreateLongTermMemoryPluginOptions["embed"];
    agent: Agent;
    thread: ConversationThread;
    checkpointId: string;
    texts: readonly string[];
  }>,
): Promise<readonly (readonly number[] | null)[]> {
  if (!input.embed || !input.texts.length) {
    return Object.freeze(input.texts.map(() => null));
  }
  const embeddings = await input.embed(input.texts, {
    agent: input.agent,
    thread: input.thread,
    checkpointId: input.checkpointId,
    context,
  });
  if (
    embeddings.length !== input.texts.length ||
    embeddings.some((embedding) => !finiteEmbedding(embedding))
  ) {
    throw new Error("Memory embedder returned invalid vectors.");
  }
  return Object.freeze(embeddings.map((embedding) => [...embedding]));
}

function meanEmbedding(
  embeddings: readonly (readonly number[] | null)[],
): readonly number[] | null {
  const available = embeddings.filter(finiteEmbedding);
  if (!available.length) return null;
  const dimensions = available[0].length;
  if (available.some((embedding) => embedding.length !== dimensions)) {
    throw new Error("Memory embeddings have inconsistent dimensions.");
  }
  return Object.freeze(
    Array.from(
      { length: dimensions },
      (_, index) =>
        available.reduce((sum, embedding) => sum + embedding[index], 0) /
        available.length,
    ),
  );
}

function memoryReservationProcessor(
  config: LongTermMemoryConfig,
): Processor<CopilotzProcessorContext> {
  return defineProcessor<CopilotzProcessorContext>({
    id: "copilotz.memory.reserve",
    on: ["message.created"],
    delivery: "durable",
    filter: (event) => event.visibility?.kind !== "internal",
    async handle(event, context) {
      if (!event.durable || !event.threadId || !event.subject) return;
      const message = await context.conversation.getMessage(event.subject.id);
      if (!message || message.sender.participantType !== "agent") return;
      const agentId = participantAgentId(message.sender);
      if (!context.resources.get<Agent>("agents", agentId)) return;
      if (
        (await checkpoints(context, message.threadId, agentId, "pending"))
          .length
      ) {
        return;
      }
      const spaces = await ensureWritableMemorySpace(context, message.threadId);
      const previous = await latestAccessibleReadyCheckpoint(
        context,
        message.threadId,
        agentId,
        spaces,
      );
      const history = await context.conversation.listMessages(
        message.threadId,
        {
          limit: 1_000,
        },
      );
      const sources = await sourceMessages(context, history);
      const range = selectLongTermMemoryRange({
        messages: sources,
        triggerMessageId: message.id,
        previousBoundaryMessageId: optionalText(previous?.sourceEndMessageId),
        triggerEstimatedTokens: config.triggerEstimatedTokens,
        retainRecentEstimatedTokens: config.retainRecentEstimatedTokens,
      });
      if (!range) return;
      const writable = spaces.filter((space) => space.access === "read_write");
      const defaultSpace = spaces.find((space) => space.defaultWrite);
      if (!writable.length || !defaultSpace) {
        throw new Error("Thread has no default writable memory space.");
      }
      const sequence = checkpointSequence(previous ?? {} as CollectionRecord) +
        1;
      const id = `memory:${message.threadId}:${agentId}:${sequence}`;
      try {
        await collection(context, longTermMemoryCollection.name).create({
          id,
          name: `Thread ${message.threadId} / ${agentId} / ${sequence}`,
          threadId: message.threadId,
          schemaVersion: "3",
          strategy: "checkpointed_graph",
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
        ) {
          return;
        }
        throw error;
      }
    },
  });
}

function memoryConsolidationProcessor(
  options: CreateLongTermMemoryPluginOptions,
  config: LongTermMemoryConfig,
  consolidate: MemoryConsolidator,
): Processor<CopilotzProcessorContext> {
  return defineProcessor<CopilotzProcessorContext>({
    id: "copilotz.memory.consolidate",
    on: ["long_term_memory.created"],
    delivery: "durable",
    async handle(event, context) {
      if (!event.durable || !event.subject) return;
      const checkpointId = event.subject.id;
      const checkpointCollection = collection(
        context,
        longTermMemoryCollection.name,
      );
      const checkpoint = await checkpointCollection.get(checkpointId);
      if (!checkpoint || checkpointStatus(checkpoint) !== "pending") return;
      const threadId = requiredText(checkpoint.threadId, "Memory thread ID");
      const agentId = requiredText(checkpoint.agentId, "Memory agent ID");
      let logicalAttemptId: string | undefined;
      try {
        const thread = await context.conversation.getThread(threadId);
        if (!thread) {
          throw new Error(`Memory thread '${threadId}' was not found.`);
        }
        const participantId = requiredText(
          record(checkpoint.metadata).agentParticipantId,
          "Memory agent participant ID",
        );
        const participant = await context.conversation.getParticipant(
          participantId,
        );
        if (!participant || participant.participantType !== "agent") {
          throw new Error("Memory checkpoint has no agent participant.");
        }
        const agent = context.resources.require<Agent>("agents", agentId);
        const spaces = await threadMemorySpaces(context, threadId);
        const readableIds = new Set(spaces.map((space) => space.id));
        const checkpointReadable = Array.isArray(checkpoint.readMemorySpaceIds)
          ? checkpoint.readMemorySpaceIds.filter((id): id is string =>
            typeof id === "string" && readableIds.has(id)
          )
          : [];
        const checkpointWritable = new Set(
          Array.isArray(checkpoint.writeMemorySpaceIds)
            ? checkpoint.writeMemorySpaceIds.filter((id): id is string =>
              typeof id === "string" &&
              spaces.some((space) =>
                space.id === id && space.access === "read_write"
              )
            )
            : [],
        );
        const defaultSpaceId = optionalText(
          checkpoint.defaultWriteMemorySpaceId,
        );
        const activeSpaces = spaces.filter((space) =>
          checkpointReadable.includes(space.id)
        ).map((space) =>
          Object.freeze({
            ...space,
            defaultWrite: space.id === defaultSpaceId &&
              checkpointWritable.has(space.id),
          })
        );
        if (
          !activeSpaces.length || !activeSpaces.some((space) =>
            space.access === "read_write"
          ) || !activeSpaces.some((space) => space.defaultWrite)
        ) {
          throw new Error(
            "Memory checkpoint has no accessible writable space.",
          );
        }
        const previous = await latestAccessibleReadyCheckpoint(
          context,
          threadId,
          agentId,
          spaces,
          checkpointSequence(checkpoint),
        );
        const previousContent = await resolvedCheckpointContent(
          context,
          previous,
        );
        const previousContinuity = readContinuity(
          record(previous?.metadata).continuity,
        );
        const pinnedIds = checkpointVisibleIds(previous, previousContent);
        const allMessages = await context.conversation.listMessages(threadId, {
          limit: 1_000,
        });
        const start = allMessages.findIndex((message) =>
          message.id === checkpoint.sourceStartMessageId
        );
        const end = allMessages.findIndex((message) =>
          message.id === checkpoint.sourceEndMessageId
        );
        if (start < 0 || end < start) {
          throw new Error("Reserved memory message range is unavailable.");
        }
        const rangeMessages = allMessages.slice(start, end + 1);
        const sources = await sourceMessages(context, rangeMessages);
        const sourceIds = new Set(sources.map((message) => message.id));
        const query = sources.map((message) => message.text).join("\n");
        const older = await retrieveOlderBrainNodes(context, {
          agent,
          thread,
          checkpointId,
          query,
          spaces: activeSpaces,
          pinnedIds,
          limit: config.retrievalLimit,
          embed: options.embed,
        });
        const olderIds = new Set(older.map((item) => item.node.id));
        for (const id of pinnedIds) olderIds.add(id);
        let proposal = await proposalFromCompletedAttempt(
          context,
          threadId,
          checkpointId,
          sourceIds,
          olderIds,
          activeSpaces,
        );
        if (!proposal) {
          const workflow = withWorkflowMetadata({
            memoryCheckpointId: checkpointId,
          }, {
            kind: "memory_consolidation",
            agentParticipantId: participant.id,
          });
          logicalAttemptId = `${checkpointId}:llm:${context.delivery.attempts}`;
          await context.llmAttempts.create({
            id: logicalAttemptId,
            threadId,
            participantId: participant.id,
            agentId,
            inputMessageIds: sources.map((message) => message.id),
            availableToolIds: [],
            status: "running",
            metadata: workflow,
          }, {
            operationKey: `memory-attempt:${logicalAttemptId}:create`,
            metadata: workflow,
          });
          const attempt = await context.llmAttempts.get(logicalAttemptId);
          if (!attempt) throw new Error("Memory LLM attempt was not created.");
          const transcript = await buildTextTranscript(context, {
            threadId,
            messageIds: sources.map((message) => message.id),
            participantId: participant.id,
          });
          const result = await consolidate({
            agent,
            participant,
            attempt,
            thread,
            messages: transcript,
            sourceMessages: sources,
            spaces: activeSpaces,
            olderNodeIds: olderIds,
            ...(previousContent ? { previousContent } : {}),
            sourceEvent: event,
            context,
          });
          proposal = parseMemoryConsolidationProposal(
            JSON.stringify(result.proposal),
            sourceIds,
            olderIds,
            {
              writableMemorySpaceIds: new Set(
                activeSpaces
                  .filter((space) => space.access === "read_write")
                  .map((space) => space.id),
              ),
              defaultWriteMemorySpaceId: activeSpaces.find((space) =>
                space.defaultWrite
              )!.id,
            },
          );
          await completeLogicalAttempt(context, logicalAttemptId, {
            ...result,
            proposal,
          });
        }

        const continuity = applyContinuityPatch(
          previousContinuity ?? createEmptyContinuity(),
          proposal.continuityPatch,
        );
        const defaultWriteSpaceId = activeSpaces.find((space) =>
          space.defaultWrite
        )!.id;
        const working = createWorkingMemoryNodeDrafts(
          continuity,
          defaultWriteSpaceId,
        );
        const drafts = [
          ...proposal.nodes.map((node) => ({
            localId: node.localId,
            kind: node.kind,
            name: node.name,
            content: node.content,
            sourceMessageIds: node.sourceMessageIds,
            memorySpaceId: node.memorySpaceId,
            sourceField: null,
            layer: "knowledge" as const,
            confidence: node.confidence ?? null,
            supersedesNodeId: node.supersedesNodeId ?? null,
          })),
          ...working.map((node) => ({
            ...node,
            layer: "working" as const,
            confidence: null,
            supersedesNodeId: null,
          })),
        ];
        const embeddings = await embedNewNodes(context, {
          embed: options.embed,
          agent,
          thread,
          checkpointId,
          texts: drafts.map((node) => node.content),
        });
        const persistedByLocalId = new Map<string, MemoryBrainNode>();
        for (let index = 0; index < drafts.length; index++) {
          const draft = drafts[index];
          const id = stableMemoryNodeId(checkpointId, draft.localId);
          const created = await collection(context, brainNodeCollection.name)
            .create({
              id,
              memorySpaceId: draft.memorySpaceId,
              checkpointId,
              createdByAgentId: agentId,
              originThreadId: threadId,
              layer: draft.layer,
              status: "active",
              kind: draft.kind,
              name: draft.name,
              content: draft.content,
              confidence: draft.confidence,
              sourceMessageIds: draft.sourceMessageIds,
              sourceField: draft.sourceField,
              embedding: embeddings[index],
              supersedesNodeId: draft.supersedesNodeId,
              metadata: {},
            }, { operationKey: `brain:create:${id}` });
          const mapped = brainNode(created);
          if (mapped) persistedByLocalId.set(draft.localId, mapped);
        }

        const olderById = new Map(
          older.map((item) => [item.node.id, item.node]),
        );
        const resolveNode = (id: string) =>
          persistedByLocalId.get(id) ?? olderById.get(id);
        for (const relation of proposal.relations) {
          const source = resolveNode(relation.source);
          const target = resolveNode(relation.target);
          if (
            !source || !target || source.memorySpaceId !== target.memorySpaceId
          ) {
            continue;
          }
          const relationId = `memory-relation:${
            encodeURIComponent(
              `${source.id}:${relation.type}:${target.id}`,
            )
          }`;
          await context.relations.create({
            id: relationId,
            type: relation.type,
            source: { type: brainNodeCollection.name, id: source.id },
            target: { type: brainNodeCollection.name, id: target.id },
            threadId,
            metadata: { checkpointId },
          }, { operationKey: `brain:relation:${relationId}` });
        }
        for (const node of proposal.nodes) {
          if (!node.supersedesNodeId) continue;
          const source = persistedByLocalId.get(node.localId);
          const target = olderById.get(node.supersedesNodeId);
          if (
            !source || !target || source.memorySpaceId !== target.memorySpaceId
          ) {
            continue;
          }
          const relationId = `memory-relation:${
            encodeURIComponent(
              `${source.id}:supersedes:${target.id}`,
            )
          }`;
          await context.relations.create({
            id: relationId,
            type: "supersedes",
            source: { type: brainNodeCollection.name, id: source.id },
            target: { type: brainNodeCollection.name, id: target.id },
            threadId,
            metadata: { checkpointId },
          }, { operationKey: `brain:supersedes:${relationId}` });
          await collection(context, brainNodeCollection.name).update(
            target.id,
            { status: "superseded" },
            { operationKey: `brain:supersede:${target.id}` },
          );
        }
        const selectedIds = new Set([
          ...older.map((item) => item.node.id),
          ...[...persistedByLocalId.values()].map((node) => node.id),
        ]);
        const olderRelations = (await context.relations.list({
          types: MEMORY_RELATION_TYPES,
          limit: 1_000,
        })).filter((relation) =>
          selectedIds.has(relation.source.id) &&
          selectedIds.has(relation.target.id)
        ).map((relation): MemoryBrainRelation =>
          Object.freeze({
            sourceNodeId: relation.source.id,
            targetNodeId: relation.target.id,
            type: relation.type,
          })
        );
        const content = renderLongTermMemory({
          proposal,
          continuity,
          newBrainNodes: persistedByLocalId,
          olderBrainNodes: older,
          olderRelations,
          maxContentEstimatedTokens: config.maxContentEstimatedTokens,
        });
        const prepared = await context.content.prepare({
          type: "text",
          text: content,
          role: "memory.snapshot",
        }, { operationKey: `checkpoint:${checkpointId}:content` });
        const checkpointEmbedding = meanEmbedding(embeddings);
        await checkpointCollection.update(checkpointId, {
          status: "ready",
          content: prepared,
          embedding: checkpointEmbedding,
          contentHash: prepared.assets[0]?.digest ?? null,
          tokenEstimate: estimateTextTokens(content),
          error: null,
          metadata: {
            ...record(checkpoint.metadata),
            processorVersion: "v3",
            continuityVersion: "1",
            continuity,
            retrievedBrainNodeIds: older.map((item) => item.node.id),
            visibleBrainNodeIds: extractVisibleBrainNodeIds(content),
          },
        }, { operationKey: `checkpoint:${checkpointId}:ready` });
      } catch (error) {
        if (logicalAttemptId) {
          const attempt = await context.llmAttempts.get(logicalAttemptId);
          if (attempt?.status === "running") {
            if (context.signal.aborted) {
              await context.llmAttempts.cancel({
                id: logicalAttemptId,
                reason: String(context.signal.reason ?? error),
              }, { operationKey: `memory-attempt:${logicalAttemptId}:cancel` })
                .catch(() => undefined);
            } else {
              const detail = await context.content.prepare({
                type: "text",
                text: error instanceof Error ? error.message : String(error),
                role: "provider.error_detail",
              }, { operationKey: `memory-attempt:${logicalAttemptId}:error` });
              await context.llmAttempts.fail({
                id: logicalAttemptId,
                safeError: safeError(error),
                errorDetail: detail,
              }, { operationKey: `memory-attempt:${logicalAttemptId}:fail` })
                .catch(() => undefined);
            }
          }
        }
        if (context.delivery.attempts >= context.delivery.maxAttempts) {
          await checkpointCollection.update(checkpointId, {
            status: "failed",
            error: {
              name: error instanceof Error ? error.name : "Error",
              message: error instanceof Error ? error.message : String(error),
            },
          }, { operationKey: `checkpoint:${checkpointId}:failed` })
            .catch(() => undefined);
        }
        throw error;
      }
    },
  });
}

function createMemoryResource(
  config: LongTermMemoryConfig,
  enabled: boolean,
): LongTermMemoryResource {
  return Object.freeze({
    id: MEMORY_RESOURCE_ID,
    name: "long_term",
    kind: "long_term",
    enabled,
    config,
    async contribute(input) {
      if (!enabled) return null;
      const spaces = await threadMemorySpaces(input.context, input.thread.id);
      const checkpoint = await latestAccessibleReadyCheckpoint(
        input.context,
        input.thread.id,
        input.agent.id,
        spaces,
      );
      const content = await resolvedCheckpointContent(
        input.context,
        checkpoint,
      );
      if (!checkpoint || !content) return null;
      return Object.freeze({
        resourceId: MEMORY_RESOURCE_ID,
        section: content,
        historyAfterMessageId: requiredText(
          checkpoint.sourceEndMessageId,
          "Memory history boundary",
        ),
      });
    },
  });
}

/** Creates checkpointed long-term memory as ordinary plugin resources. */
export function createLongTermMemoryPlugin(
  options: CreateLongTermMemoryPluginOptions = {},
): CopilotzPlugin {
  const enabled = options.enabled !== false;
  const config = normalizedConfig(options.config);
  const resource = createMemoryResource(config, enabled);
  const tools = Object.freeze([listKnowledgeSpacesTool()]);
  const consolidate = options.consolidate ?? createDefaultConsolidator(options);
  const processors = enabled
    ? Object.freeze([
      memoryReservationProcessor(config),
      memoryConsolidationProcessor(options, config, consolidate),
    ])
    : Object.freeze([] as Processor<CopilotzProcessorContext>[]);
  const collections = Object.freeze([
    memorySpaceCollection,
    memorySpaceAccessCollection,
    longTermMemoryCollection,
    brainNodeCollection,
  ]);
  return definePlugin({
    manifest: {
      id: options.id ?? DEFAULT_PLUGIN_ID,
      version: options.version ?? DEFAULT_PLUGIN_VERSION,
      provides: {
        memory: [resource.id],
        tools: tools.map((tool) => tool.key),
        processors: processors.map((processor) => processor.id),
        collections: collections.map((definition) => definition.name),
      },
    },
    resources: {
      memory: [resource],
      tools,
      processors,
      collections,
    },
  });
}
