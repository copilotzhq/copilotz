import { ulid } from "ulid";
import type {
  Agent,
  AgentLlmOptionsResolverArgs,
  Event,
  EventProcessor,
  ProcessorDeps,
} from "@/types/index.ts";
import type {
  KnowledgeEdge,
  KnowledgeNode,
  NewKnowledgeEdge,
  NewKnowledgeNode,
} from "@/database/schemas/index.ts";
import { chat, LLMProviderError } from "@/runtime/llm/index.ts";
import {
  mergeLLMRuntimeConfig,
  readRuntimeEnvironment,
  toLLMConfig,
} from "@/runtime/llm/config.ts";
import type {
  ChatMessage,
  ChatResponse,
  LLMRuntimeConfig,
  ProviderConfig,
  ToolDefinition,
} from "@/runtime/llm/types.ts";
import { assertAgentLLMConfig } from "@/resources/processors/llm_call/index.ts";
import {
  DEFAULT_EMBEDDING_MAX_INPUT_TOKENS,
  embed,
} from "@/runtime/embeddings/index.ts";
import { createLlmUsageService } from "@/runtime/collections/native.ts";
import { GRAPH_EDGE } from "@/runtime/graph/edges.ts";
import {
  getCheckpointMemorySpaceIds,
  getLatestReadyLongTermMemory,
  getLongTermMemoryConfig,
  getLongTermMemoryData,
  isLongTermMemoryAccessible,
  loadMessagesInLongTermMemoryRange,
  projectMessageForSharedMemory,
  resolveThreadMemorySpaces,
  type ThreadMemorySpaceAccess,
} from "@/runtime/memory/index.ts";
import { contextGenerator } from "@/resources/processors/new_message/generators/context-generator.ts";
import { estimateTextTokens } from "@/runtime/tokens/index.ts";

const CONSOLIDATE_MEMORY_TOOL: ToolDefinition = {
  type: "function",
  function: {
    name: "consolidate_memory",
    description: "Store a consolidated snapshot of the conversation memory. " +
      "Call this tool exactly once with your full analysis of the conversation range. " +
      "Do not call this tool during normal conversation — it is invoked only by the memory system.",
    inputTypes: `type Input = {
  /**
   * Include only fields introduced, refined, changed, or explicitly cleared
   * by this conversation range. Omitted fields retain their previous values.
   * Use null or [] only when the range explicitly clears a value.
   */
  continuityPatch: {
    intent?: {
      /** Problem, opportunity, or driving question — not the current task. */
      challenge?: SourcedValue<string | null>;
      /** Why this matters to the user or affected stakeholders. */
      purpose?: SourcedValue<string | null>;
      /** Conditions the user wants to make true — not merely an activity. */
      desiredOutcome?: SourcedValue<string | null>;
      /** Observable evidence that the desired outcome has been achieved. */
      successCriteria?: SourcedValue<string[]>;
      /** Preferences and tradeoffs used to evaluate alternatives. */
      decisionCriteria?: SourcedValue<string[]>;
      /** Non-negotiable boundaries such as time, budget, policy, or scope. */
      constraints?: SourcedValue<string[]>;
    };
    state?: {
      /** Concise description of present reality and meaningful progress. */
      currentState?: SourcedValue<string | null>;
      /** Currently selected strategy, hypothesis, or line of attack. */
      activeApproach?: SourcedValue<string | null>;
      /** Current obstacles, dependencies, or material risks. */
      risksAndBlockers?: SourcedValue<string[]>;
      /** Important unanswered questions or assumptions to validate. */
      openQuestions?: SourcedValue<string[]>;
      /** Concrete actions that can move the work forward. */
      nextActions?: SourcedValue<string[]>;
    };
  };
  items: Array<{
    /** Unique local identifier for cross-referencing in relations. */
    localId: string;
    /** One of: entity, fact, claim, decision, preference, task, event, constraint */
    kind: string;
    /** Short label (≤ 10 words). */
    name: string;
    /** Self-contained statement; no external references. */
    content: string;
    /** Confidence 0–1. */
    confidence: number;
    /** IDs of source messages that support this item. */
    sourceMessageIds: string[];
    /** ID of the writable memory space where this item belongs. */
    memorySpaceId: string;
    /** ID of an item visible in the previous checkpoint that this supersedes (optional). */
    supersedesItemId?: string;
  }>;
  relations: Array<{
    /** localId of the source item. */
    source: string;
    /** One of: related_to, supports, contradicts, depends_on, supersedes */
    type: string;
    /** localId or visible previous-checkpoint item ID of the target. */
    target: string;
  }>;
};

type SourcedValue<T> = {
  value: T;
  /** IDs from the current conversation range that justify this change. */
  sourceMessageIds: string[];
};`,
  },
};

const ITEM_KINDS = new Set([
  "entity",
  "fact",
  "claim",
  "decision",
  "preference",
  "task",
  "event",
  "constraint",
]);

const RELATION_TYPES: ReadonlySet<string> = new Set([
  GRAPH_EDGE.RELATED_TO,
  GRAPH_EDGE.SUPPORTS,
  GRAPH_EDGE.CONTRADICTS,
  GRAPH_EDGE.DEPENDS_ON,
  GRAPH_EDGE.SUPERSEDES,
]);

export interface SourcedContinuityValue<T> {
  value: T;
  sourceMessageIds: string[];
}

export interface LongTermMemoryContinuity {
  intent: {
    challenge: SourcedContinuityValue<string | null>;
    purpose: SourcedContinuityValue<string | null>;
    desiredOutcome: SourcedContinuityValue<string | null>;
    successCriteria: SourcedContinuityValue<string[]>;
    decisionCriteria: SourcedContinuityValue<string[]>;
    constraints: SourcedContinuityValue<string[]>;
  };
  state: {
    currentState: SourcedContinuityValue<string | null>;
    activeApproach: SourcedContinuityValue<string | null>;
    risksAndBlockers: SourcedContinuityValue<string[]>;
    openQuestions: SourcedContinuityValue<string[]>;
    nextActions: SourcedContinuityValue<string[]>;
  };
}

export interface LongTermMemoryContinuityPatch {
  intent?: Partial<LongTermMemoryContinuity["intent"]>;
  state?: Partial<LongTermMemoryContinuity["state"]>;
}

interface ConsolidationProposal {
  continuityPatch: LongTermMemoryContinuityPatch;
  items: Array<{
    localId: string;
    kind: string;
    name: string;
    content: string;
    confidence?: number;
    sourceMessageIds?: string[];
    memorySpaceId?: string;
    supersedesItemId?: string;
  }>;
  relations: Array<{
    source: string;
    type: string;
    target: string;
  }>;
}

interface RetrievedMemoryItem {
  node: KnowledgeNode;
  similarity: number;
}

const MEMORY_ITEM_ID_PATTERN = /^- \[id:([^\]\s]+)\]/gm;
const RRF_K = 60;
const RRF_WEIGHT = 0.1;
const CONTINUITY_VERSION = "1";

type ContinuityValueKind = "nullable_string" | "string_list";

const CONTINUITY_FIELD_KINDS = {
  intent: {
    challenge: "nullable_string",
    purpose: "nullable_string",
    desiredOutcome: "nullable_string",
    successCriteria: "string_list",
    decisionCriteria: "string_list",
    constraints: "string_list",
  },
  state: {
    currentState: "nullable_string",
    activeApproach: "nullable_string",
    risksAndBlockers: "string_list",
    openQuestions: "string_list",
    nextActions: "string_list",
  },
} as const satisfies Record<
  "intent" | "state",
  Record<string, ContinuityValueKind>
>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clampConfidence(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(1, Math.max(0, value))
    : null;
}

function isEmbedding(value: unknown): value is number[] {
  return Array.isArray(value) && value.length > 0 &&
    value.every((entry) => typeof entry === "number" && Number.isFinite(entry));
}

function emptySourcedValue<T>(value: T): SourcedContinuityValue<T> {
  return { value, sourceMessageIds: [] };
}

export function createEmptyContinuity(): LongTermMemoryContinuity {
  return {
    intent: {
      challenge: emptySourcedValue<string | null>(null),
      purpose: emptySourcedValue<string | null>(null),
      desiredOutcome: emptySourcedValue<string | null>(null),
      successCriteria: emptySourcedValue<string[]>([]),
      decisionCriteria: emptySourcedValue<string[]>([]),
      constraints: emptySourcedValue<string[]>([]),
    },
    state: {
      currentState: emptySourcedValue<string | null>(null),
      activeApproach: emptySourcedValue<string | null>(null),
      risksAndBlockers: emptySourcedValue<string[]>([]),
      openQuestions: emptySourcedValue<string[]>([]),
      nextActions: emptySourcedValue<string[]>([]),
    },
  };
}

function normalizeStringList(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const normalized = value.map((entry) =>
    typeof entry === "string" ? entry.trim() : ""
  );
  if (normalized.some((entry) => !entry)) return null;
  return normalized.filter((entry, index, values) =>
    values.indexOf(entry) === index
  );
}

function parseSourcedContinuityValue(
  candidate: unknown,
  kind: ContinuityValueKind,
  allowedSourceMessageIds?: Set<string>,
  requireSource = false,
): SourcedContinuityValue<string | null | string[]> | null {
  if (!isRecord(candidate) || !Array.isArray(candidate.sourceMessageIds)) {
    return null;
  }
  const sourceMessageIds = candidate.sourceMessageIds
    .filter((id): id is string =>
      typeof id === "string" &&
      id.length > 0 &&
      (!allowedSourceMessageIds || allowedSourceMessageIds.has(id))
    )
    .filter((id, index, ids) => ids.indexOf(id) === index);
  if (requireSource && sourceMessageIds.length === 0) return null;

  if (kind === "nullable_string") {
    if (candidate.value === null) {
      return { value: null, sourceMessageIds };
    }
    const value = typeof candidate.value === "string"
      ? candidate.value.trim()
      : "";
    return value ? { value, sourceMessageIds } : null;
  }

  const value = normalizeStringList(candidate.value);
  return value ? { value, sourceMessageIds } : null;
}

function parseContinuitySection(
  candidate: unknown,
  fieldKinds: Record<string, ContinuityValueKind>,
  allowedSourceMessageIds?: Set<string>,
  requireSource = false,
): Record<string, SourcedContinuityValue<string | null | string[]>> {
  if (candidate === undefined) return {};
  if (!isRecord(candidate)) {
    throw new Error("Invalid long-term-memory continuity section.");
  }
  const parsed: Record<
    string,
    SourcedContinuityValue<string | null | string[]>
  > = {};
  for (const [field, kind] of Object.entries(fieldKinds)) {
    if (!Object.prototype.hasOwnProperty.call(candidate, field)) continue;
    const value = parseSourcedContinuityValue(
      candidate[field],
      kind,
      allowedSourceMessageIds,
      requireSource,
    );
    if (!value) {
      throw new Error(`Invalid long-term-memory continuity field: ${field}`);
    }
    parsed[field] = value;
  }
  return parsed;
}

function parseContinuityPatch(
  candidate: unknown,
  allowedSourceMessageIds: Set<string>,
): LongTermMemoryContinuityPatch {
  if (!isRecord(candidate)) {
    throw new Error("Invalid long-term-memory continuity patch.");
  }
  return {
    ...(candidate.intent !== undefined
      ? {
        intent: parseContinuitySection(
          candidate.intent,
          CONTINUITY_FIELD_KINDS.intent,
          allowedSourceMessageIds,
          true,
        ) as LongTermMemoryContinuityPatch["intent"],
      }
      : {}),
    ...(candidate.state !== undefined
      ? {
        state: parseContinuitySection(
          candidate.state,
          CONTINUITY_FIELD_KINDS.state,
          allowedSourceMessageIds,
          true,
        ) as LongTermMemoryContinuityPatch["state"],
      }
      : {}),
  };
}

export function applyContinuityPatch(
  previous: LongTermMemoryContinuity,
  patch: LongTermMemoryContinuityPatch,
): LongTermMemoryContinuity {
  return {
    intent: {
      ...previous.intent,
      ...(patch.intent ?? {}),
    },
    state: {
      ...previous.state,
      ...(patch.state ?? {}),
    },
  };
}

function readPersistedContinuity(
  memory: Awaited<ReturnType<typeof getLatestReadyLongTermMemory>>,
): LongTermMemoryContinuity {
  const fallback = createEmptyContinuity();
  const metadata = memory && isRecord(memory.data.metadata)
    ? memory.data.metadata
    : {};
  const candidate = isRecord(metadata.continuity) ? metadata.continuity : null;
  if (!candidate) {
    const legacyWorkState = memory?.node.content?.match(
      /### Work state\s*\n([\s\S]*?)(?=\n\n### |\n\n## |$)/,
    )?.[1]?.trim();
    return legacyWorkState
      ? applyContinuityPatch(fallback, {
        state: {
          currentState: {
            value: legacyWorkState,
            sourceMessageIds: [memory!.data.sourceEndMessageId],
          },
        },
      })
      : fallback;
  }

  try {
    const intent = parseContinuitySection(
      candidate.intent,
      CONTINUITY_FIELD_KINDS.intent,
    );
    const state = parseContinuitySection(
      candidate.state,
      CONTINUITY_FIELD_KINDS.state,
    );
    return applyContinuityPatch(fallback, {
      intent: intent as LongTermMemoryContinuityPatch["intent"],
      state: state as LongTermMemoryContinuityPatch["state"],
    });
  } catch {
    return fallback;
  }
}

function continuityValueText(
  value: SourcedContinuityValue<string | null | string[]>,
): string[] {
  if (Array.isArray(value.value)) return value.value;
  return value.value ? [value.value] : [];
}

export function buildContinuityRetrievalTexts(
  continuity: LongTermMemoryContinuity,
): string[] {
  const intent = Object.entries(continuity.intent).flatMap(([field, value]) =>
    continuityValueText(value).map((text) => `${field}: ${text}`)
  );
  const state = Object.entries(continuity.state).flatMap(([field, value]) =>
    continuityValueText(value).map((text) => `${field}: ${text}`)
  );
  return [
    intent.length > 0 ? intent.join("\n") : "",
    state.length > 0 ? state.join("\n") : "",
  ].filter(Boolean);
}

export function extractVisibleMemoryItemIds(content: string): string[] {
  return [...content.matchAll(MEMORY_ITEM_ID_PATTERN)]
    .map((match) => match[1])
    .filter((id, index, ids) => ids.indexOf(id) === index);
}

function getVisibleMemoryItemIds(
  memory: Awaited<ReturnType<typeof getLatestReadyLongTermMemory>>,
): Set<string> {
  if (!memory) return new Set();
  const metadata = isRecord(memory.data.metadata) ? memory.data.metadata : {};
  const persisted = Array.isArray(metadata.visibleItemIds)
    ? metadata.visibleItemIds.filter((id): id is string =>
      typeof id === "string" && id.length > 0
    )
    : [];
  return new Set([
    ...persisted,
    ...extractVisibleMemoryItemIds(memory.node.content ?? ""),
  ]);
}

export interface EmbeddingTextChunk {
  text: string;
  characterCount: number;
}

/**
 * Packs complete message lines together where possible. A single oversized
 * line is split only when it cannot fit within the embedding model's limit.
 */
export function chunkLinesForEmbedding(
  lines: string[],
  maxEstimatedTokens: number,
): EmbeddingTextChunk[] {
  const limit = Math.max(1, Math.floor(maxEstimatedTokens));
  const chunks: EmbeddingTextChunk[] = [];
  let current = "";

  const flush = () => {
    if (!current) return;
    chunks.push({ text: current, characterCount: current.length });
    current = "";
  };

  for (const line of lines.filter((candidate) => candidate.length > 0)) {
    if (estimateTextTokens(line) > limit) {
      flush();
      let offset = 0;
      while (offset < line.length) {
        let low = 1;
        let high = line.length - offset;
        while (low < high) {
          const midpoint = Math.ceil((low + high) / 2);
          if (
            estimateTextTokens(line.slice(offset, offset + midpoint)) <= limit
          ) {
            low = midpoint;
          } else {
            high = midpoint - 1;
          }
        }
        const text = line.slice(offset, offset + low);
        chunks.push({ text, characterCount: text.length });
        offset += low;
      }
      continue;
    }

    const candidate = current ? `${current}\n${line}` : line;
    if (estimateTextTokens(candidate) > limit) flush();
    current = current ? `${current}\n${line}` : line;
  }
  flush();
  return chunks;
}

/**
 * Combines semantic directions rather than raw vector magnitudes: normalize
 * each chunk, weight it by visible characters, sum, then normalize once more.
 */
export function averageNormalizedEmbeddings(
  embeddings: number[][],
  weights: number[],
): number[] {
  if (embeddings.length === 0 || embeddings.length !== weights.length) {
    throw new Error("Embedding vectors and weights must have equal length.");
  }

  const dimensions = embeddings[0].length;
  const sum = new Array<number>(dimensions).fill(0);
  let totalWeight = 0;

  embeddings.forEach((embedding, index) => {
    if (!isEmbedding(embedding) || embedding.length !== dimensions) {
      throw new Error("Embedding vectors must have consistent dimensions.");
    }
    const weight = weights[index];
    if (!Number.isFinite(weight) || weight <= 0) return;
    const norm = Math.sqrt(
      embedding.reduce((total, value) => total + value * value, 0),
    );
    if (norm === 0) return;
    for (let dimension = 0; dimension < dimensions; dimension++) {
      sum[dimension] += (embedding[dimension] / norm) * weight;
    }
    totalWeight += weight;
  });

  if (totalWeight === 0) {
    throw new Error("Embedding aggregation requires a positive weight.");
  }
  const sumNorm = Math.sqrt(
    sum.reduce((total, value) => total + value * value, 0),
  );
  if (sumNorm === 0) {
    throw new Error("Embedding aggregation produced a zero vector.");
  }
  return sum.map((value) => value / sumNorm);
}

function parseJsonObject(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value);
    return isRecord(parsed) ? parsed : null;
  } catch {
    const match = value.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      const parsed = JSON.parse(match[0]);
      return isRecord(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
}

export function parseConsolidationProposal(
  value: string,
  allowedSourceMessageIds: Set<string>,
  allowedOlderItemIds: Set<string>,
  routing?: {
    writableMemorySpaceIds: Set<string>;
    defaultWriteMemorySpaceId: string;
  },
): ConsolidationProposal {
  const parsed = parseJsonObject(value);
  if (!parsed) {
    throw new Error("Invalid long-term-memory consolidation response.");
  }
  const continuityPatch = parseContinuityPatch(
    parsed.continuityPatch,
    allowedSourceMessageIds,
  );

  const localIds = new Set<string>();
  const items = (Array.isArray(parsed.items) ? parsed.items : []).flatMap(
    (candidate): ConsolidationProposal["items"] => {
      if (!isRecord(candidate)) return [];
      const localId = typeof candidate.localId === "string"
        ? candidate.localId.trim()
        : "";
      const kind = typeof candidate.kind === "string"
        ? candidate.kind.trim()
        : "";
      const name = typeof candidate.name === "string"
        ? candidate.name.trim()
        : "";
      const content = typeof candidate.content === "string"
        ? candidate.content.trim()
        : "";
      if (
        !localId || localIds.has(localId) || !ITEM_KINDS.has(kind) || !name ||
        !content
      ) {
        return [];
      }
      localIds.add(localId);
      const sourceMessageIds = Array.isArray(candidate.sourceMessageIds)
        ? candidate.sourceMessageIds.filter((id): id is string =>
          typeof id === "string" && allowedSourceMessageIds.has(id)
        )
        : [];
      const supersedesItemId = typeof candidate.supersedesItemId === "string" &&
          allowedOlderItemIds.has(candidate.supersedesItemId)
        ? candidate.supersedesItemId
        : undefined;
      const confidence = clampConfidence(candidate.confidence);
      const requestedMemorySpaceId = typeof candidate.memorySpaceId === "string"
        ? candidate.memorySpaceId.trim()
        : "";
      const memorySpaceId = routing
        ? routing.writableMemorySpaceIds.has(requestedMemorySpaceId)
          ? requestedMemorySpaceId
          : routing.defaultWriteMemorySpaceId
        : requestedMemorySpaceId || undefined;
      return [{
        localId,
        kind,
        name,
        content,
        ...(confidence !== null ? { confidence } : {}),
        sourceMessageIds,
        ...(memorySpaceId ? { memorySpaceId } : {}),
        ...(supersedesItemId ? { supersedesItemId } : {}),
      }];
    },
  );

  const validTargets = new Set([...localIds, ...allowedOlderItemIds]);
  const relations = (Array.isArray(parsed.relations) ? parsed.relations : [])
    .flatMap((candidate): ConsolidationProposal["relations"] => {
      if (!isRecord(candidate)) return [];
      const source = typeof candidate.source === "string"
        ? candidate.source.trim()
        : "";
      const type = typeof candidate.type === "string"
        ? candidate.type.trim()
        : "";
      const target = typeof candidate.target === "string"
        ? candidate.target.trim()
        : "";
      if (
        !localIds.has(source) || !RELATION_TYPES.has(type) ||
        !validTargets.has(target) || source === target
      ) {
        return [];
      }
      return [{ source, type, target }];
    });

  return {
    continuityPatch,
    items,
    relations,
  };
}

interface ConsolidationValidationFailure {
  errorMessage: string;
  response: ChatResponse;
}

function responseDebugSnapshot(
  response: ChatResponse,
): Record<string, unknown> {
  if (response.debug) return { ...response.debug };
  return {
    inputMessages: response.prompt,
    rawOutput: {
      content: response.answer,
      currentAttemptContent: response.answer,
      ...(response.reasoning ? { reasoning: response.reasoning } : {}),
    },
    parsedOutput: {
      answer: response.answer,
      ...(response.reasoning ? { reasoning: response.reasoning } : {}),
      toolCalls: response.toolCalls ?? [],
      extractedTags: response.extractedTags ?? {},
      finishReason: response.finishReason ?? null,
    },
  };
}

function buildConsolidationDebug(
  response: ChatResponse | null,
  validationFailures: ConsolidationValidationFailure[],
): Record<string, unknown> | null {
  if (!response) return null;
  const providerAttempts = (response.usageAttempts ?? []).map((attempt) => ({
    provider: attempt.provider ?? null,
    model: attempt.model ?? null,
    usage: attempt.usage,
    cost: attempt.cost ?? null,
    visibleOutputStarted: attempt.visibleOutputStarted ?? false,
    partialAnswer: attempt.partialAnswer ?? null,
    partialReasoning: attempt.partialReasoning ?? null,
    error: attempt.error ?? null,
    debug: attempt.debug ?? null,
  }));
  if (validationFailures.length === 0 && providerAttempts.length <= 1) {
    return responseDebugSnapshot(response);
  }
  return {
    ...responseDebugSnapshot(response),
    consolidation: {
      repairAttempted: validationFailures.length > 0,
      providerAttempts,
      rejectedValidationAttempts: validationFailures.map(
        (failure, attemptIndex) => ({
          attemptIndex,
          error: { message: failure.errorMessage },
          provider: failure.response.provider ?? null,
          model: failure.response.model ?? null,
          usage: failure.response.usage ?? null,
          cost: failure.response.cost ?? null,
          debug: responseDebugSnapshot(failure.response),
        }),
      ),
    },
  };
}

function buildConsolidationRepairMessages(
  messages: ChatMessage[],
  response: ChatResponse,
  error: unknown,
): ChatMessage[] {
  const message = error instanceof Error ? error.message : String(error);
  return [
    ...messages,
    { role: "assistant", content: response.answer },
    {
      role: "user",
      content: [
        "Your previous consolidation response failed validation.",
        `Validation error: ${message}`,
        "Return the complete corrected JSON object now.",
        "Preserve every valid memory item and relation from the previous response.",
        "Every changed continuity field must use { value, sourceMessageIds }, and sourceMessageIds must come from the conversation range.",
        "Output ONLY the JSON object — no markdown, no explanation.",
      ].join("\n"),
    },
  ];
}

function isRetryableLlmReason(reason: string | null): boolean {
  return reason === "rate_limit" ||
    reason === "timeout" ||
    reason === "network" ||
    reason === "auth_error" ||
    reason === "server_error" ||
    reason === "provider_error" ||
    reason === "unknown";
}

function serializeConsolidationError(
  error: unknown,
  config: ProviderConfig | null,
  response: ChatResponse | null,
  validationFailures: ConsolidationValidationFailure[],
): Record<string, unknown> {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof LLMProviderError) {
    return {
      message,
      reason: error.reason,
      provider: error.provider ?? null,
      model: error.model ?? null,
      status: error.status ?? null,
      retryable: isRetryableLlmReason(error.reason),
      fallbackAttempted: error.fallbackAttempted,
      fallbackCount: Math.max(0, error.attempts.length - 1),
      visibleStreamStarted: error.visibleStreamStarted,
      attempts: error.attempts.map((attempt) => ({
        provider: attempt.provider,
        model: attempt.model ?? null,
        reason: attempt.reason ?? null,
        status: attempt.status ?? null,
        message: attempt.message ?? null,
      })),
      validationRepairAttempted: validationFailures.length > 0,
    };
  }
  const responseAttempts = (response?.usageAttempts ?? []).map((attempt) => ({
    provider: attempt.provider ?? response?.provider ?? config?.provider ??
      "unknown",
    model: attempt.model ?? null,
    reason: attempt.error?.reason ?? attempt.usage.statusReason ?? null,
    status: attempt.error?.status ?? null,
    message: attempt.error?.message ?? null,
  }));
  return {
    message,
    reason: validationFailures.length > 0 ? "invalid_response" : null,
    provider: response?.provider ?? config?.provider ?? null,
    model: response?.model ?? config?.model ?? null,
    status: null,
    retryable: validationFailures.length > 0,
    fallbackAttempted: responseAttempts.length > 1,
    fallbackCount: Math.max(0, responseAttempts.length - 1),
    visibleStreamStarted: (response?.usageAttempts ?? []).some((attempt) =>
      attempt.visibleOutputStarted
    ),
    attempts: responseAttempts,
    validationRepairAttempted: validationFailures.length > 0,
  };
}

function itemLabel(node: KnowledgeNode): string {
  const data = isRecord(node.data) ? node.data : {};
  const kind = typeof data.kind === "string" ? data.kind : "memory";
  return `[id:${node.id}] [${kind}] ${node.name}: ${node.content ?? ""}`.trim();
}

function renderRelationship(
  source: string,
  type: string,
  target: string,
): string {
  return `- ${source} --${type}--> ${target}`;
}

function renderContinuityScalar(
  label: string,
  value: SourcedContinuityValue<string | null>,
): string[] {
  return value.value ? [`- ${label}: ${value.value}`] : [];
}

function renderContinuityList(
  label: string,
  value: SourcedContinuityValue<string[]>,
): string[] {
  return value.value.length > 0
    ? value.value.map((entry) => `- ${label}: ${entry}`)
    : [];
}

function renderContinuityBlocks(
  continuity: LongTermMemoryContinuity,
): string[] {
  const intent = [
    ...renderContinuityScalar("Challenge", continuity.intent.challenge),
    ...renderContinuityScalar("Purpose", continuity.intent.purpose),
    ...renderContinuityScalar(
      "Desired outcome",
      continuity.intent.desiredOutcome,
    ),
    ...renderContinuityList(
      "Success criteria",
      continuity.intent.successCriteria,
    ),
    ...renderContinuityList(
      "Decision criteria",
      continuity.intent.decisionCriteria,
    ),
    ...renderContinuityList("Constraints", continuity.intent.constraints),
  ];
  const state = [
    ...renderContinuityScalar("Current state", continuity.state.currentState),
    ...renderContinuityScalar(
      "Active approach",
      continuity.state.activeApproach,
    ),
    ...renderContinuityList(
      "Risks and blockers",
      continuity.state.risksAndBlockers,
    ),
    ...renderContinuityList(
      "Open questions",
      continuity.state.openQuestions,
    ),
    ...renderContinuityList("Next actions", continuity.state.nextActions),
  ];
  return [
    "## CONTINUITY",
    "### Intent",
    ...(intent.length > 0 ? intent : ["- No explicit intent recorded."]),
    "### Current state",
    ...(state.length > 0 ? state : ["- No explicit current state recorded."]),
  ];
}

export function renderLongTermMemory(args: {
  proposal: ConsolidationProposal;
  continuity: LongTermMemoryContinuity;
  newItemNodes: Map<string, KnowledgeNode>;
  olderItems: RetrievedMemoryItem[];
  olderRelations: KnowledgeEdge[];
  maxContentEstimatedTokens: number;
}): string {
  const { proposal, newItemNodes, olderItems, olderRelations } = args;
  const olderItemNames = new Map(
    olderItems.map((item) => [String(item.node.id), item.node.name]),
  );
  const superseded = new Set(
    proposal.items.flatMap((item) =>
      item.supersedesItemId ? [item.supersedesItemId] : []
    ),
  );
  const relevant = [
    ...proposal.items.map((item) => {
      const node = newItemNodes.get(item.localId);
      return `- [id:${
        node?.id ?? item.localId
      }] [${item.kind}] ${item.name}: ${item.content}`;
    }),
    ...olderItems
      .filter((item) => !superseded.has(String(item.node.id)))
      .map((item) => `- ${itemLabel(item.node)}`),
  ];

  const relationLines = [
    ...proposal.relations.map((relation) => {
      const source = newItemNodes.get(relation.source)?.name ?? relation.source;
      const target = newItemNodes.get(relation.target)?.name ??
        olderItems.find((item) => String(item.node.id) === relation.target)
          ?.node.name ??
        relation.target;
      return renderRelationship(source, relation.type, target);
    }),
    ...olderRelations.map((edge) =>
      renderRelationship(
        olderItemNames.get(String(edge.sourceNodeId)) ??
          String(edge.sourceNodeId),
        String(edge.type),
        olderItemNames.get(String(edge.targetNodeId)) ??
          String(edge.targetNodeId),
      )
    ),
  ];

  const blocks = [
    "## LONG-TERM CONVERSATION MEMORY",
    ...renderContinuityBlocks(args.continuity),
    "## RELEVANT MEMORY",
    ...(relevant.length > 0 ? relevant : ["- No durable memory items."]),
    "## RELATIONSHIPS",
    ...(relationLines.length > 0
      ? relationLines
      : ["- No explicit relationships."]),
  ];
  const retained: string[] = [];
  for (const block of blocks) {
    const candidate = [...retained, block].join("\n");
    if (
      estimateTextTokens(candidate) <= args.maxContentEstimatedTokens
    ) retained.push(block);
  }
  return retained.join("\n");
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function resolveMemoryLlmConfig(args: {
  agent: Agent;
  messages: ChatMessage[];
  event: Event;
  deps: ProcessorDeps;
}): Promise<ProviderConfig> {
  const { agent, messages, event, deps } = args;
  let agentRuntimeConfig: LLMRuntimeConfig = {};
  if (typeof agent.llmOptions === "function") {
    const payload = {
      agent: { id: agent.id, name: agent.name },
      messages,
      tools: [],
      config: {},
    } as AgentLlmOptionsResolverArgs["payload"];
    agentRuntimeConfig = await agent.llmOptions({
      payload,
      sourceEvent: event,
      deps,
    });
  } else if (agent.llmOptions) {
    agentRuntimeConfig = agent.llmOptions;
  }

  const persistedConfig = toLLMConfig(agentRuntimeConfig);
  const securityRuntimeConfig = await deps.context.security
    ?.resolveLLMRuntimeConfig?.({
      provider: persistedConfig.provider,
      model: persistedConfig.model,
      agent: { id: agent.id, name: agent.name },
      config: persistedConfig,
      sourceEvent: event,
      deps,
    });
  const resolved = mergeLLMRuntimeConfig(
    persistedConfig,
    agentRuntimeConfig,
    securityRuntimeConfig,
    {
      outputReasoning: false,
      responseType: "json",
    },
  );
  assertAgentLLMConfig(agent, resolved);
  return resolved;
}

async function buildConsolidationContext(args: {
  agent: Agent;
  deps: ProcessorDeps;
  conversation: string;
  memorySpaces: ThreadMemorySpaceAccess[];
  defaultWriteMemorySpaceId: string;
  previousMemory: Awaited<
    ReturnType<typeof getLatestReadyLongTermMemory>
  >;
  previousContinuity: LongTermMemoryContinuity;
}): Promise<{ messages: ChatMessage[]; tools: ToolDefinition[] }> {
  const { agent, deps } = args;

  // Build exactly the same system prompt the agent uses in regular chat turns
  // (no consolidation-specific additions) so the provider can reuse its KV
  // cache on the full stable prefix.
  const llmContext = contextGenerator(
    agent,
    deps.thread,
    deps.context.agents ?? [],
    deps.context.agents ?? [],
  );
  let systemPrompt = llmContext.systemPrompt;
  if (args.previousMemory?.node.content) {
    systemPrompt = `${systemPrompt}\n\n${args.previousMemory.node.content}`;
  }

  // All consolidation-specific content lives in the user message so the
  // system prompt above stays cache-stable across consolidation calls.
  // We use JSON output mode (responseType:"json") so the model reliably
  // returns structured data without needing any format training in the
  // system prompt.
  const reconciliationInstruction = args.previousMemory?.node.content
    ? "You may supersede or relate only older memory item IDs shown in the previous checkpoint above."
    : "There is no previous checkpoint; relations may target only new localIds.";
  const writableMemorySpaces = args.memorySpaces
    .filter((space) => space.access === "read_write")
    .map((space) => {
      const data = isRecord(space.node.data) ? space.node.data : {};
      return {
        id: String(space.node.id),
        name: space.node.name,
        description: space.node.content ?? null,
        scopeType: typeof data.scopeType === "string"
          ? data.scopeType
          : typeof data.kind === "string"
          ? data.kind
          : "custom",
        defaultWrite: String(space.node.id) ===
          args.defaultWriteMemorySpaceId,
      };
    });
  const userContent = [
    "Previous structured continuity:",
    JSON.stringify(args.previousContinuity),
    "",
    "Conversation range to consolidate:",
    args.conversation,
    "",
    "---",
    "Update continuity and extract durable memory from the conversation range above.",
    "Continuity must let another capable agent resume the work after archived messages are unavailable.",
    "Do not produce a chronological summary.",
    "For continuity, emit only fields introduced, refined, changed, or explicitly cleared by this range.",
    "Omit unchanged continuity fields so the processor retains their previous values exactly.",
    "When updating a list field, return its complete new value, including prior entries that remain active.",
    "Never infer missing intent. Use null or [] only when this range explicitly clears a value.",
    "Keep the challenge distinct from the current task and the desired outcome distinct from an activity.",
    "Keep unresolved blockers, questions, and actions until the range explicitly changes or resolves them.",
    reconciliationInstruction,
    "Assign every new item to exactly one writable memory space from this catalog.",
    `Writable memory spaces: ${JSON.stringify(writableMemorySpaces)}`,
    `If uncertain, use the default memory space ID: ${args.defaultWriteMemorySpaceId}`,
    "Output ONLY the JSON object — no markdown, no explanation.",
    "",
    "Schema:",
    CONSOLIDATE_MEMORY_TOOL.function.inputTypes,
  ].join("\n");

  return {
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userContent },
    ],
    tools: [],
  };
}

export interface RankedMemoryCandidate {
  id: string;
  similarity: number;
}

export function fuseMemoryCandidateRanks(
  candidateLists: RankedMemoryCandidate[][],
  limit: number,
): string[] {
  const scores = new Map<
    string,
    { maxSimilarity: number; reciprocalRank: number }
  >();
  for (const candidates of candidateLists) {
    candidates.forEach((candidate, index) => {
      const current = scores.get(candidate.id) ?? {
        maxSimilarity: 0,
        reciprocalRank: 0,
      };
      current.maxSimilarity = Math.max(
        current.maxSimilarity,
        candidate.similarity,
      );
      current.reciprocalRank += 1 / (RRF_K + index + 1);
      scores.set(candidate.id, current);
    });
  }
  return [...scores.entries()]
    .sort(([leftId, left], [rightId, right]) => {
      const leftScore = left.maxSimilarity +
        RRF_WEIGHT * (RRF_K + 1) * left.reciprocalRank;
      const rightScore = right.maxSimilarity +
        RRF_WEIGHT * (RRF_K + 1) * right.reciprocalRank;
      return rightScore - leftScore || leftId.localeCompare(rightId);
    })
    .slice(0, Math.max(0, limit))
    .map(([id]) => id);
}

async function retrieveOlderMemory(args: {
  deps: ProcessorDeps;
  namespace: string;
  memorySpaceIds: string[];
  agentId: string;
  queryEmbeddings: number[][];
  pinnedItemIds?: string[];
  limit: number;
}): Promise<{
  items: RetrievedMemoryItem[];
  relations: KnowledgeEdge[];
}> {
  const memorySpaceIds = new Set(args.memorySpaceIds);
  const resultLists = await Promise.all(
    args.queryEmbeddings.map((embedding) =>
      args.deps.db.ops.unsafeGraph.searchNodes({
        embedding,
        namespaces: [args.namespace],
        nodeTypes: ["memory_item"],
        dataFilters: {
          createdByAgentId: args.agentId,
        },
        dataFilterAny: {
          memorySpaceId: args.memorySpaceIds,
        },
        excludeWithIncomingEdgeTypes: [GRAPH_EDGE.SUPERSEDES],
        limit: Math.max(args.limit * 3, args.limit),
        minSimilarity: 0.2,
      })
    ),
  );
  const candidateLists = resultLists.map((results) =>
    results.flatMap((result): RetrievedMemoryItem[] => {
      const data = isRecord(result.node.data) ? result.node.data : {};
      return typeof data.memorySpaceId === "string" &&
          memorySpaceIds.has(data.memorySpaceId) &&
          data.createdByAgentId === args.agentId
        ? [{ node: result.node, similarity: result.similarity ?? 0 }]
        : [];
    })
  );
  const candidateById = new Map<string, RetrievedMemoryItem>();
  for (const candidate of candidateLists.flat()) {
    const id = String(candidate.node.id);
    const current = candidateById.get(id);
    if (!current || candidate.similarity > current.similarity) {
      candidateById.set(id, candidate);
    }
  }
  const rankedIds = fuseMemoryCandidateRanks(
    candidateLists.map((candidates) =>
      candidates.map((candidate) => ({
        id: String(candidate.node.id),
        similarity: candidate.similarity,
      }))
    ),
    args.limit,
  );

  const itemById = new Map<string, RetrievedMemoryItem>();
  const pinnedIds = [...new Set(args.pinnedItemIds ?? [])];
  const pinnedNodes = await Promise.all(
    pinnedIds.map((id) => args.deps.db.ops.unsafeGraph.getNodeById(id)),
  );
  for (const node of pinnedNodes) {
    const data = node && isRecord(node.data) ? node.data : {};
    const supersedingEdges = node
      ? await args.deps.db.ops.unsafeGraph.getEdgesForNode(
        String(node.id),
        "in",
        [GRAPH_EDGE.SUPERSEDES],
      )
      : [];
    if (
      node?.type === "memory_item" &&
      node.namespace === args.namespace &&
      typeof data.memorySpaceId === "string" &&
      memorySpaceIds.has(data.memorySpaceId) &&
      data.createdByAgentId === args.agentId &&
      supersedingEdges.length === 0
    ) {
      itemById.set(String(node.id), {
        node,
        similarity: candidateById.get(String(node.id))?.similarity ?? 0,
      });
    }
  }
  for (const id of rankedIds) {
    if (itemById.size >= args.limit) break;
    const candidate = candidateById.get(id);
    if (candidate) itemById.set(id, candidate);
  }

  const relationById = new Map<string, KnowledgeEdge>();
  for (const item of [...itemById.values()]) {
    const edges = await args.deps.db.ops.unsafeGraph.getEdgesForNode(
      String(item.node.id),
      "both",
      [...RELATION_TYPES],
    );
    for (const edge of edges) {
      const sourceId = String(edge.sourceNodeId);
      const targetId = String(edge.targetNodeId);
      const otherId = sourceId === String(item.node.id) ? targetId : sourceId;
      const pointsToSupersededItem = edge.type === GRAPH_EDGE.SUPERSEDES &&
        sourceId === String(item.node.id);
      if (
        !pointsToSupersededItem &&
        !itemById.has(otherId) &&
        itemById.size < args.limit
      ) {
        const related = await args.deps.db.ops.unsafeGraph.getNodeById(otherId);
        const relatedData = related && isRecord(related.data)
          ? related.data
          : {};
        if (
          related?.type === "memory_item" &&
          typeof relatedData.memorySpaceId === "string" &&
          memorySpaceIds.has(relatedData.memorySpaceId) &&
          relatedData.memorySpaceId === memoryItemSpaceId(item.node) &&
          relatedData.createdByAgentId === args.agentId
        ) {
          itemById.set(otherId, { node: related, similarity: 0 });
        }
      }
      if (
        itemById.has(sourceId) &&
        itemById.has(targetId) &&
        memoryItemSpaceId(itemById.get(sourceId)?.node) ===
          memoryItemSpaceId(itemById.get(targetId)?.node)
      ) {
        relationById.set(String(edge.id), edge);
      }
    }
  }
  return {
    items: [...itemById.values()],
    relations: [...relationById.values()],
  };
}

function memoryItemSpaceId(
  node: KnowledgeNode | null | undefined,
): string | null {
  const data = node && isRecord(node.data) ? node.data : {};
  return typeof data.memorySpaceId === "string" ? data.memorySpaceId : null;
}

function constrainProposalToMemorySpaces(
  proposal: ConsolidationProposal,
  olderItems: RetrievedMemoryItem[],
): ConsolidationProposal {
  const localSpaces = new Map(
    proposal.items.map((item) => [item.localId, item.memorySpaceId ?? null]),
  );
  const olderSpaces = new Map(
    olderItems.map((item) => [
      String(item.node.id),
      memoryItemSpaceId(item.node),
    ]),
  );
  const items = proposal.items.map((item) => {
    if (
      item.supersedesItemId &&
      olderSpaces.get(item.supersedesItemId) !== item.memorySpaceId
    ) {
      const { supersedesItemId: _supersedesItemId, ...rest } = item;
      return rest;
    }
    return item;
  });
  const relations = proposal.relations.filter((relation) => {
    const sourceSpace = localSpaces.get(relation.source);
    const targetSpace = localSpaces.get(relation.target) ??
      olderSpaces.get(relation.target);
    return Boolean(sourceSpace && sourceSpace === targetSpace);
  });
  return { ...proposal, items, relations };
}

async function persistAttemptStart(args: {
  event: Event;
  deps: ProcessorDeps;
  threadId: string;
  namespace: string;
  agent: Agent;
  config: ProviderConfig;
  messages: ChatMessage[];
}): Promise<string | null> {
  try {
    const attempt = await args.deps.db.ops.mutate.llmAttempts.create({
      threadId: args.threadId,
      eventId: typeof args.event.id === "string" ? args.event.id : null,
      agentId: args.agent.id,
      agentName: args.agent.name,
      provider: args.config.provider ?? null,
      model: args.config.model ?? null,
      config: toLLMConfig(args.config) as Record<string, unknown>,
      messages: args.messages,
      tools: [],
      status: "processing",
      namespace: args.namespace,
      metadata: {
        source: "long_term_memory",
        sourceEventType: args.event.type,
      },
    }, {
      traceId: typeof args.event.traceId === "string"
        ? args.event.traceId
        : null,
      causationId: typeof args.event.id === "string" ? args.event.id : null,
      namespace: args.namespace,
    });
    return String(attempt.id);
  } catch (error) {
    console.warn(
      "[long_term_memory] Failed to create consolidation llm_attempt:",
      error,
    );
    return null;
  }
}

export const longTermMemoryProcessor: EventProcessor<
  unknown,
  ProcessorDeps
> = {
  shouldProcess: (event) =>
    (event as unknown as { type: string }).type ===
      "long_term_memory.created",

  process: async (event, deps) => {
    const checkpointId = typeof event.subjectId === "string"
      ? event.subjectId
      : null;
    if (!checkpointId) return { producedEvents: [] };

    const checkpoint = await deps.db.ops.unsafeGraph.getNodeById(checkpointId);
    const checkpointData = getLongTermMemoryData(checkpoint);
    if (
      !checkpoint || !checkpointData || checkpointData.status === "ready" ||
      checkpointData.status === "failed"
    ) {
      return { producedEvents: [] };
    }

    const config = getLongTermMemoryConfig(deps.context.memory);
    const namespace = deps.context.namespace ??
      (typeof checkpoint.namespace === "string" ? checkpoint.namespace : null);
    const threadId = checkpointData.threadId;
    const sourceThread = await deps.db.ops.getThreadById(threadId);
    const memoryDeps = sourceThread ? { ...deps, thread: sourceThread } : deps;
    let attemptId: string | null = null;
    let llmConfig: ProviderConfig | null = null;
    let response: ChatResponse | null = null;
    const validationFailures: ConsolidationValidationFailure[] = [];

    try {
      if (!config || !namespace || !deps.context.embeddingConfig) {
        throw new Error(
          "Long-term memory configuration and embeddings are required.",
        );
      }
      const agent = deps.context.agents?.find((candidate) =>
        candidate.id === checkpointData.agentId ||
        candidate.name === checkpointData.agentId
      );
      if (!agent) {
        throw new Error(
          `Long-term-memory agent not found: ${checkpointData.agentId}`,
        );
      }
      const checkpointSpaces = getCheckpointMemorySpaceIds(checkpointData);
      const currentMemorySpaces = await resolveThreadMemorySpaces(
        deps.db,
        threadId,
        namespace,
      );
      const currentMemorySpaceById = new Map(
        currentMemorySpaces.map((space) => [String(space.node.id), space]),
      );
      const readMemorySpaceIds = checkpointSpaces.readMemorySpaceIds.filter(
        (id) => currentMemorySpaceById.has(id),
      );
      const writeMemorySpaceIds = checkpointSpaces.writeMemorySpaceIds.filter(
        (id) =>
          currentMemorySpaceById.get(id)?.access === "read_write" &&
          readMemorySpaceIds.includes(id),
      );
      const defaultWriteMemorySpaceId = writeMemorySpaceIds.includes(
          checkpointSpaces.defaultWriteMemorySpaceId,
        )
        ? checkpointSpaces.defaultWriteMemorySpaceId
        : writeMemorySpaceIds[0];
      if (
        readMemorySpaceIds.length === 0 ||
        writeMemorySpaceIds.length === 0 ||
        !defaultWriteMemorySpaceId
      ) {
        throw new Error(
          "Long-term-memory checkpoint has no currently accessible writable memory space.",
        );
      }
      const memorySpaces = readMemorySpaceIds.flatMap((id) => {
        const space = currentMemorySpaceById.get(id);
        return space ? [space] : [];
      });

      const sourceMessages = await loadMessagesInLongTermMemoryRange(
        deps.db,
        threadId,
        checkpointData.sourceStartMessageId,
        checkpointData.sourceEndMessageId,
      );
      const conversationLines = sourceMessages.flatMap((message): string[] => {
        const projected = projectMessageForSharedMemory(
          message,
          deps.context.toolResultHistoryMaxEstimatedTokens,
        );
        return projected
          ? [JSON.stringify({ messageId: message.id, content: projected })]
          : [];
      });
      const conversation = conversationLines.join("\n");
      if (!conversation) {
        throw new Error("The reserved memory range has no shared content.");
      }

      const previousMemoryCandidate = await getLatestReadyLongTermMemory(
        deps.db,
        threadId,
        namespace,
        checkpointData.agentId,
      );
      const previousMemory = previousMemoryCandidate &&
          isLongTermMemoryAccessible(
            previousMemoryCandidate.data,
            currentMemorySpaces,
          )
        ? previousMemoryCandidate
        : null;
      const previousContinuity = readPersistedContinuity(previousMemory);
      const allowedVisibleItemIds = getVisibleMemoryItemIds(previousMemory);
      const { messages: llmMessages, tools: llmTools } =
        await buildConsolidationContext({
          agent,
          deps: memoryDeps,
          conversation,
          memorySpaces,
          defaultWriteMemorySpaceId,
          previousMemory,
          previousContinuity,
        });
      llmConfig = await resolveMemoryLlmConfig({
        agent,
        messages: llmMessages,
        event,
        deps: memoryDeps,
      });
      attemptId = await persistAttemptStart({
        event,
        deps: memoryDeps,
        threadId,
        namespace,
        agent,
        config: llmConfig,
        messages: llmMessages,
      });

      const runtimeEnvironment = readRuntimeEnvironment();
      response = await chat(
        { messages: llmMessages, tools: llmTools },
        llmConfig,
        runtimeEnvironment,
        undefined,
        deps.context.llmProviders,
      );
      const allowedSourceMessageIds = new Set(
        sourceMessages.map((message) => message.id),
      );
      const proposalRouting = {
        writableMemorySpaceIds: new Set(writeMemorySpaceIds),
        defaultWriteMemorySpaceId,
      };
      let proposal: ConsolidationProposal;
      try {
        proposal = parseConsolidationProposal(
          response.answer,
          allowedSourceMessageIds,
          allowedVisibleItemIds,
          proposalRouting,
        );
      } catch (validationError) {
        validationFailures.push({
          errorMessage: validationError instanceof Error
            ? validationError.message
            : String(validationError),
          response,
        });
        const repairMessages = buildConsolidationRepairMessages(
          llmMessages,
          response,
          validationError,
        );
        response = await chat(
          { messages: repairMessages, tools: llmTools },
          llmConfig,
          runtimeEnvironment,
          undefined,
          deps.context.llmProviders,
        );
        proposal = parseConsolidationProposal(
          response.answer,
          allowedSourceMessageIds,
          allowedVisibleItemIds,
          proposalRouting,
        );
      }
      const continuity = applyContinuityPatch(
        previousContinuity,
        proposal.continuityPatch,
      );

      const continuityRetrievalTexts = buildContinuityRetrievalTexts(
        continuity,
      );
      const retrievalTexts = [
        ...proposal.items.map((item) => item.content),
        ...continuityRetrievalTexts,
      ];
      const retrievalEmbeddingResult = retrievalTexts.length > 0
        ? await embed(
          retrievalTexts,
          deps.context.embeddingConfig,
          {},
          deps.context.embeddingProviders,
        )
        : { embeddings: [] as number[][] };
      if (
        retrievalTexts.some((_text, index) =>
          !isEmbedding(retrievalEmbeddingResult.embeddings[index])
        )
      ) {
        throw new Error(
          "Failed to generate one or more memory retrieval embeddings.",
        );
      }
      const itemEmbeddings = retrievalEmbeddingResult.embeddings.slice(
        0,
        proposal.items.length,
      );
      const pinnedItemIds = [
        ...proposal.relations.flatMap((relation) =>
          allowedVisibleItemIds.has(relation.target) ? [relation.target] : []
        ),
        ...proposal.items.flatMap((item) =>
          item.supersedesItemId ? [item.supersedesItemId] : []
        ),
      ];
      const older = await retrieveOlderMemory({
        deps: memoryDeps,
        namespace,
        memorySpaceIds: readMemorySpaceIds,
        agentId: checkpointData.agentId,
        queryEmbeddings: retrievalEmbeddingResult.embeddings,
        pinnedItemIds,
        limit: config.retrievalLimit,
      });
      proposal = constrainProposalToMemorySpaces(proposal, older.items);
      const localItemNodes = new Map<string, KnowledgeNode>();
      const createNodes: Array<
        Omit<NewKnowledgeNode, "id"> & { id?: string }
      > = proposal.items.map((item, index) => {
        const id = ulid();
        const node = {
          id,
          namespace,
          type: "memory_item",
          name: item.name,
          content: item.content,
          embedding: itemEmbeddings[index] ?? null,
          data: {
            memorySpaceId: item.memorySpaceId ??
              defaultWriteMemorySpaceId,
            checkpointId,
            createdByAgentId: checkpointData.agentId,
            originThreadId: threadId,
            kind: item.kind,
            name: item.name,
            content: item.content,
            confidence: item.confidence ?? null,
            sourceMessageIds: item.sourceMessageIds ?? [],
          },
          sourceType: "long_term_memory",
          sourceId: checkpointId,
        };
        localItemNodes.set(item.localId, node as KnowledgeNode);
        return node;
      });

      const content = renderLongTermMemory({
        proposal,
        continuity,
        newItemNodes: localItemNodes,
        olderItems: older.items,
        olderRelations: older.relations,
        maxContentEstimatedTokens: config.maxContentEstimatedTokens,
      });
      const contentChunks = chunkLinesForEmbedding(
        [content],
        deps.context.embeddingConfig.maxInputTokens ??
          DEFAULT_EMBEDDING_MAX_INPUT_TOKENS,
      );
      const finalEmbeddingResult = await embed(
        contentChunks.map((chunk) => chunk.text),
        deps.context.embeddingConfig,
        {},
        deps.context.embeddingProviders,
      );
      const finalEmbedding = averageNormalizedEmbeddings(
        finalEmbeddingResult.embeddings,
        contentChunks.map((chunk) => chunk.characterCount),
      );
      if (!isEmbedding(finalEmbedding)) {
        throw new Error("Failed to generate long-term-memory embedding.");
      }

      const createEdges: Array<
        Omit<NewKnowledgeEdge, "id"> & { id?: string }
      > = [];
      for (const node of createNodes) {
        const nodeData = isRecord(node.data) ? node.data : {};
        createEdges.push({
          id: ulid(),
          sourceNodeId: String(nodeData.memorySpaceId),
          targetNodeId: String(node.id),
          type: GRAPH_EDGE.HAS_MEMORY_ITEM,
        }, {
          id: ulid(),
          sourceNodeId: checkpointId,
          targetNodeId: String(node.id),
          type: GRAPH_EDGE.INCLUDES_MEMORY_ITEM,
        });
      }
      const relationKeys = new Set<string>();
      const resolveItemId = (value: string): string | null =>
        localItemNodes.get(value)?.id as string | undefined ??
          (older.items.some((item) => String(item.node.id) === value)
            ? value
            : null);
      for (const relation of proposal.relations) {
        const sourceNodeId = resolveItemId(relation.source);
        const targetNodeId = resolveItemId(relation.target);
        if (!sourceNodeId || !targetNodeId) continue;
        const key = `${sourceNodeId}:${relation.type}:${targetNodeId}`;
        if (relationKeys.has(key)) continue;
        relationKeys.add(key);
        createEdges.push({
          id: ulid(),
          sourceNodeId,
          targetNodeId,
          type: relation.type,
        });
      }
      for (const item of proposal.items) {
        if (!item.supersedesItemId) continue;
        const sourceNodeId = resolveItemId(item.localId);
        if (!sourceNodeId) continue;
        const key =
          `${sourceNodeId}:${GRAPH_EDGE.SUPERSEDES}:${item.supersedesItemId}`;
        if (relationKeys.has(key)) continue;
        relationKeys.add(key);
        createEdges.push({
          id: ulid(),
          sourceNodeId,
          targetNodeId: item.supersedesItemId,
          type: GRAPH_EDGE.SUPERSEDES,
        });
      }

      const readyData = {
        ...checkpointData,
        status: "ready",
        contentHash: await sha256(content),
        tokenEstimate: estimateTextTokens(content),
        error: null,
        metadata: {
          ...(checkpointData.metadata ?? {}),
          processorVersion: "v2",
          continuityVersion: CONTINUITY_VERSION,
          continuity,
          retrievedItemIds: older.items.map((item) => String(item.node.id)),
          visibleItemIds: extractVisibleMemoryItemIds(content),
        },
      };
      await deps.db.ops.mutate.graph.mutateMany({
        createNodes,
        createEdges,
        updateNodes: [{
          id: checkpointId,
          updates: {
            content,
            embedding: finalEmbedding,
            data: readyData,
          },
        }],
      }, {
        threadId,
        namespace,
        traceId: typeof event.traceId === "string" ? event.traceId : null,
        causationId: typeof event.id === "string" ? event.id : null,
      });

      if (attemptId) {
        await deps.db.ops.mutate.llmAttempts.complete(attemptId, {
          answer: response.answer,
          reasoning: response.reasoning ?? null,
          messages: response.prompt,
          debug: buildConsolidationDebug(response, validationFailures),
          provider: response.provider ?? llmConfig.provider ?? null,
          model: response.model ?? llmConfig.model ?? null,
          usage: response.usage ?? null,
          cost: response.cost ?? null,
          finishReason: response.finishReason ?? null,
          finishedAt: new Date().toISOString(),
        }, {
          threadId,
          traceId: typeof event.traceId === "string" ? event.traceId : null,
          causationId: typeof event.id === "string" ? event.id : null,
          namespace,
        }).catch((error) => {
          console.warn(
            "[long_term_memory] Failed to complete consolidation llm_attempt:",
            error,
          );
        });
      }
      if (response.usage && deps.context.usage?.enabled !== false) {
        const usage = createLlmUsageService({
          collections: deps.context.collections,
          ops: deps.db.ops,
          usageOptions: deps.context.usage,
        });
        await usage.createUsageRecord({
          threadId,
          eventId: typeof event.id === "string" ? event.id : null,
          agentId: agent.id,
          provider: response.provider ?? llmConfig.provider ?? null,
          model: response.model ?? llmConfig.model ?? null,
          usage: response.usage,
          cost: response.cost ?? null,
          dedupeKey: `long_term_memory:${checkpointId}`,
        }).catch((error) => {
          console.warn(
            "[long_term_memory] Failed to persist consolidation usage:",
            error,
          );
        });
      }
    } catch (error) {
      const structuredError = serializeConsolidationError(
        error,
        llmConfig,
        response,
        validationFailures,
      );
      console.warn("[long_term_memory] Consolidation failed:", error);
      if (attemptId) {
        await deps.db.ops.mutate.llmAttempts.fail(attemptId, {
          answer: response?.answer ?? null,
          reasoning: response?.reasoning ?? null,
          messages: response?.prompt,
          debug: buildConsolidationDebug(response, validationFailures),
          provider: error instanceof LLMProviderError
            ? error.provider
            : response?.provider ?? llmConfig?.provider ?? null,
          model: error instanceof LLMProviderError
            ? error.model ?? null
            : response?.model ?? llmConfig?.model ?? null,
          usage: response?.usage ?? null,
          cost: response?.cost ?? null,
          error: structuredError,
          finishReason: "error",
          finishedAt: new Date().toISOString(),
        }, {
          threadId,
          traceId: typeof event.traceId === "string" ? event.traceId : null,
          causationId: typeof event.id === "string" ? event.id : null,
          namespace,
        }).catch(() => undefined);
      }
      await deps.db.ops.mutate.graph.updateNode(checkpointId, {
        data: {
          ...checkpointData,
          status: "failed",
          error: structuredError,
        },
      }, {
        threadId,
        namespace: namespace ?? null,
        traceId: typeof event.traceId === "string" ? event.traceId : null,
        causationId: typeof event.id === "string" ? event.id : null,
      }).catch((updateError) => {
        console.warn(
          "[long_term_memory] Failed to mark checkpoint failed:",
          updateError,
        );
      });
    }

    return { producedEvents: [] };
  },
};

export const eventType = "long_term_memory.created";
export const { shouldProcess, process } = longTermMemoryProcessor;
