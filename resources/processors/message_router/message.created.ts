// Import Event Queue
import type { EventProcessor, NewEvent } from "@/types/index.ts";

// Import Agent Interfaces
import type {
  Agent,
  Event,
  LlmCallEventPayload,
  MessagePayload,
  NewMessage,
  ProcessorDeps,
  Thread,
  ToolCallEventPayload,
} from "@/types/index.ts";
import type { EntityExtractPayload } from "@/database/schemas/index.ts";
import { createMessageService } from "@/runtime/collections/native.ts";

type Operations = ProcessorDeps["db"]["ops"];

import type { ToolInvocation } from "@/runtime/llm/types.ts";

import type { NewMessageEventPayload } from "@/database/schemas/index.ts";

// Import Generators
import { getUserExternalId } from "@/runtime/memory/index.ts";

import { processAssetsForNewMessage } from "@/runtime/agent-llm-input/asset-generator.ts";
import { buildAgentLlmInput } from "@/runtime/agent-llm-input/index.ts";
import {
  getRuntimeThreadMetadata,
  getSerializableThreadMetadata,
  setRuntimeThreadMetadata,
} from "@/runtime/thread-metadata.ts";
import {
  EVENT_PRIORITIES,
  priorityForAgentLlmCall,
} from "@/runtime/event-priority.ts";
import {
  detectNewerHumanInputSupersession,
  withSupersededSkipRoutingMetadata,
} from "@/runtime/event-supersession.ts";
import {
  pickRunSenderFromMetadata,
  withRunSenderMetadata,
} from "@/runtime/usage/attribution.ts";
import {
  buildMentionTargetRoute,
  extractMentionNames,
} from "@/utils/mentions.ts";
import { GRAPH_EDGE } from "@/runtime/graph/edges.ts";

export const processorId = "message_router";
export const eventTypes = ["message.created"] as const;

// ============================================================================
// Tool Result Batch Aggregation
// ============================================================================
// When the LLM issues multiple tool calls in a single response, we need to
// wait for ALL tool results before triggering the next LLM call. Otherwise,
// the LLM sees partial results and may re-issue the same tool calls.
// ============================================================================

interface StoredToolResult {
  callId: string;
  name: string;
  args: string;
  output: unknown;
  status: string;
  batchIndex: number;
  content: string;
}

interface PendingBatch {
  batchSize: number;
  agent: { id?: string; name: string };
  senderId: string;
  results: StoredToolResult[];
  createdAt: string;
}

type PendingBatches = Record<string, PendingBatch>;

/**
 * Get pending batches from thread metadata
 */
function getPendingBatches(thread: Thread): PendingBatches {
  const metadata = getRuntimeThreadMetadata(thread.metadata);
  const pendingBatches = metadata.pendingToolBatches;
  if (pendingBatches && typeof pendingBatches === "object") {
    return pendingBatches as PendingBatches;
  }
  return {};
}

/**
 * Store a tool result in the pending batch
 * Returns the updated batch and whether it's now complete
 */
async function storeToolResultInBatch(
  ops: Operations,
  thread: Thread,
  batchId: string,
  batchSize: number,
  agent: { id?: string; name: string },
  senderId: string,
  result: StoredToolResult,
): Promise<{ batch: PendingBatch; isComplete: boolean }> {
  const pendingBatches = getPendingBatches(thread);

  // Initialize batch if not exists
  if (!pendingBatches[batchId]) {
    pendingBatches[batchId] = {
      batchSize,
      agent,
      senderId,
      results: [],
      createdAt: new Date().toISOString(),
    };
  }

  const batch = pendingBatches[batchId];

  // Check if this result is already stored (deduplication)
  const existingIdx = batch.results.findIndex((r) =>
    r.callId === result.callId
  );
  if (existingIdx >= 0) {
    // Already have this result, just return current state
    return {
      batch,
      isComplete: batch.results.length >= batch.batchSize,
    };
  }

  // Add new result
  batch.results.push(result);

  const updatedMetadata = setRuntimeThreadMetadata(thread.metadata, {
    pendingToolBatches: pendingBatches,
  });

  await ops.updateThread(thread.id as string, {
    metadata: getSerializableThreadMetadata(updatedMetadata),
  });

  // Also update local thread object
  (thread as { metadata: unknown }).metadata = updatedMetadata;

  return {
    batch,
    isComplete: batch.results.length >= batch.batchSize,
  };
}

/**
 * Clear a completed batch from thread metadata
 */
async function clearCompletedBatch(
  ops: Operations,
  thread: Thread,
  batchId: string,
): Promise<void> {
  const pendingBatches = getPendingBatches(thread);
  delete pendingBatches[batchId];

  const updatedMetadata = setRuntimeThreadMetadata(thread.metadata, {
    pendingToolBatches: Object.keys(pendingBatches).length > 0
      ? pendingBatches
      : undefined,
  });

  await ops.updateThread(thread.id as string, {
    metadata: getSerializableThreadMetadata(updatedMetadata),
  });
  (thread as { metadata: unknown }).metadata = updatedMetadata;
}

/**
 * Extract batch info from message metadata
 */
function extractBatchInfo(payload: NewMessageEventPayload): {
  batchId: string | null;
  batchSize: number | null;
  batchIndex: number | null;
} {
  const metadata = payload.metadata as Record<string, unknown> | null;
  return {
    batchId: typeof metadata?.batchId === "string" ? metadata.batchId : null,
    batchSize: typeof metadata?.batchSize === "number"
      ? metadata.batchSize
      : null,
    batchIndex: typeof metadata?.batchIndex === "number"
      ? metadata.batchIndex
      : null,
  };
}

// ============================================================================
// Multi-Agent Routing Helpers
// ============================================================================

/**
 * Parse @mentions from message content, preserving order.
 * Resolves to participant IDs (agent.id or agent.name).
 */
function parseMentions(
  content: string,
  participants: string[] | null,
  agents: Agent[],
): string[] {
  const resolved: string[] = [];
  const seen = new Set<string>();

  for (const name of extractMentionNames(content)) {
    const nameLower = name.toLowerCase();

    // Mentions are only valid for participants already declared on the thread.
    const agent = agents.find((a) =>
      (typeof a.name === "string" && a.name.toLowerCase() === nameLower) ||
      (typeof a.id === "string" && a.id.toLowerCase() === nameLower)
    );
    const isParticipant = participants?.some((p) => {
      const pLower = p.toLowerCase();
      return pLower === nameLower ||
        (typeof agent?.name === "string" &&
          pLower === agent.name.toLowerCase()) ||
        (typeof agent?.id === "string" && pLower === agent.id.toLowerCase());
    });

    // Use the matched name for dedup tracking (lowercase for consistency)
    if (isParticipant && !seen.has(nameLower)) {
      // Return agent ID if available, otherwise the original participant name
      const resolvedId = agent?.id ?? agent?.name ??
        participants?.find((p) => p.toLowerCase() === nameLower) ?? name;
      resolved.push(resolvedId as string);
      seen.add(nameLower);
    }
  }

  return resolved;
}

/**
 * Target resolution result used when enqueueing an LLM_CALL.
 */
interface TargetResolution {
  targetId: string;
  targetQueue: string[];
}

export interface ToolReplyRoutingMetadata extends Record<string, unknown> {
  replyToParticipantId: string;
  replyToTargetQueue: string[];
}

/**
 * Result from agent turn check.
 */
interface AgentTurnCheckResult {
  shouldForceUserTarget: boolean;
  userToTarget?: string;
}

function isHumanAliasTarget(targetId: string): boolean {
  const normalized = targetId.trim().toLowerCase();
  return normalized === "user" || normalized === "anonymous";
}

function normalizeRoutingTarget(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function normalizeRoutingQueue(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map(normalizeRoutingTarget).filter((item): item is string =>
      item !== null
    )
    : [];
}

export function resolveThreadParticipantTarget(
  targetId: string,
  thread: Thread,
  availableAgents: Agent[],
): string | null {
  const normalizedTargetId = targetId.trim();
  if (normalizedTargetId.length === 0) return null;

  const targetLower = normalizedTargetId.toLowerCase();
  const participants = Array.isArray(thread.participants)
    ? thread.participants
      .filter((p): p is string => typeof p === "string")
      .map((p) => p.trim())
      .filter((p) => p.length > 0)
    : [];

  const matchedAgent = availableAgents.find((a) =>
    (typeof a.id === "string" && a.id.toLowerCase() === targetLower) ||
    (typeof a.name === "string" && a.name.toLowerCase() === targetLower)
  );

  if (matchedAgent) {
    const isAllowedParticipant = participants.some((p) => {
      const pLower = p.toLowerCase();
      return (typeof matchedAgent.id === "string" &&
        pLower === matchedAgent.id.toLowerCase()) ||
        (typeof matchedAgent.name === "string" &&
          pLower === matchedAgent.name.toLowerCase());
    });
    return isAllowedParticipant
      ? (matchedAgent.id ?? matchedAgent.name) as string
      : null;
  }

  const matchedParticipant = participants.find((p) =>
    p.toLowerCase() === targetLower
  );
  if (matchedParticipant) {
    return matchedParticipant;
  }

  const metadataUserExternalId = getUserExternalId(thread.metadata);
  if (
    typeof metadataUserExternalId === "string" &&
    metadataUserExternalId.toLowerCase() === targetLower
  ) {
    const legacyUserParticipant = participants.find((participant) =>
      !availableAgents.some((agent) =>
        (typeof agent.id === "string" &&
          agent.id.toLowerCase() === participant.toLowerCase()) ||
        (typeof agent.name === "string" &&
          agent.name.toLowerCase() === participant.toLowerCase())
      )
    );
    if (legacyUserParticipant) {
      return legacyUserParticipant;
    }
    return normalizedTargetId;
  }

  if (isHumanAliasTarget(normalizedTargetId)) {
    const humanParticipants = participants.filter((participant) =>
      !availableAgents.some((agent) =>
        (typeof agent.id === "string" &&
          agent.id.toLowerCase() === participant.toLowerCase()) ||
        (typeof agent.name === "string" &&
          agent.name.toLowerCase() === participant.toLowerCase())
      )
    );

    if (humanParticipants.length === 1) {
      return normalizedTargetId;
    }
  }

  return null;
}

export interface RoutingIntent {
  routeTo: string[];
  askTo: string[];
}

export type NextTurn =
  | { kind: "agent"; targetId: string; targetQueue: string[] }
  | { kind: "human"; targetId: string }
  | { kind: "stop" };

export interface ResolveNextTurnInput {
  sender: {
    id: string;
    name?: string | null;
    type: "agent" | "user" | "tool" | "system" | "job";
  };
  thread: Thread;
  availableAgents: Agent[];
  inbound?: {
    targetId?: string | null;
    targetQueue?: string[] | null;
    replyToParticipantId?: string | null;
    replyToTargetQueue?: string[] | null;
  };
  routingIntent?: Partial<RoutingIntent> | null;
  userMentionTargets?: string[];
  multiAgentEnabled?: boolean;
}

function resolveAgentParticipant(
  targetId: string,
  availableAgents: Agent[],
): string | null {
  const targetLower = targetId.trim().toLowerCase();
  if (targetLower.length === 0) return null;
  const matchedAgent = availableAgents.find((agent) =>
    (typeof agent.id === "string" &&
      agent.id.toLowerCase() === targetLower) ||
    (typeof agent.name === "string" &&
      agent.name.toLowerCase() === targetLower)
  );
  return matchedAgent ? (matchedAgent.id ?? matchedAgent.name) as string : null;
}

function resolveHumanParticipant(
  targetId: string,
  thread: Thread,
  availableAgents: Agent[],
): string | null {
  const resolved = resolveThreadParticipantTarget(
    targetId,
    thread,
    availableAgents,
  );
  const participants = Array.isArray(thread.participants)
    ? thread.participants.filter((participant): participant is string =>
      typeof participant === "string" && participant.trim().length > 0
    )
    : [];
  const humanParticipants = participants.filter((participant) =>
    !resolveAgentParticipant(participant, availableAgents)
  );

  if (resolved && !resolveAgentParticipant(resolved, availableAgents)) {
    if (isHumanAliasTarget(resolved) && humanParticipants.length === 1) {
      return humanParticipants[0];
    }
    return resolved;
  }

  if (isHumanAliasTarget(targetId) && humanParticipants.length === 1) {
    return humanParticipants[0];
  }

  return null;
}

function resolveParticipantTurn(
  targetId: string | null | undefined,
  targetQueue: string[],
  thread: Thread,
  availableAgents: Agent[],
): NextTurn {
  if (typeof targetId !== "string" || targetId.trim().length === 0) {
    return { kind: "stop" };
  }

  const resolvedTarget = resolveThreadParticipantTarget(
    targetId,
    thread,
    availableAgents,
  );
  if (!resolvedTarget) return { kind: "stop" };

  const agentTarget = resolveAgentParticipant(resolvedTarget, availableAgents);
  if (agentTarget) {
    return { kind: "agent", targetId: agentTarget, targetQueue };
  }

  const humanTarget = resolveHumanParticipant(
    resolvedTarget,
    thread,
    availableAgents,
  );
  return humanTarget
    ? { kind: "human", targetId: humanTarget }
    : { kind: "stop" };
}

function normalizeRoutingIntent(value: unknown): RoutingIntent {
  const record = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const normalize = (candidate: unknown): string[] =>
    Array.isArray(candidate)
      ? candidate.filter((item): item is string =>
        typeof item === "string" && item.trim().length > 0
      ).map((item) => item.trim())
      : [];

  return {
    routeTo: normalize(record.routeTo),
    askTo: normalize(record.askTo),
  };
}

function normalizeParticipantQueue(
  value: unknown,
  thread: Thread,
  availableAgents: Agent[],
): string[] {
  return normalizeRoutingQueue(value)
    .map((candidate) =>
      resolveThreadParticipantTarget(candidate, thread, availableAgents)
    )
    .filter((candidate): candidate is string => candidate !== null);
}

function consumeCurrentFromQueue(
  targetQueue: string[],
  currentTargetId: string | null | undefined,
): string[] {
  if (
    typeof currentTargetId !== "string" || currentTargetId.trim().length === 0
  ) {
    return targetQueue;
  }

  const currentLower = currentTargetId.trim().toLowerCase();
  let firstUnconsumed = 0;
  while (
    firstUnconsumed < targetQueue.length &&
    targetQueue[firstUnconsumed].trim().toLowerCase() === currentLower
  ) {
    firstUnconsumed++;
  }

  return targetQueue.slice(firstUnconsumed);
}

function prependQueueTarget(targetQueue: string[], targetId: string): string[] {
  const targetLower = targetId.trim().toLowerCase();
  if (targetLower.length === 0) return targetQueue;
  if (targetQueue[0]?.trim().toLowerCase() === targetLower) return targetQueue;
  return [targetId, ...targetQueue];
}

function resolvePersistedUserTarget(
  senderId: string,
  thread: Thread,
  availableAgents: Agent[],
): string | null {
  const metadata = getRuntimeThreadMetadata(thread.metadata);
  const persistedTarget = metadata.participantTargets?.[senderId];
  if (typeof persistedTarget !== "string") return null;

  const resolved = resolveAgentParticipant(persistedTarget, availableAgents);
  return resolved;
}

function resolveSenderAgent(
  sender: ResolveNextTurnInput["sender"],
  availableAgents: Agent[],
): Agent | null {
  if (sender.type !== "agent") return null;
  const senderIdLower = sender.id.trim().toLowerCase();
  const senderNameLower = sender.name?.trim().toLowerCase();

  return availableAgents.find((agent) =>
    (typeof agent.id === "string" &&
      agent.id.toLowerCase() === senderIdLower) ||
    (typeof agent.name === "string" &&
      agent.name.toLowerCase() === senderIdLower) ||
    (typeof senderNameLower === "string" &&
      typeof agent.id === "string" &&
      agent.id.toLowerCase() === senderNameLower) ||
    (typeof senderNameLower === "string" &&
      typeof agent.name === "string" &&
      agent.name.toLowerCase() === senderNameLower)
  ) ?? null;
}

function isAllowedExplicitRoutingTarget(
  input: ResolveNextTurnInput,
  targetId: string,
): boolean {
  const resolvedTarget = resolveThreadParticipantTarget(
    targetId,
    input.thread,
    input.availableAgents,
  );
  if (!resolvedTarget) return false;

  const targetAgent = resolveAgentParticipant(
    resolvedTarget,
    input.availableAgents,
  );
  if (!targetAgent) return true;

  const senderAgent = resolveSenderAgent(input.sender, input.availableAgents);
  const allowedAgents = senderAgent?.allowedAgents;
  if (!Array.isArray(allowedAgents) || allowedAgents.length === 0) return true;

  const allowed = new Set(
    allowedAgents.map((candidate) => candidate.trim().toLowerCase()),
  );
  if (allowed.has(targetAgent.toLowerCase())) return true;

  const matchedTargetAgent = input.availableAgents.find((agent) =>
    agent.id === targetAgent || agent.name === targetAgent
  );

  return Boolean(
    (typeof matchedTargetAgent?.id === "string" &&
      allowed.has(matchedTargetAgent.id.toLowerCase())) ||
      (typeof matchedTargetAgent?.name === "string" &&
        allowed.has(matchedTargetAgent.name.toLowerCase())),
  );
}

function firstAllowedExplicitRoutingTarget(
  input: ResolveNextTurnInput,
  targets: string[],
): string | null {
  return targets.find((target) =>
    isAllowedExplicitRoutingTarget(input, target)
  ) ?? null;
}

export function resolveNextTurn(input: ResolveNextTurnInput): NextTurn {
  const senderActsLikeUser = input.sender.type === "user" ||
    input.sender.type === "job";

  if (input.sender.type === "tool") {
    const replyTarget = input.inbound?.replyToParticipantId ?? input.sender.id;
    const replyQueue = normalizeParticipantQueue(
      input.inbound?.replyToTargetQueue ?? [],
      input.thread,
      input.availableAgents,
    );
    return resolveParticipantTurn(
      replyTarget,
      replyQueue,
      input.thread,
      input.availableAgents,
    );
  }

  if (input.multiAgentEnabled === false) {
    if (!senderActsLikeUser) {
      return { kind: "stop" };
    }

    const directTarget = input.inbound?.targetId ??
      input.userMentionTargets?.[0] ??
      null;
    return resolveParticipantTurn(
      directTarget,
      [],
      input.thread,
      input.availableAgents,
    );
  }

  const inboundTargetId = input.inbound?.targetId ?? null;
  const inboundQueue = normalizeParticipantQueue(
    input.inbound?.targetQueue ?? [],
    input.thread,
    input.availableAgents,
  );
  const baseQueue = consumeCurrentFromQueue(inboundQueue, inboundTargetId);
  const routingIntent = {
    routeTo: input.routingIntent?.routeTo ?? [],
    askTo: input.routingIntent?.askTo ?? [],
  };

  const askTarget = firstAllowedExplicitRoutingTarget(
    input,
    routingIntent.askTo,
  );
  if (askTarget) {
    const askQueue = prependQueueTarget(baseQueue, input.sender.id);
    return resolveParticipantTurn(
      askTarget,
      askQueue,
      input.thread,
      input.availableAgents,
    );
  }

  const routeTarget = firstAllowedExplicitRoutingTarget(
    input,
    routingIntent.routeTo,
  );
  if (routeTarget) {
    return resolveParticipantTurn(
      routeTarget,
      baseQueue,
      input.thread,
      input.availableAgents,
    );
  }

  if (senderActsLikeUser && input.userMentionTargets?.length) {
    const mentionRoute = buildMentionTargetRoute(input.userMentionTargets, {
      returnTarget: input.sender.id,
    });
    if (mentionRoute) {
      return resolveParticipantTurn(
        mentionRoute.targetId,
        mentionRoute.targetQueue,
        input.thread,
        input.availableAgents,
      );
    }
  }

  if (senderActsLikeUser && inboundTargetId) {
    return resolveParticipantTurn(
      inboundTargetId,
      baseQueue,
      input.thread,
      input.availableAgents,
    );
  }

  if (senderActsLikeUser) {
    const persistedTarget = resolvePersistedUserTarget(
      input.sender.id,
      input.thread,
      input.availableAgents,
    );
    if (persistedTarget) {
      return resolveParticipantTurn(
        persistedTarget,
        [],
        input.thread,
        input.availableAgents,
      );
    }

    const senderLower = input.sender.id.trim().toLowerCase();
    const defaultAgentParticipant = Array.isArray(input.thread.participants)
      ? input.thread.participants.find((participant) => {
        const participantLower = participant.trim().toLowerCase();
        return participantLower !== senderLower &&
          Boolean(resolveAgentParticipant(participant, input.availableAgents));
      })
      : null;
    if (defaultAgentParticipant) {
      return resolveParticipantTurn(
        defaultAgentParticipant,
        [],
        input.thread,
        input.availableAgents,
      );
    }
  }

  if (baseQueue.length > 0) {
    const [nextTarget, ...remainingQueue] = baseQueue;
    return resolveParticipantTurn(
      nextTarget,
      remainingQueue,
      input.thread,
      input.availableAgents,
    );
  }

  return { kind: "stop" };
}

export function buildToolReplyRoutingMetadata(
  toolEmitterId: string,
  nextTurn: NextTurn,
): ToolReplyRoutingMetadata {
  const emitterId = toolEmitterId.trim();
  const replyToTargetQueue = nextTurn.kind === "agent"
    ? prependQueueTarget(nextTurn.targetQueue, nextTurn.targetId)
    : nextTurn.kind === "human"
    ? [nextTurn.targetId]
    : [];

  return {
    replyToParticipantId: emitterId,
    replyToTargetQueue,
  };
}

/**
 * Check and update agent turn counter for loop prevention.
 *
 * - User messages reset the counter
 * - Agent-to-agent messages increment the counter
 * - When maxAgentTurns is reached, force target to a user
 */
async function checkAndUpdateAgentTurns(
  ops: Operations,
  thread: Thread,
  senderType: "agent" | "user" | "tool" | "system" | "job",
  targetId: string,
  availableAgents: Agent[],
  maxAgentTurns: number = 5,
): Promise<AgentTurnCheckResult> {
  const metadata = getRuntimeThreadMetadata(thread.metadata);
  const configuredMax = metadata.maxAgentTurns ?? maxAgentTurns;

  if (senderType === "user" || senderType === "job") {
    // User message resets counter
    if (metadata.agentTurnCount && metadata.agentTurnCount > 0) {
      const updatedMetadata = setRuntimeThreadMetadata(thread.metadata, {
        agentTurnCount: 0,
      });
      await ops.updateThread(thread.id as string, {
        metadata: getSerializableThreadMetadata(updatedMetadata),
      });
      (thread as { metadata: unknown }).metadata = updatedMetadata;
    }
    return { shouldForceUserTarget: false };
  }

  if (senderType === "agent") {
    // Check if target is another agent
    const targetIsAgent = availableAgents.some((a) =>
      a.id === targetId || a.name === targetId
    );

    if (targetIsAgent) {
      const newCount = (metadata.agentTurnCount ?? 0) + 1;

      if (newCount >= configuredMax) {
        // Force target to a user in the thread
        const userInThread = thread.participants?.find((p) =>
          !availableAgents.some((a) => a.name === p || a.id === p)
        );

        console.warn(
          `[multi-agent] Max agent turns (${configuredMax}) reached, forcing target to user`,
        );

        // Reset counter
        const updatedMetadata = setRuntimeThreadMetadata(thread.metadata, {
          agentTurnCount: 0,
        });
        await ops.updateThread(thread.id as string, {
          metadata: getSerializableThreadMetadata(updatedMetadata),
        });
        (thread as { metadata: unknown }).metadata = updatedMetadata;

        return { shouldForceUserTarget: true, userToTarget: userInThread };
      }

      // Update counter
      const updatedMetadata = setRuntimeThreadMetadata(thread.metadata, {
        agentTurnCount: newCount,
      });
      await ops.updateThread(thread.id as string, {
        metadata: getSerializableThreadMetadata(updatedMetadata),
      });
      (thread as { metadata: unknown }).metadata = updatedMetadata;
    } else {
      // Target is user, reset counter
      if (metadata.agentTurnCount && metadata.agentTurnCount > 0) {
        const updatedMetadata = setRuntimeThreadMetadata(thread.metadata, {
          agentTurnCount: 0,
        });
        await ops.updateThread(thread.id as string, {
          metadata: getSerializableThreadMetadata(updatedMetadata),
        });
        (thread as { metadata: unknown }).metadata = updatedMetadata;
      }
    }
  }

  return { shouldForceUserTarget: false };
}

type NormalizedToolCall = {
  id: string | null;
  tool: { id: string; name?: string };
  args: Record<string, unknown>;
  // Batch tracking for multiple tool calls from a single LLM response
  batchId?: string | null;
  batchSize?: number | null;
  batchIndex?: number | null;
};

interface MessageContextDetails {
  senderId: string;
  senderType: "agent" | "user" | "tool" | "system" | "job";
  senderName: string;
  contentText: string;
  toolCalls: NormalizedToolCall[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function buildBaseMessageMetadata(
  payload: MessagePayload,
  queueMetadata: unknown,
): Record<string, unknown> {
  return {
    ...(isRecord(payload.metadata) ? payload.metadata : {}),
    ...(
      queueMetadata && typeof queueMetadata === "object" &&
        !Array.isArray(queueMetadata)
        ? Object.fromEntries(
          Object.entries(queueMetadata as Record<string, unknown>).filter(
            ([key]) =>
              key === "routing" || key === "visibility" ||
              key === "internalConversation" || key === "runSender" ||
              key === "usageNodeId" || key === "llmAttemptId" ||
              key === "llmError",
          ),
        )
        : {}
    ),
  } as Record<string, unknown>;
}

function extractTextContent(content: MessagePayload["content"]): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (!part || typeof part !== "object") return "";
      const typed = part as { type?: string; text?: string; value?: unknown };
      if (typed.type === "text" && typeof typed.text === "string") {
        return typed.text;
      }
      if (typed.type === "json") {
        return JSON.stringify(typed.value ?? "");
      }
      return "";
    }).join("");
  }
  return "";
}

function normalizeToolCalls(
  toolCalls: MessagePayload["toolCalls"],
): NormalizedToolCall[] {
  if (!Array.isArray(toolCalls)) return [];
  return toolCalls
    .filter((call): call is NonNullable<typeof call> =>
      Boolean(call && call.tool?.id)
    )
    .map((call) => {
      const callWithBatch = call as typeof call & {
        batchId?: string | null;
        batchSize?: number | null;
        batchIndex?: number | null;
      };

      let parsedArgs: Record<string, unknown> = {};
      if (typeof call.args === "string") {
        try {
          parsedArgs = JSON.parse(call.args);
        } catch { /* ignore */ }
      } else if (isRecord(call.args)) {
        parsedArgs = call.args;
      }

      return {
        id: call.id ?? null,
        tool: { id: call.tool.id, name: call.tool.name ?? call.tool.id },
        args: parsedArgs,
        batchId: callWithBatch.batchId ?? null,
        batchSize: callWithBatch.batchSize ?? null,
        batchIndex: callWithBatch.batchIndex ?? null,
      };
    });
}

function getMessageContext(payload: MessagePayload): MessageContextDetails {
  const senderType =
    (payload.sender?.type ?? "user") as MessageContextDetails["senderType"];
  const senderId = payload.sender?.id ?? payload.sender?.externalId ??
    payload.sender?.name ?? "user";
  const senderName = payload.sender?.name ?? senderId;
  return {
    senderId: senderId,
    senderType,
    senderName,
    contentText: extractTextContent(payload.content),
    toolCalls: normalizeToolCalls(payload.toolCalls),
  };
}

function resolveStoredSender(
  senderIdentity: { id?: unknown; externalId?: unknown } | null | undefined,
  fallbackSenderId: string,
) {
  const senderExternalId = typeof senderIdentity?.externalId === "string"
    ? senderIdentity.externalId.trim()
    : "";
  const senderParticipantId = typeof senderIdentity?.id === "string"
    ? senderIdentity.id
    : null;

  return {
    senderExternalId,
    senderParticipantId,
    storageSenderId: senderParticipantId ?? fallbackSenderId,
  };
}

// Import Participant Lifecycle logic
import { process as ensureParticipants } from "../participant_lifecycle/message.created.ts";

export const messageProcessor: EventProcessor<
  NewMessageEventPayload,
  ProcessorDeps
> = {
  shouldProcess: () => true,
  process: async (event: Event, deps: ProcessorDeps) => {
    const eventType = (event as unknown as { type?: string }).type;
    const isLifecycleMessageCreated = eventType === "message.created";
    // 1. Ensure participants exist (Identity Lifecycle Side-effect)
    const senderIdentity = await ensureParticipants(event, deps);

    const { db, thread, context } = deps;
    const ops = db.ops;
    const messageService = createMessageService({
      collections: context.collections,
      ops,
    });

    const payload = event.payload as NewMessageEventPayload;

    const threadId = typeof event.threadId === "string"
      ? event.threadId
      : (() => {
        throw new Error("Invalid thread id for message event");
      })();

    const messageContext = getMessageContext(payload);

    if (
      (messageContext.senderType === "agent" ||
        messageContext.senderType === "tool") &&
      typeof event.parentEventId === "string"
    ) {
      const superseded = await detectNewerHumanInputSupersession(
        ops,
        threadId,
        event.parentEventId,
        context.namespace,
      );

      if (
        superseded && messageContext.senderType === "agent" &&
        messageContext.toolCalls.length > 0
      ) {
        return { producedEvents: [] };
      }

      if (superseded) {
        payload.metadata = withSupersededSkipRoutingMetadata(
          payload.metadata,
          superseded,
        );
      }
    }

    const baseMetadata = buildBaseMessageMetadata(payload, event.metadata);

    const { messageMetadata, toolCallMetadata, contentOverride } =
      await processAssetsForNewMessage({
        payload,
        baseMetadata,
        senderId: messageContext.senderId,
        senderType: messageContext.senderType,
        context,
        ops,
        event,
        threadId,
        emitToStream: deps.emitToStream,
      });

    let toolCallId: string | null = null;
    for (const entry of toolCallMetadata) {
      if (entry && typeof entry === "object") {
        const maybeId = (entry as { id?: unknown }).id;
        if (typeof maybeId === "string") {
          toolCallId = maybeId;
          break;
        }
      }
    }
    if (!toolCallId) {
      const firstToolCall = messageContext.toolCalls.find((call) =>
        typeof call.id === "string" && call.id.length > 0
      );
      if (firstToolCall?.id) {
        toolCallId = firstToolCall.id;
      }
    }

    if (typeof contentOverride === "string") {
      payload.content = contentOverride;
    }

    const persistedContent = typeof contentOverride === "string"
      ? contentOverride
      : messageContext.contentText;

    // Keep senderId bound to the participant node id when available so
    // collection relations continue to work. Store the
    // conversational identity separately in metadata for prompt/history use.
    const {
      senderExternalId,
      senderParticipantId,
      storageSenderId,
    } = resolveStoredSender(
      senderIdentity as { id?: unknown; externalId?: unknown } | null,
      messageContext.senderId,
    );
    const persistedMessageMetadata = {
      ...(messageMetadata ?? {}),
      senderExternalId: senderExternalId.length > 0
        ? senderExternalId
        : messageContext.senderId,
      senderDisplayName: messageContext.senderName,
      ...(senderParticipantId ? { senderParticipantId } : {}),
    };

    const incomingMsg = {
      threadId,
      senderId: storageSenderId,
      senderType: messageContext.senderType,
      senderUserId: senderParticipantId,
      content: persistedContent,
      toolCallId: toolCallId,
      toolCalls: payload.toolCalls ?? null,
      reasoning: payload.reasoning ?? null,
      metadata: persistedMessageMetadata,
    };

    // Persist incoming legacy NEW_MESSAGE events. Lifecycle `message.created`
    // events already committed the message in the same transaction that
    // appended this outbox row, so processing must not duplicate it.
    const createdMessage = isLifecycleMessageCreated
      ? {
        ...incomingMsg,
        id: typeof (event as unknown as { subjectId?: unknown }).subjectId ===
            "string"
          ? (event as unknown as { subjectId: string }).subjectId
          : typeof (event as unknown as { id?: unknown }).id === "string"
          ? (event as unknown as { id: string }).id
          : crypto.randomUUID(),
        createdAt: event.createdAt ?? new Date(),
        updatedAt: event.updatedAt ?? new Date(),
      } as unknown as NewMessage & { id: string }
      : await messageService.create(
        incomingMsg,
        context.namespace,
      );

    if (isLifecycleMessageCreated) {
      await ops.mutate.graph.updateNode(
        createdMessage.id,
        {
          content: incomingMsg.content,
          data: {
            messageId: createdMessage.id,
            threadId,
            senderId: incomingMsg.senderId,
            senderType: incomingMsg.senderType,
            senderUserId: incomingMsg.senderUserId ?? null,
            externalId: null,
            toolCallId: incomingMsg.toolCallId ?? null,
            toolCalls: incomingMsg.toolCalls ?? null,
            reasoning: incomingMsg.reasoning ?? null,
            metadata: incomingMsg.metadata ?? null,
          },
        },
        {
          threadId,
          namespace: context.namespace ?? null,
          traceId: typeof event.traceId === "string" ? event.traceId : null,
          causationId: typeof event.id === "string" ? event.id : null,
          eventPayload: {
            content: incomingMsg.content,
            toolCallId: incomingMsg.toolCallId,
            toolCalls: incomingMsg.toolCalls,
            reasoning: incomingMsg.reasoning,
            metadata: incomingMsg.metadata,
          },
        },
      );
    }
    // Emit ENTITY_EXTRACT event for agents with entity extraction enabled
    // Events go to a background child thread to avoid blocking main thread processing
    // Deduplicate by config to avoid redundant LLM calls for same content
    const entityExtractEvents: Array<
      {
        threadId: string;
        type: string;
        payload: unknown;
        parentEventId?: string;
        traceId?: string;
        priority?: number;
        namespace?: string;
      }
    > = [];
    const agentsForExtraction = context.agents || [];

    // Group agents by their extraction config to deduplicate
    // Key: JSON-serialized config (entityTypes + thresholds)
    // Value: { config, agentIds: string[] }
    const configGroups = new Map<string, {
      entityConfig: NonNullable<
        typeof agentsForExtraction[0]["ragOptions"]
      >["entityExtraction"];
      agentIds: string[];
    }>();

    for (const agent of agentsForExtraction) {
      const entityConfig = agent.ragOptions?.entityExtraction;
      if (
        entityConfig?.enabled && persistedContent.trim() && context.namespace
      ) {
        const agentIdStr = typeof agent.id === "string" ? agent.id : agent.name;

        // Create a config key that captures the extraction behavior
        const configKey = JSON.stringify({
          entityTypes: entityConfig.entityTypes ?? [],
          similarityThreshold: entityConfig.similarityThreshold,
          autoMergeThreshold: entityConfig.autoMergeThreshold,
          llmConfig: (entityConfig as { llmConfig?: unknown }).llmConfig ??
            null,
        });

        const existing = configGroups.get(configKey);
        if (existing) {
          existing.agentIds.push(agentIdStr);
        } else {
          configGroups.set(configKey, {
            entityConfig,
            agentIds: [agentIdStr],
          });
        }
      }
    }

    // Get the message node ID once (shared across all extraction events)
    let messageNodeId: string | null = null;
    let backgroundThreadId: string | null = null;

    if (configGroups.size > 0) {
      try {
        const messageNodes = context.namespace
          ? await ops.getNodesByNamespace(context.namespace, "message")
          : [];
        const messageNode = messageNodes.find((n) => {
          const data = n.data as Record<string, unknown> | null;
          return data?.messageId === createdMessage.id;
        });
        messageNodeId = messageNode?.id as string ?? null;

        // Get or create a background child thread for entity extraction
        // This prevents blocking the main thread's event queue
        if (configGroups.size > 0) {
          const bgThreadExternalId = `${threadId}:background`;
          const existingBgThread = await ops.getThreadByExternalId(
            bgThreadExternalId,
            context.namespace,
          );
          if (existingBgThread) {
            backgroundThreadId = existingBgThread.id as string;
          } else {
            const bgThread = await ops.findOrCreateThread(undefined, {
              name: "Background Processing",
              description: `Background worker thread for ${threadId}`,
              participants: [],
              externalId: bgThreadExternalId,
              namespace: context.namespace ?? null,
              parentThreadId: threadId,
              status: "active",
              mode: "immediate",
            });
            backgroundThreadId = bgThread.id as string;
          }
        }
      } catch (err) {
        console.warn(
          `[NEW_MESSAGE] Failed to setup message node follow-up work:`,
          err,
        );
      }
    }

    // Create one event per unique config. Entities are stored in the tenant namespace.
    // Events are queued to the background thread to avoid blocking main thread
    if (messageNodeId && backgroundThreadId) {
      for (const [, group] of configGroups) {
        const { entityConfig, agentIds } = group;
        const entityNamespace = context.namespace;
        if (entityNamespace) {
          try {
            const extractPayload: EntityExtractPayload = {
              sourceNodeId: messageNodeId,
              content: persistedContent,
              namespace: entityNamespace,
              sourceType: "message",
              sourceContext: {
                threadId,
                agentId: agentIds[0], // Primary agent for this namespace
              },
              // Include extraction config inline to avoid agent lookup
              extractionConfig: {
                llmConfig: (entityConfig as {
                  llmConfig?: {
                    provider: string;
                    model?: string;
                    apiKey?: string;
                    temperature?: number;
                    maxTokens?: number;
                  };
                }).llmConfig,
                similarityThreshold: entityConfig?.similarityThreshold,
                autoMergeThreshold: entityConfig?.autoMergeThreshold,
                entityTypes: entityConfig?.entityTypes,
              },
            };

            if (isLifecycleMessageCreated && ops.mutate?.graph) {
              await ops.mutate.graph.createNode({
                namespace: entityNamespace,
                type: "entity_extraction",
                name: `entity_extraction:${messageNodeId}`,
                content: null,
                sourceType: "message",
                sourceId: messageNodeId,
                data: extractPayload as unknown as Record<string, unknown>,
              }, {
                threadId,
                namespace: entityNamespace,
                traceId: typeof event.traceId === "string"
                  ? event.traceId
                  : null,
                causationId: typeof event.id === "string" ? event.id : null,
                priority: 0,
                status: "pending",
                eventPayload: extractPayload as unknown as Record<
                  string,
                  unknown
                >,
              });
            } else {
              entityExtractEvents.push({
                threadId: backgroundThreadId, // Use background thread instead of main thread
                type: "ENTITY_EXTRACT",
                payload: extractPayload,
                parentEventId: typeof event.id === "string"
                  ? event.id
                  : undefined,
                traceId: typeof event.traceId === "string"
                  ? event.traceId
                  : undefined,
                priority: 0, // Normal priority within the background thread
                namespace: entityNamespace,
              });
            }
          } catch (err) {
            console.warn(
              `[NEW_MESSAGE] Failed to queue entity extraction for namespace "${entityNamespace}":`,
              err,
            );
          }
        }
      }
    }

    // Allow custom processors to emit follow-up NEW_MESSAGE events that should not trigger default routing/LLM
    const skipRouting =
      !!(messageMetadata && typeof messageMetadata === "object" &&
        (messageMetadata as { skipRouting?: unknown }).skipRouting === true);
    if (skipRouting) {
      return { producedEvents: entityExtractEvents as unknown as NewEvent[] };
    }

    // ====================================================================
    // Tool Result Batch Aggregation
    // ====================================================================
    // If this is a tool result that's part of a batch, we need to wait
    // for all results before triggering the next LLM call.
    // ====================================================================
    const batchInfo = extractBatchInfo(payload);
    const isToolResult = messageContext.senderType === "tool";

    if (
      isToolResult && batchInfo.batchId && batchInfo.batchSize &&
      batchInfo.batchSize > 1
    ) {
      // This is a batched tool result - we need to aggregate
      const toolCallMeta = Array.isArray(payload.metadata?.toolCalls)
        ? (payload.metadata.toolCalls as ToolInvocation[])[0]
        : null;

      if (toolCallMeta) {
        const storedResult: StoredToolResult = {
          callId: toolCallMeta.id ?? `unknown_${Date.now()}`,
          name: toolCallMeta.tool?.id ?? "unknown",
          args: typeof toolCallMeta.args === "string"
            ? toolCallMeta.args
            : JSON.stringify(toolCallMeta.args ?? {}),
          output: toolCallMeta.output,
          status: toolCallMeta.status ?? "completed",
          batchIndex: batchInfo.batchIndex ?? 0,
          content: messageContext.contentText,
        };

        const { batch, isComplete } = await storeToolResultInBatch(
          ops,
          thread,
          batchInfo.batchId,
          batchInfo.batchSize,
          { id: messageContext.senderId, name: messageContext.senderName },
          messageContext.senderId,
          storedResult,
        );

        if (!isComplete) {
          // Not all results are in yet - skip routing, don't trigger LLM
          // The message is already persisted, so it will be in history
          return {
            producedEvents: entityExtractEvents as unknown as NewEvent[],
          };
        }

        await clearCompletedBatch(ops, thread, batchInfo.batchId);

        // The aggregated results are now in the message history (each was persisted)
        // We can proceed normally - the LLM will see all tool results in history
      }
    }

    // Resolve targets using new multi-agent routing
    const availableAgents = context.agents || [];
    const producedEvents: NewEvent[] = [];

    const normalizedToolCalls = messageContext.toolCalls;
    const eventMetadata = event.metadata &&
        typeof event.metadata === "object" &&
        !Array.isArray(event.metadata)
      ? event.metadata as Record<string, unknown>
      : {};
    const routingIntent = normalizeRoutingIntent(eventMetadata.routing);
    const inboundRouting = {
      targetId: typeof eventMetadata.targetId === "string"
        ? eventMetadata.targetId
        : null,
      targetQueue: Array.isArray(eventMetadata.targetQueue)
        ? eventMetadata.targetQueue.filter((candidate): candidate is string =>
          typeof candidate === "string"
        )
        : [],
      replyToParticipantId:
        typeof eventMetadata.replyToParticipantId === "string"
          ? eventMetadata.replyToParticipantId
          : null,
      replyToTargetQueue: Array.isArray(eventMetadata.replyToTargetQueue)
        ? eventMetadata.replyToTargetQueue.filter((
          candidate,
        ): candidate is string => typeof candidate === "string")
        : [],
    };

    // ====================================================================
    // Tool Call Processing (BEFORE target resolution)
    // ====================================================================
    // If this message (from an agent) includes tool calls, we need to emit
    // TOOL_CALL events. The tool calls belong to the SENDER (the agent that
    // made the request), not the target.
    // ====================================================================
    if (
      normalizedToolCalls.length > 0 &&
      (messageContext.senderType === "agent" ||
        messageContext.senderType === "job")
    ) {
      // Find the sending agent (may be absent if filtered out by env config)
      const sendingAgent = availableAgents.find((a) =>
        a.id === messageContext.senderId || a.name === messageContext.senderName
      );

      // Fall back to message context when agent is not in availableAgents
      const agentForToolCalls = sendingAgent ?? {
        id: messageContext.senderId,
        name: messageContext.senderName,
      };
      const senderIdForTool =
        (agentForToolCalls.id ?? agentForToolCalls.name) as string;
      const nextTurnAfterTools = resolveNextTurn({
        sender: {
          id: senderIdForTool,
          name: agentForToolCalls.name,
          type: "agent",
        },
        thread,
        availableAgents,
        inbound: inboundRouting,
        routingIntent,
        multiAgentEnabled: context.multiAgent?.enabled === true,
      });
      const toolReplyMetadata = buildToolReplyRoutingMetadata(
        senderIdForTool,
        nextTurnAfterTools,
      );

      for (let i = 0; i < normalizedToolCalls.length; i += 1) {
        const call = normalizedToolCalls[i];
        const toolId = call.tool?.id || agentForToolCalls.name ||
          "unknown_tool";
        const toolName = call.tool?.name || toolId;
        const callId = call.id || `${toolId}_${i}`;
        const argumentsString = typeof call.args === "string"
          ? call.args
          : JSON.stringify(call.args ?? {});

        const toolCallEventPayload = {
          agent: { id: senderIdForTool, name: agentForToolCalls.name },
          senderId: senderIdForTool,
          senderType: "agent",
          toolCall: {
            id: callId,
            tool: {
              id: toolId,
              name: toolName,
            },
            args: argumentsString,
            batchId: call.batchId ?? null,
            batchSize: call.batchSize ?? null,
            batchIndex: call.batchIndex ?? null,
          },
        } as ToolCallEventPayload;
        const toolMetadata = withRunSenderMetadata({
          sourceMessageId: createdMessage.id,
          ...(call.batchId ? { batchId: call.batchId } : {}),
          ...(typeof call.batchSize === "number"
            ? { batchSize: call.batchSize }
            : {}),
          ...(typeof call.batchIndex === "number"
            ? { batchIndex: call.batchIndex }
            : {}),
          ...(toolReplyMetadata.replyToParticipantId ||
              toolReplyMetadata.replyToTargetQueue.length > 0
            ? toolReplyMetadata
            : {}),
        }, pickRunSenderFromMetadata(eventMetadata))!;
        if (isLifecycleMessageCreated && ops.mutate?.toolExecutions) {
          await ops.mutate.toolExecutions.create({
            threadId,
            messageId: createdMessage.id,
            eventId: typeof event.id === "string" ? event.id : null,
            agentId: senderIdForTool,
            agentName: agentForToolCalls.name,
            toolCallId: callId,
            tool: {
              id: toolId,
              name: toolName,
            },
            args: argumentsString,
            status: "processing",
            metadata: toolMetadata,
            namespace: context.namespace,
          }, {
            traceId: typeof event.traceId === "string" ? event.traceId : null,
            causationId: typeof event.id === "string" ? event.id : null,
            priority: EVENT_PRIORITIES.SETTLEMENT,
            status: "pending",
            metadata: toolMetadata,
            eventPayload: toolCallEventPayload as unknown as Record<
              string,
              unknown
            >,
          });
        } else {
          producedEvents.push({
            threadId,
            type: "TOOL_CALL",
            payload: toolCallEventPayload,
            parentEventId: typeof event.id === "string" ? event.id : undefined,
            traceId: typeof event.traceId === "string"
              ? event.traceId
              : undefined,
            priority: EVENT_PRIORITIES.SETTLEMENT,
            metadata: toolMetadata,
          });
        }
      }

      // Tool calls processed - return without triggering LLM call
      // The tool results will come back as NEW_MESSAGE events and route back to this agent
      return {
        producedEvents: [
          ...producedEvents,
          ...(entityExtractEvents as unknown as NewEvent[]),
        ],
      };
    }

    const userMentionTargets = (
        (messageContext.senderType === "user" ||
          messageContext.senderType === "job") &&
        context.multiAgent?.enabled === true
      )
      ? parseMentions(
        messageContext.contentText,
        thread.participants ?? null,
        availableAgents,
      )
      : [];

    const nextTurn = resolveNextTurn({
      sender: {
        id: messageContext.senderId,
        name: messageContext.senderName,
        type: messageContext.senderType,
      },
      thread,
      availableAgents,
      inbound: inboundRouting,
      routingIntent,
      userMentionTargets,
      multiAgentEnabled: context.multiAgent?.enabled === true,
    });

    if (nextTurn.kind !== "agent") {
      return { producedEvents: entityExtractEvents as unknown as NewEvent[] };
    }

    let targetResolution: TargetResolution = {
      targetId: nextTurn.targetId,
      targetQueue: nextTurn.targetQueue,
    };

    // Check for loop prevention (agent-to-agent turn limit)
    const maxAgentTurns = context.multiAgent?.maxAgentTurns ?? 5;
    const loopCheck = await checkAndUpdateAgentTurns(
      ops,
      thread,
      messageContext.senderType,
      targetResolution.targetId,
      availableAgents,
      maxAgentTurns,
    );

    if (loopCheck.shouldForceUserTarget) {
      const fallbackAgentId = context.multiAgent?.maxTurnsFallbackAgent;
      const fallbackAgent = fallbackAgentId
        ? availableAgents.find((a) =>
          a.id === fallbackAgentId || a.name === fallbackAgentId
        )
        : undefined;

      // Persist reset to break the agent loop for future messages
      const updatedMetadata = setRuntimeThreadMetadata(thread.metadata, {
        participantTargets: {},
        agentTurnCount: 0,
      });
      await ops.updateThread(thread.id as string, {
        metadata: getSerializableThreadMetadata(updatedMetadata),
      });
      (thread as unknown as { metadata: unknown }).metadata = updatedMetadata;

      if (fallbackAgent) {
        // Route to the designated fallback agent instead of hard-stopping.
        // The fallback agent (e.g. lead/coordinator) can synthesize and
        // reply to the user.
        targetResolution = {
          targetId: (fallbackAgent.id ?? fallbackAgent.name) as string,
          targetQueue: [],
        };
        console.warn(
          `[multi-agent] Max agent turns (${maxAgentTurns}) reached, routing to fallback agent: ${
            fallbackAgent.name ?? fallbackAgent.id
          }`,
        );
      } else {
        // No fallback agent — hard-stop, don't trigger any more LLM calls
        return { producedEvents: entityExtractEvents as unknown as NewEvent[] };
      }
    }

    // Get the target agent (case-insensitive matching)
    const targetIdLower = targetResolution.targetId.toLowerCase();
    const targetAgent = availableAgents.find((a) =>
      (typeof a.id === "string" && a.id.toLowerCase() === targetIdLower) ||
      (typeof a.name === "string" && a.name.toLowerCase() === targetIdLower)
    );

    if (!targetAgent) {
      // Target is not an agent (might be a user) - no LLM call needed
      return { producedEvents: entityExtractEvents as unknown as NewEvent[] };
    }

    // === Message coalescing ===
    // When this is a plain text message (no tool calls, not a tool result),
    // look for other pending NEW_MESSAGE events from the same sender in this
    // thread. If they would route to the same agent, absorb them now so the
    // LLM sees all concurrent inputs in a single context window instead of
    // spawning separate chains.
    if (
      normalizedToolCalls.length === 0 && messageContext.senderType !== "tool"
    ) {
      const eventId = typeof event.id === "string" ? event.id : "";
      const targetIdLowerCoalesce =
        ((targetAgent.id ?? targetAgent.name) as string).toLowerCase();
      const candidates = await ops.peekCoalescableCandidates(
        threadId,
        eventId,
        context.namespace,
      );
      const idsToAbsorb: string[] = [];

      for (const candidate of candidates) {
        const candidatePayload = candidate.payload as NewMessageEventPayload;
        const candidateBaseMetadata = buildBaseMessageMetadata(
          candidatePayload,
          candidate.metadata,
        );
        const candidateMeta = isRecord(candidatePayload.metadata)
          ? candidatePayload.metadata as Record<string, unknown>
          : null;

        if (candidateMeta?.skipRouting === true) continue;

        const candidateCtx = getMessageContext(candidatePayload);

        // Only coalesce same-sender plain messages
        if (
          candidateCtx.senderId !== messageContext.senderId ||
          candidateCtx.toolCalls.length > 0 ||
          candidateCtx.senderType === "tool"
        ) continue;

        // Reject candidates whose @mentions target a different agent
        const candidateMentions = parseMentions(
          candidateCtx.contentText,
          thread.participants ?? null,
          availableAgents,
        );
        if (
          candidateMentions.length > 0 &&
          !candidateMentions.some((m) =>
            m.toLowerCase() === targetIdLowerCoalesce
          )
        ) continue;

        idsToAbsorb.push(candidate.id as string);

        const {
          messageMetadata: candidateMessageMetadata,
          toolCallMetadata: candidateToolCallMetadata,
          contentOverride: candidateContentOverride,
        } = await processAssetsForNewMessage({
          payload: candidatePayload,
          baseMetadata: candidateBaseMetadata,
          senderId: candidateCtx.senderId,
          senderType: candidateCtx.senderType,
          context,
          ops,
          event: {
            ...candidate,
            type: "NEW_MESSAGE",
          } as unknown as Event,
          threadId,
          emitToStream: deps.emitToStream,
        });

        // Resolve toolCallId (mirrors incomingMsg logic)
        let candToolCallId: string | null = null;
        for (const entry of candidateToolCallMetadata) {
          if (entry && typeof entry === "object") {
            const maybeId = (entry as { id?: unknown }).id;
            if (typeof maybeId === "string") {
              candToolCallId = maybeId;
              break;
            }
          }
        }

        // Persist absorbed message — id omitted so createMessage generates a ULID
        const candidateSenderIdentity = await ensureParticipants(
          {
            ...candidate,
            type: "NEW_MESSAGE",
          } as unknown as Event,
          deps,
        ) as { id?: unknown; externalId?: unknown } | null;
        const {
          senderExternalId: candidateSenderExternalId,
          senderParticipantId: candidateSenderParticipantId,
          storageSenderId: candidateStorageSenderId,
        } = resolveStoredSender(
          candidateSenderIdentity,
          candidateCtx.senderId,
        );

        const candidatePersistedContent =
          typeof candidateContentOverride === "string"
            ? candidateContentOverride
            : candidateCtx.contentText;

        await messageService.create({
          threadId,
          senderId: candidateStorageSenderId,
          senderType: candidateCtx.senderType,
          senderUserId: candidateSenderParticipantId ?? undefined,
          content: candidatePersistedContent,
          toolCallId: candToolCallId ?? undefined,
          toolCalls: candidatePayload.toolCalls ?? null,
          metadata: {
            ...(candidateMessageMetadata ?? {}),
            senderExternalId: candidateSenderExternalId.length > 0
              ? candidateSenderExternalId
              : candidateCtx.senderId,
            senderDisplayName: candidatePayload.sender?.name ??
              candidateCtx.senderId,
            ...(candidateSenderParticipantId
              ? { senderParticipantId: candidateSenderParticipantId }
              : {}),
          },
        }, context.namespace);
      }

      if (idsToAbsorb.length > 0) {
        await ops.claimAndCompleteEventsBatch(idsToAbsorb);
      }
    }

    // Process the target agent - create LLM_CALL
    const targets = [targetAgent];

    for (let idx = 0; idx < targets.length; idx++) {
      const agent = targets[idx];
      if (!agent) continue;

      /** If the message is not a tool call, we need to add the message to the LLM context */

      const agentId = (agent.id ?? agent.name) as string;
      const llmInput = await buildAgentLlmInput({
        deps,
        event,
        threadId,
        agent,
        historyMode: "afterReadyLongTermMemory",
        ragQuery: messageContext.contentText,
      });

      const llmPayload = {
        agent: { id: agent.id ?? undefined, name: agent.name },
        messages: llmInput.messages,
        tools: llmInput.tools,
        config: llmInput.config,
      } as LlmCallEventPayload;

      const llmEventMetadata = {
        targetId: targetResolution.targetId,
        targetQueue: targetResolution.targetQueue,
        sourceMessageId: createdMessage.id,
        sourceMessageSenderId: messageContext.senderId,
        sourceMessageSenderType: messageContext.senderType,
        ...(isRecord(eventMetadata.runSender)
          ? { runSender: eventMetadata.runSender }
          : {}),
        ...(isRecord(messageMetadata) &&
            typeof messageMetadata.visibility === "string"
          ? { visibility: messageMetadata.visibility }
          : {}),
        ...(isRecord(messageMetadata) &&
            isRecord(messageMetadata.internalConversation)
          ? { internalConversation: messageMetadata.internalConversation }
          : {}),
      };

      if (isLifecycleMessageCreated && ops.mutate?.llmAttempts) {
        await ops.mutate.llmAttempts.create({
          threadId,
          messageId: createdMessage.id,
          eventId: typeof event.id === "string" ? event.id : null,
          agentId: agent.id ?? agent.name ?? null,
          agentName: agent.name,
          provider: llmInput.config.provider ?? null,
          model: llmInput.config.model ?? null,
          config: llmInput.config as unknown as Record<string, unknown>,
          messages: llmInput.messages,
          tools: llmInput.tools,
          status: "processing",
          runSender: isRecord(eventMetadata.runSender)
            ? eventMetadata.runSender as Record<string, unknown>
            : null,
          metadata: {
            sourceEventType: eventType,
          },
          namespace: context.namespace,
        }, {
          traceId: typeof event.traceId === "string" ? event.traceId : null,
          causationId: typeof event.id === "string" ? event.id : null,
          priority: priorityForAgentLlmCall(payload),
          status: "pending",
          metadata: llmEventMetadata,
          eventPayload: llmPayload as unknown as Record<string, unknown>,
        });
      } else {
        producedEvents.push({
          threadId,
          type: "LLM_CALL",
          payload: llmPayload,
          parentEventId: typeof event.id === "string" ? event.id : undefined,
          traceId: typeof event.traceId === "string"
            ? event.traceId
            : undefined,
          priority: priorityForAgentLlmCall(payload),
          metadata: llmEventMetadata,
        });
      }
    }

    // Add entity extraction events (low priority, runs after main processing)
    return {
      producedEvents: [
        ...producedEvents,
        ...(entityExtractEvents as unknown as NewEvent[]),
      ],
    };
  },
};

export const { shouldProcess, process } = messageProcessor;
