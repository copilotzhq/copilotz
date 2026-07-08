import { ulid } from "ulid";
import type {
  Agent,
  Event,
  EventProcessor,
  NewMessage,
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
  ProviderConfig,
  ToolDefinition,
} from "@/runtime/llm/types.ts";
import { assertAgentLLMConfig } from "@/resources/processors/llm_call/llm_attempt.created.ts";
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
  resolveThreadMemorySpaces,
  type ThreadMemorySpaceAccess,
} from "@/runtime/memory/index.ts";
import { estimateTextTokens } from "@/runtime/tokens/index.ts";
import {
  type AgentLlmInput,
  buildAgentLlmInput,
} from "@/runtime/agent-llm-input/index.ts";

export const processorId = "memory_consolidation";
export const eventTypes = ["long_term_memory.created"] as const;

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
  nodes: Array<{
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
    /** IDs of source messages that support this node. */
    sourceMessageIds: string[];
    /** ID of the writable memory space where this node belongs. */
    memorySpaceId: string;
    /** ID of a node visible in the previous checkpoint that this supersedes (optional). */
    supersedesNodeId?: string;
  }>;
  relations: Array<{
    /** localId of the source node. */
    source: string;
    /** One of: mentions, related_to, supports, contradicts, depends_on, supersedes */
    type: string;
    /** localId or visible previous-checkpoint node ID of the target. */
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

const KNOWLEDGE_BRAIN_NODE_KINDS = new Set([
  "entity",
  "fact",
  "claim",
  "decision",
  "preference",
  "task",
  "event",
  "constraint",
]);

const WORKING_BRAIN_NODE_FIELD_META = {
  intent: {
    challenge: { kind: "challenge", label: "Challenge" },
    purpose: { kind: "purpose", label: "Purpose" },
    desiredOutcome: { kind: "desired_outcome", label: "Desired outcome" },
    successCriteria: {
      kind: "success_criterion",
      label: "Success criterion",
    },
    decisionCriteria: {
      kind: "decision_criterion",
      label: "Decision criterion",
    },
    constraints: { kind: "constraint", label: "Constraint" },
  },
  state: {
    currentState: { kind: "current_state", label: "Current state" },
    activeApproach: { kind: "active_approach", label: "Active approach" },
    risksAndBlockers: { kind: "risk", label: "Risk or blocker" },
    openQuestions: { kind: "open_question", label: "Open question" },
    nextActions: { kind: "next_action", label: "Next action" },
  },
} as const satisfies Record<
  "intent" | "state",
  Record<string, { kind: string; label: string }>
>;

const RELATION_TYPES: ReadonlySet<string> = new Set([
  GRAPH_EDGE.MENTIONS,
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
  nodes: Array<{
    localId: string;
    kind: string;
    name: string;
    content: string;
    confidence?: number;
    sourceMessageIds?: string[];
    memorySpaceId?: string;
    supersedesNodeId?: string;
  }>;
  relations: Array<{
    source: string;
    type: string;
    target: string;
  }>;
}

interface RetrievedBrainNode {
  node: KnowledgeNode;
  similarity: number;
}

interface WorkingBrainNodeDraft {
  localId: string;
  kind: string;
  name: string;
  content: string;
  sourceMessageIds: string[];
  memorySpaceId: string;
  sourceField: string;
}

const BRAIN_NODE_ID_PATTERN = /^- \[id:([^\]\s]+)\]/gm;
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

function createWorkingBrainNodeDrafts(args: {
  continuity: LongTermMemoryContinuity;
  memorySpaceId: string;
}): WorkingBrainNodeDraft[] {
  const drafts: WorkingBrainNodeDraft[] = [];
  for (const section of ["intent", "state"] as const) {
    const fields = WORKING_BRAIN_NODE_FIELD_META[section];
    for (const [field, meta] of Object.entries(fields)) {
      const value = (args.continuity[section] as Record<
        string,
        SourcedContinuityValue<string | null | string[]>
      >)[field];
      if (!value) continue;
      const texts = continuityValueText(value);
      texts.forEach((content, index) => {
        const trimmed = content.trim();
        if (!trimmed) return;
        drafts.push({
          localId: `working:${section}.${field}:${index}`,
          kind: meta.kind,
          name: texts.length > 1 ? `${meta.label} ${index + 1}` : meta.label,
          content: trimmed,
          sourceMessageIds: value.sourceMessageIds,
          memorySpaceId: args.memorySpaceId,
          sourceField: `${section}.${field}`,
        });
      });
    }
  }
  return drafts;
}

export function extractVisibleBrainNodeIds(content: string): string[] {
  return [...content.matchAll(BRAIN_NODE_ID_PATTERN)]
    .map((match) => match[1])
    .filter((id, index, ids) => ids.indexOf(id) === index);
}

function getVisibleBrainNodeIds(
  memory: Awaited<ReturnType<typeof getLatestReadyLongTermMemory>>,
): Set<string> {
  if (!memory) return new Set();
  const metadata = isRecord(memory.data.metadata) ? memory.data.metadata : {};
  const candidateIds = Array.isArray(metadata.visibleBrainNodeIds)
    ? metadata.visibleBrainNodeIds
    : Array.isArray(metadata.visibleItemIds)
    ? metadata.visibleItemIds
    : [];
  const persisted = candidateIds
    .filter((id): id is string => typeof id === "string" && id.length > 0);
  return new Set([
    ...persisted,
    ...extractVisibleBrainNodeIds(memory.node.content ?? ""),
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
  allowedOlderNodeIds: Set<string>,
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

  const rawNodes = Array.isArray(parsed.nodes)
    ? parsed.nodes
    : Array.isArray(parsed.items)
    ? parsed.items
    : [];
  const localIds = new Set<string>();
  const nodes = rawNodes.flatMap(
    (candidate): ConsolidationProposal["nodes"] => {
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
        !localId || localIds.has(localId) ||
        !KNOWLEDGE_BRAIN_NODE_KINDS.has(kind) || !name || !content
      ) {
        return [];
      }
      localIds.add(localId);
      const sourceMessageIds = Array.isArray(candidate.sourceMessageIds)
        ? candidate.sourceMessageIds.filter((id): id is string =>
          typeof id === "string" && allowedSourceMessageIds.has(id)
        )
        : [];
      const requestedSupersedesNodeId =
        typeof candidate.supersedesNodeId === "string"
          ? candidate.supersedesNodeId
          : typeof candidate.supersedesItemId === "string"
          ? candidate.supersedesItemId
          : "";
      const supersedesNodeId =
        allowedOlderNodeIds.has(requestedSupersedesNodeId)
          ? requestedSupersedesNodeId
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
        ...(supersedesNodeId ? { supersedesNodeId } : {}),
      }];
    },
  );

  const validTargets = new Set([...localIds, ...allowedOlderNodeIds]);
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
    nodes,
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
        "Preserve every valid brain node and relation from the previous response.",
        "Every changed continuity field must use { value, sourceMessageIds }, and sourceMessageIds must come from the conversation range.",
        "Do not call tools.",
        "Output ONLY the JSON object — no markdown, no explanation.",
      ].join("\n"),
    },
  ];
}

function assertNoConsolidationToolCalls(response: ChatResponse): void {
  if (Array.isArray(response.toolCalls) && response.toolCalls.length > 0) {
    throw new Error(
      "Long-term-memory consolidation must return JSON and must not call tools.",
    );
  }
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

function brainNodeLabel(node: KnowledgeNode): string {
  const data = isRecord(node.data) ? node.data : {};
  const kind = typeof data.kind === "string" ? data.kind : "knowledge";
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
  ref: string,
  label: string,
  value: SourcedContinuityValue<string | null>,
): string[] {
  return value.value ? [`- [continuity:${ref}] ${label}: ${value.value}`] : [];
}

function renderContinuityList(
  ref: string,
  label: string,
  value: SourcedContinuityValue<string[]>,
): string[] {
  return value.value.length > 0
    ? [`- [continuity:${ref}] ${label}: ${value.value.join("; ")}`]
    : [];
}

function renderContinuityBlocks(
  continuity: LongTermMemoryContinuity,
): string[] {
  const intent = [
    ...renderContinuityScalar(
      "intent.challenge",
      "Challenge",
      continuity.intent.challenge,
    ),
    ...renderContinuityScalar(
      "intent.purpose",
      "Purpose",
      continuity.intent.purpose,
    ),
    ...renderContinuityScalar(
      "intent.desiredOutcome",
      "Desired outcome",
      continuity.intent.desiredOutcome,
    ),
    ...renderContinuityList(
      "intent.successCriteria",
      "Success criteria",
      continuity.intent.successCriteria,
    ),
    ...renderContinuityList(
      "intent.decisionCriteria",
      "Decision criteria",
      continuity.intent.decisionCriteria,
    ),
    ...renderContinuityList(
      "intent.constraints",
      "Constraints",
      continuity.intent.constraints,
    ),
  ];
  const state = [
    ...renderContinuityScalar(
      "state.currentState",
      "Current state",
      continuity.state.currentState,
    ),
    ...renderContinuityScalar(
      "state.activeApproach",
      "Active approach",
      continuity.state.activeApproach,
    ),
    ...renderContinuityList(
      "state.risksAndBlockers",
      "Risks and blockers",
      continuity.state.risksAndBlockers,
    ),
    ...renderContinuityList(
      "state.openQuestions",
      "Open questions",
      continuity.state.openQuestions,
    ),
    ...renderContinuityList(
      "state.nextActions",
      "Next actions",
      continuity.state.nextActions,
    ),
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
  newBrainNodes: Map<string, KnowledgeNode>;
  olderBrainNodes: RetrievedBrainNode[];
  olderRelations: KnowledgeEdge[];
  maxContentEstimatedTokens: number;
}): string {
  const { proposal, newBrainNodes, olderBrainNodes, olderRelations } = args;
  const olderBrainNodeNames = new Map(
    olderBrainNodes.map((item) => [String(item.node.id), item.node.name]),
  );
  const superseded = new Set(
    proposal.nodes.flatMap((node) =>
      node.supersedesNodeId ? [node.supersedesNodeId] : []
    ),
  );
  const relevant = [
    ...proposal.nodes.map((item) => {
      const node = newBrainNodes.get(item.localId);
      return `- [id:${
        node?.id ?? item.localId
      }] [${item.kind}] ${item.name}: ${item.content}`;
    }),
    ...olderBrainNodes
      .filter((item) => !superseded.has(String(item.node.id)))
      .map((item) => `- ${brainNodeLabel(item.node)}`),
  ];

  const relationLines = [
    ...proposal.relations.map((relation) => {
      const source = newBrainNodes.get(relation.source)?.name ??
        relation.source;
      const target = newBrainNodes.get(relation.target)?.name ??
        olderBrainNodes.find((item) => String(item.node.id) === relation.target)
          ?.node.name ??
        relation.target;
      return renderRelationship(source, relation.type, target);
    }),
    ...olderRelations.map((edge) =>
      renderRelationship(
        olderBrainNodeNames.get(String(edge.sourceNodeId)) ??
          String(edge.sourceNodeId),
        String(edge.type),
        olderBrainNodeNames.get(String(edge.targetNodeId)) ??
          String(edge.targetNodeId),
      )
    ),
  ];

  const blocks = [
    "## LONG-TERM CONVERSATION MEMORY",
    ...renderContinuityBlocks(args.continuity),
    "## RELEVANT MEMORY",
    ...(relevant.length > 0 ? relevant : ["- No durable brain nodes."]),
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
  input: AgentLlmInput;
  event: Event;
  deps: ProcessorDeps;
}): Promise<ProviderConfig> {
  const { agent, input, event, deps } = args;
  const persistedConfig = input.config;
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
    input.runtimeConfig,
    securityRuntimeConfig,
    {
      outputReasoning: false,
      responseType: "json",
    },
  );
  assertAgentLLMConfig(agent, resolved);
  return resolved;
}

function compactSourcePreview(message: NewMessage): string | null {
  if (message.senderType === "tool") return "[tool result]";
  const content = typeof message.content === "string" ? message.content : "";
  const compact = content.replace(/\s+/g, " ").trim();
  if (!compact) return null;
  return compact.length > 160 ? `${compact.slice(0, 157)}...` : compact;
}

function buildSourceMessageMap(messages: NewMessage[]) {
  return messages.map((message, index) => ({
    label: `M${index + 1}`,
    messageId: message.id,
    senderType: message.senderType,
    senderId: message.senderId,
    ...(compactSourcePreview(message)
      ? { preview: compactSourcePreview(message) }
      : {}),
  }));
}

function buildMemoryConsolidationInstruction(args: {
  memorySpaces: ThreadMemorySpaceAccess[];
  defaultWriteMemorySpaceId: string;
  hasPreviousMemoryCheckpoint: boolean;
  sourceMessages: NewMessage[];
}): string {
  const reconciliationInstruction = args.hasPreviousMemoryCheckpoint
    ? "You may supersede or relate only older brain node IDs shown in the long-term memory section above."
    : "There is no previous long-term memory section; relations may target only new localIds.";
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
  return [
    "You are performing long-term memory consolidation for the agent history immediately above.",
    "Do not answer the user, do not route the conversation, and do not call tools.",
    "Use the preceding agent-visible history as the conversation content to consolidate.",
    "",
    "Source message map for provenance:",
    JSON.stringify(buildSourceMessageMap(args.sourceMessages)),
    "",
    "---",
    "Update continuity and extract durable memory from the preceding history.",
    "Use any [continuity:...] entries in the long-term memory section above as the previous continuity state.",
    "Continuity must let another capable agent resume the work after archived messages are unavailable.",
    "Do not produce a chronological summary.",
    "Do not copy unchanged continuity fields into continuityPatch.",
    "For continuity, emit only fields introduced, refined, changed, or explicitly cleared by this history range.",
    "Omit unchanged continuity fields so the processor retains their previous values exactly.",
    "When updating a list field, return its complete new value, including prior entries that remain active.",
    "Never infer missing intent. Use null or [] only when this history range explicitly clears a value.",
    "Keep the challenge distinct from the current task and the desired outcome distinct from an activity.",
    "Keep unresolved blockers, questions, and actions until the history explicitly changes or resolves them.",
    "",
    "Entity preservation:",
    "Before writing facts, decisions, tasks, preferences, events, or constraints, identify the durable entities that organize this memory.",
    "Create entity brain nodes for people, organizations, tenants, projects, products, agents, tools, APIs, providers, models, credentials, code modules, documents, workflows, concepts, policies, goals, and recurring workstreams when they are central to the durable memory.",
    "Every non-entity node that is about a durable entity must include a mentions relation to that entity or to a visible older entity node.",
    "Prefer canonical entity names. Put aliases in content only when useful.",
    "Do not create entity nodes for generic nouns, pronouns, transient wording, or one-off details.",
    "Reuse visible older entity nodes by relating to their IDs instead of duplicating them.",
    "If a durable entity materially changed, create a new entity node and supersede the visible older entity node.",
    "",
    "Relation coverage:",
    "Use mentions when a durable memory is about an entity.",
    "Use depends_on when one node cannot progress or be true without another.",
    "Use supports when one node is evidence for another.",
    "Use contradicts when one node conflicts with another.",
    "Use related_to only when the relationship is real but more specific wording is unavailable.",
    "Use supersedes only when replacing an older visible brain node.",
    reconciliationInstruction,
    "Every sourceMessageIds entry must be a messageId from the source message map.",
    "Assign every new brain node to exactly one writable memory space from this catalog.",
    `Writable memory spaces: ${JSON.stringify(writableMemorySpaces)}`,
    `If uncertain, use the default memory space ID: ${args.defaultWriteMemorySpaceId}`,
    "Before returning JSON, verify that important entities are represented, durable non-entity nodes are linked to their main entities, and no duplicate entity was created when a visible previous entity node could be reused.",
    "Output ONLY the JSON object — no markdown, no explanation.",
    "",
    "Schema:",
    CONSOLIDATE_MEMORY_TOOL.function.inputTypes,
  ].join("\n");
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
  pinnedBrainNodeIds?: string[];
  limit: number;
}): Promise<{
  nodes: RetrievedBrainNode[];
  relations: KnowledgeEdge[];
}> {
  const memorySpaceIds = new Set(args.memorySpaceIds);
  const resultLists = await Promise.all(
    args.queryEmbeddings.map((embedding) =>
      args.deps.db.ops.unsafeGraph.searchNodes({
        embedding,
        namespaces: [args.namespace],
        nodeTypes: ["brain_node"],
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
    results.flatMap((result): RetrievedBrainNode[] => {
      const data = isRecord(result.node.data) ? result.node.data : {};
      return typeof data.memorySpaceId === "string" &&
          memorySpaceIds.has(data.memorySpaceId) &&
          data.createdByAgentId === args.agentId &&
          (data.layer ?? "knowledge") === "knowledge" &&
          (data.status ?? "active") === "active"
        ? [{ node: result.node, similarity: result.similarity ?? 0 }]
        : [];
    })
  );
  const candidateById = new Map<string, RetrievedBrainNode>();
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

  const nodeById = new Map<string, RetrievedBrainNode>();
  const pinnedIds = [...new Set(args.pinnedBrainNodeIds ?? [])];
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
      node?.type === "brain_node" &&
      node.namespace === args.namespace &&
      typeof data.memorySpaceId === "string" &&
      memorySpaceIds.has(data.memorySpaceId) &&
      data.createdByAgentId === args.agentId &&
      (data.layer ?? "knowledge") === "knowledge" &&
      (data.status ?? "active") === "active" &&
      supersedingEdges.length === 0
    ) {
      nodeById.set(String(node.id), {
        node,
        similarity: candidateById.get(String(node.id))?.similarity ?? 0,
      });
    }
  }
  for (const id of rankedIds) {
    if (nodeById.size >= args.limit) break;
    const candidate = candidateById.get(id);
    if (candidate) nodeById.set(id, candidate);
  }

  const relationById = new Map<string, KnowledgeEdge>();
  for (const item of [...nodeById.values()]) {
    const edges = await args.deps.db.ops.unsafeGraph.getEdgesForNode(
      String(item.node.id),
      "both",
      [...RELATION_TYPES],
    );
    for (const edge of edges) {
      const sourceId = String(edge.sourceNodeId);
      const targetId = String(edge.targetNodeId);
      const otherId = sourceId === String(item.node.id) ? targetId : sourceId;
      const pointsToSupersededNode = edge.type === GRAPH_EDGE.SUPERSEDES &&
        sourceId === String(item.node.id);
      if (
        !pointsToSupersededNode &&
        !nodeById.has(otherId) &&
        nodeById.size < args.limit
      ) {
        const related = await args.deps.db.ops.unsafeGraph.getNodeById(otherId);
        const relatedData = related && isRecord(related.data)
          ? related.data
          : {};
        if (
          related?.type === "brain_node" &&
          typeof relatedData.memorySpaceId === "string" &&
          memorySpaceIds.has(relatedData.memorySpaceId) &&
          relatedData.memorySpaceId === brainNodeSpaceId(item.node) &&
          relatedData.createdByAgentId === args.agentId &&
          (relatedData.layer ?? "knowledge") === "knowledge" &&
          (relatedData.status ?? "active") === "active"
        ) {
          nodeById.set(otherId, { node: related, similarity: 0 });
        }
      }
      if (
        nodeById.has(sourceId) &&
        nodeById.has(targetId) &&
        brainNodeSpaceId(nodeById.get(sourceId)?.node) ===
          brainNodeSpaceId(nodeById.get(targetId)?.node)
      ) {
        relationById.set(String(edge.id), edge);
      }
    }
  }
  return {
    nodes: [...nodeById.values()],
    relations: [...relationById.values()],
  };
}

function brainNodeSpaceId(
  node: KnowledgeNode | null | undefined,
): string | null {
  const data = node && isRecord(node.data) ? node.data : {};
  return typeof data.memorySpaceId === "string" ? data.memorySpaceId : null;
}

function constrainProposalToMemorySpaces(
  proposal: ConsolidationProposal,
  olderBrainNodes: RetrievedBrainNode[],
): ConsolidationProposal {
  const localSpaces = new Map(
    proposal.nodes.map((node) => [node.localId, node.memorySpaceId ?? null]),
  );
  const olderSpaces = new Map(
    olderBrainNodes.map((node) => [
      String(node.node.id),
      brainNodeSpaceId(node.node),
    ]),
  );
  const nodes = proposal.nodes.map((node) => {
    if (
      node.supersedesNodeId &&
      olderSpaces.get(node.supersedesNodeId) !== node.memorySpaceId
    ) {
      const { supersedesNodeId: _supersedesNodeId, ...rest } = node;
      return rest;
    }
    return node;
  });
  const relations = proposal.relations.filter((relation) => {
    const sourceSpace = localSpaces.get(relation.source);
    const targetSpace = localSpaces.get(relation.target) ??
      olderSpaces.get(relation.target);
    return Boolean(sourceSpace && sourceSpace === targetSpace);
  });
  return { ...proposal, nodes, relations };
}

async function persistAttemptStart(args: {
  event: Event;
  deps: ProcessorDeps;
  threadId: string;
  namespace: string;
  agent: Agent;
  config: ProviderConfig;
  messages: ChatMessage[];
  tools: ToolDefinition[];
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
      tools: args.tools,
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
      const allowedVisibleItemIds = getVisibleBrainNodeIds(previousMemory);
      const llmInput = await buildAgentLlmInput({
        deps: memoryDeps,
        event,
        threadId,
        agent,
        historyMode: {
          type: "range",
          startMessageId: checkpointData.sourceStartMessageId,
          endMessageId: checkpointData.sourceEndMessageId,
        },
        longTermMemoryMode: "include",
      });
      const sourceMessages = llmInput.rawHistory;
      if (sourceMessages.length === 0) {
        throw new Error("The reserved memory range has no shared content.");
      }
      const llmMessages: ChatMessage[] = [
        ...llmInput.messages,
        {
          role: "user",
          content: buildMemoryConsolidationInstruction({
            memorySpaces,
            defaultWriteMemorySpaceId,
            hasPreviousMemoryCheckpoint: Boolean(previousMemory?.node.content),
            sourceMessages,
          }),
        },
      ];
      const llmTools = llmInput.tools;
      llmConfig = await resolveMemoryLlmConfig({
        agent,
        input: llmInput,
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
        tools: llmTools,
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
        sourceMessages
          .map((message) => message.id)
          .filter((id): id is string => typeof id === "string"),
      );
      const proposalRouting = {
        writableMemorySpaceIds: new Set(writeMemorySpaceIds),
        defaultWriteMemorySpaceId,
      };
      let proposal: ConsolidationProposal;
      try {
        assertNoConsolidationToolCalls(response);
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
        assertNoConsolidationToolCalls(response);
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
      const workingBrainNodeDrafts = createWorkingBrainNodeDrafts({
        continuity,
        memorySpaceId: defaultWriteMemorySpaceId,
      });

      const continuityRetrievalTexts = buildContinuityRetrievalTexts(
        continuity,
      );
      const retrievalTexts = [
        ...proposal.nodes.map((node) => node.content),
        ...workingBrainNodeDrafts.map((node) => node.content),
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
      const knowledgeNodeEmbeddings = retrievalEmbeddingResult.embeddings.slice(
        0,
        proposal.nodes.length,
      );
      const workingNodeEmbeddings = retrievalEmbeddingResult.embeddings.slice(
        proposal.nodes.length,
        proposal.nodes.length + workingBrainNodeDrafts.length,
      );
      const pinnedBrainNodeIds = [
        ...proposal.relations.flatMap((relation) =>
          allowedVisibleItemIds.has(relation.target) ? [relation.target] : []
        ),
        ...proposal.nodes.flatMap((node) =>
          node.supersedesNodeId ? [node.supersedesNodeId] : []
        ),
      ];
      const older = await retrieveOlderMemory({
        deps: memoryDeps,
        namespace,
        memorySpaceIds: readMemorySpaceIds,
        agentId: checkpointData.agentId,
        queryEmbeddings: retrievalEmbeddingResult.embeddings,
        pinnedBrainNodeIds,
        limit: config.retrievalLimit,
      });
      proposal = constrainProposalToMemorySpaces(proposal, older.nodes);
      const localBrainNodes = new Map<string, KnowledgeNode>();
      const knowledgeCreateNodes: Array<
        Omit<NewKnowledgeNode, "id"> & { id?: string }
      > = proposal.nodes.map((node, index) => {
        const id = ulid();
        const knowledgeNode = {
          id,
          namespace,
          type: "brain_node",
          name: node.name,
          content: node.content,
          embedding: knowledgeNodeEmbeddings[index] ?? null,
          data: {
            memorySpaceId: node.memorySpaceId ??
              defaultWriteMemorySpaceId,
            checkpointId,
            createdByAgentId: checkpointData.agentId,
            originThreadId: threadId,
            layer: "knowledge",
            status: "active",
            kind: node.kind,
            name: node.name,
            content: node.content,
            confidence: node.confidence ?? null,
            sourceMessageIds: node.sourceMessageIds ?? [],
          },
          sourceType: "long_term_memory",
          sourceId: checkpointId,
        };
        localBrainNodes.set(node.localId, knowledgeNode as KnowledgeNode);
        return knowledgeNode;
      });
      const workingCreateNodes: Array<
        Omit<NewKnowledgeNode, "id"> & { id?: string }
      > = workingBrainNodeDrafts.map((node, index) => ({
        id: ulid(),
        namespace,
        type: "brain_node",
        name: node.name,
        content: node.content,
        embedding: workingNodeEmbeddings[index] ?? null,
        data: {
          memorySpaceId: node.memorySpaceId,
          checkpointId,
          createdByAgentId: checkpointData.agentId,
          originThreadId: threadId,
          layer: "working",
          status: "active",
          kind: node.kind,
          name: node.name,
          content: node.content,
          confidence: null,
          sourceMessageIds: node.sourceMessageIds,
          sourceField: node.sourceField,
        },
        sourceType: "long_term_memory",
        sourceId: checkpointId,
      }));
      const createNodes = [...knowledgeCreateNodes, ...workingCreateNodes];

      const content = renderLongTermMemory({
        proposal,
        continuity,
        newBrainNodes: localBrainNodes,
        olderBrainNodes: older.nodes,
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
          type: GRAPH_EDGE.HAS_BRAIN_NODE,
        }, {
          id: ulid(),
          sourceNodeId: checkpointId,
          targetNodeId: String(node.id),
          type: GRAPH_EDGE.INCLUDES_BRAIN_NODE,
        });
      }
      const relationKeys = new Set<string>();
      const resolveBrainNodeId = (value: string): string | null =>
        localBrainNodes.get(value)?.id as string | undefined ??
          (older.nodes.some((item) => String(item.node.id) === value)
            ? value
            : null);
      for (const relation of proposal.relations) {
        const sourceNodeId = resolveBrainNodeId(relation.source);
        const targetNodeId = resolveBrainNodeId(relation.target);
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
      for (const node of proposal.nodes) {
        if (!node.supersedesNodeId) continue;
        const sourceNodeId = resolveBrainNodeId(node.localId);
        if (!sourceNodeId) continue;
        const key =
          `${sourceNodeId}:${GRAPH_EDGE.SUPERSEDES}:${node.supersedesNodeId}`;
        if (relationKeys.has(key)) continue;
        relationKeys.add(key);
        createEdges.push({
          id: ulid(),
          sourceNodeId,
          targetNodeId: node.supersedesNodeId,
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
          retrievedBrainNodeIds: older.nodes.map((item) =>
            String(item.node.id)
          ),
          visibleBrainNodeIds: extractVisibleBrainNodeIds(content),
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

export const { shouldProcess, process } = longTermMemoryProcessor;
