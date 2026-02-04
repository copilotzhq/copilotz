
// Import Event Queue
import type { NewEvent, EventProcessor } from "@/interfaces/index.ts";

// Import Tools
import { generateAllApiTools } from "@/event-processors/tool_call/generators/api-generator.ts";
import { generateAllMcpTools } from "@/event-processors/tool_call/generators/mcp-generator.ts";
import { getNativeTools } from "@/event-processors/tool_call/native-tools-registry/index.ts";

// Import Agent Interfaces
import type {
    Agent,
    Thread,
    NewMessage,
    ChatContext,
    ProcessorDeps,
    Event,
    MessagePayload,
    LlmCallEventPayload,
    ToolCallEventPayload,
    AgentLlmOptionsResolverArgs,
    ThreadMetadata,
} from "@/interfaces/index.ts";
import { resolveNamespace } from "@/interfaces/index.ts";
import type { EntityExtractPayload, KnowledgeNode } from "@/database/schemas/index.ts";

// Import tool types from their source
import type { ExecutableTool, ToolExecutor } from "@/event-processors/tool_call/types.ts";

type Operations = ProcessorDeps["db"]["ops"];

import type {
    ToolDefinition,
    ChatMessage,
    ProviderConfig,
} from "@/connectors/llm/types.ts";

import type { NewMessageEventPayload } from "@/database/schemas/index.ts";

// Import Generators
import {
    contextGenerator,
    historyGenerator,
    generateRagContext,
    type LLMContextData
} from "./generators/index.ts";

import { processAssetsForNewMessage } from "./generators/asset-generator.ts";

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
    agentName: string;
    senderId: string;
    results: StoredToolResult[];
    createdAt: string;
}

type PendingBatches = Record<string, PendingBatch>;

/**
 * Get pending batches from thread metadata
 */
function getPendingBatches(thread: Thread): PendingBatches {
    const metadata = thread.metadata as Record<string, unknown> | null;
    const pendingBatches = metadata?.pendingToolBatches;
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
    agentName: string,
    senderId: string,
    result: StoredToolResult
): Promise<{ batch: PendingBatch; isComplete: boolean }> {
    const pendingBatches = getPendingBatches(thread);
    
    // Initialize batch if not exists
    if (!pendingBatches[batchId]) {
        pendingBatches[batchId] = {
            batchSize,
            agentName,
            senderId,
            results: [],
            createdAt: new Date().toISOString(),
        };
    }
    
    const batch = pendingBatches[batchId];
    
    // Check if this result is already stored (deduplication)
    const existingIdx = batch.results.findIndex(r => r.callId === result.callId);
    if (existingIdx >= 0) {
        // Already have this result, just return current state
        return {
            batch,
            isComplete: batch.results.length >= batch.batchSize,
        };
    }
    
    // Add new result
    batch.results.push(result);
    
    // Update thread metadata
    const currentMetadata = (thread.metadata ?? {}) as Record<string, unknown>;
    const updatedMetadata = {
        ...currentMetadata,
        pendingToolBatches: pendingBatches,
    };
    
    await ops.crud.threads?.update?.({ id: thread.id }, { metadata: updatedMetadata });
    
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
    batchId: string
): Promise<void> {
    const pendingBatches = getPendingBatches(thread);
    delete pendingBatches[batchId];
    
    const currentMetadata = (thread.metadata ?? {}) as Record<string, unknown>;
    const updatedMetadata = {
        ...currentMetadata,
        pendingToolBatches: Object.keys(pendingBatches).length > 0 ? pendingBatches : undefined,
    };
    
    await ops.crud.threads?.update?.({ id: thread.id }, { metadata: updatedMetadata });
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
        batchSize: typeof metadata?.batchSize === "number" ? metadata.batchSize : null,
        batchIndex: typeof metadata?.batchIndex === "number" ? metadata.batchIndex : null,
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
    agents: Agent[]
): string[] {
    const mentionPattern = /(?<!\w)@([\w](?:[\w.-]*[\w])?)/g;
    const matches = content.matchAll(mentionPattern);
    
    const resolved: string[] = [];
    const seen = new Set<string>();
    
    for (const match of matches) {
        const name = match[1]; // Remove @ prefix via regex capture
        
        // Check if it's a valid participant/agent
        const agent = agents.find(a => a.name === name);
        const isParticipant = participants?.includes(name);
        
        if ((agent || isParticipant) && !seen.has(name)) {
            // Return agent ID if available, otherwise name
            resolved.push((agent?.id ?? name) as string);
            seen.add(name);
        }
    }
    
    return resolved;
}

/**
 * Update a participant's target in thread metadata.
 * This persists the "current conversation target" for routing without @mentions.
 */
async function updateParticipantTarget(
    ops: Operations,
    thread: Thread,
    senderId: string,
    targetId: string
): Promise<void> {
    const metadata = (thread.metadata ?? {}) as ThreadMetadata;
    const participantTargets = metadata.participantTargets ?? {};
    
    const updatedMetadata: ThreadMetadata = {
        ...metadata,
        participantTargets: {
            ...participantTargets,
            [senderId]: targetId
        }
    };
    
    await ops.crud.threads?.update?.({ id: thread.id }, { metadata: updatedMetadata });
    
    // Update local thread object for subsequent operations in same request
    (thread as { metadata: unknown }).metadata = updatedMetadata;
}

/**
 * Target resolution result from discoverTargetForMessage.
 */
interface TargetResolution {
    targetId: string;
    targetQueue: string[];
}

/**
 * Result from agent turn check.
 */
interface AgentTurnCheckResult {
    shouldForceUserTarget: boolean;
    userToTarget?: string;
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
    senderType: "agent" | "user" | "tool" | "system",
    targetId: string,
    availableAgents: Agent[],
    maxAgentTurns: number = 5
): Promise<AgentTurnCheckResult> {
    const metadata = (thread.metadata ?? {}) as ThreadMetadata;
    const configuredMax = metadata.maxAgentTurns ?? maxAgentTurns;
    
    if (senderType === "user") {
        // User message resets counter
        if (metadata.agentTurnCount && metadata.agentTurnCount > 0) {
            const updatedMetadata: ThreadMetadata = { ...metadata, agentTurnCount: 0 };
            await ops.crud.threads?.update?.({ id: thread.id }, { metadata: updatedMetadata });
            (thread as { metadata: unknown }).metadata = updatedMetadata;
        }
        return { shouldForceUserTarget: false };
    }
    
    if (senderType === "agent") {
        // Check if target is another agent
        const targetIsAgent = availableAgents.some(a => 
            a.id === targetId || a.name === targetId
        );
        
        if (targetIsAgent) {
            const newCount = (metadata.agentTurnCount ?? 0) + 1;
            
            if (newCount >= configuredMax) {
                // Force target to a user in the thread
                const userInThread = thread.participants?.find(p => 
                    !availableAgents.some(a => a.name === p || a.id === p)
                );
                
                console.warn(`[multi-agent] Max agent turns (${configuredMax}) reached, forcing target to user`);
                
                // Reset counter
                const updatedMetadata: ThreadMetadata = { ...metadata, agentTurnCount: 0 };
                await ops.crud.threads?.update?.({ id: thread.id }, { metadata: updatedMetadata });
                (thread as { metadata: unknown }).metadata = updatedMetadata;
                
                return { shouldForceUserTarget: true, userToTarget: userInThread };
            }
            
            // Update counter
            const updatedMetadata: ThreadMetadata = { ...metadata, agentTurnCount: newCount };
            await ops.crud.threads?.update?.({ id: thread.id }, { metadata: updatedMetadata });
            (thread as { metadata: unknown }).metadata = updatedMetadata;
        } else {
            // Target is user, reset counter
            if (metadata.agentTurnCount && metadata.agentTurnCount > 0) {
                const updatedMetadata: ThreadMetadata = { ...metadata, agentTurnCount: 0 };
                await ops.crud.threads?.update?.({ id: thread.id }, { metadata: updatedMetadata });
                (thread as { metadata: unknown }).metadata = updatedMetadata;
            }
        }
    }
    
    return { shouldForceUserTarget: false };
}

/**
 * Discover the target(s) for a message using the new multi-agent routing logic.
 * 
 * Priority:
 * 1. Tool results → route back to requesting agent
 * 2. @mentions → route to mentioned agents (preserves order, builds queue)
 * 3. Persisted target → use sender's last target from thread metadata
 * 4. Default → first non-self participant
 */
async function discoverTargetForMessage(
    messageContext: MessageContextDetails,
    thread: Thread,
    availableAgents: Agent[],
    ops: Operations
): Promise<TargetResolution | null> {
    const metadata = (thread.metadata ?? {}) as ThreadMetadata;
    const participantTargets = metadata.participantTargets ?? {};
    
    // 1. Tool results → route back to requesting agent (unchanged behavior)
    if (messageContext.senderType === "tool" && messageContext.senderId) {
        const agent = availableAgents.find(a => 
            a.id === messageContext.senderId || a.name === messageContext.senderName
        );
        return agent ? { targetId: (agent.id ?? agent.name) as string, targetQueue: [] } : null;
    }

    // 2. Parse @mentions from content
    const mentions = parseMentions(messageContext.contentText, thread.participants ?? null, availableAgents);
    
    if (mentions.length > 0) {
        // Update sender's persistent target in thread metadata
        await updateParticipantTarget(ops, thread, messageContext.senderId, mentions[0]);
        
        // Build queue: [first_mention, ...remaining_mentions, original_sender]
        const queue = mentions.slice(1);
        
        // Append original sender to end of queue (for return path)
        // unless sender is already in queue
        if (!queue.includes(messageContext.senderId) && 
            mentions[0] !== messageContext.senderId) {
            queue.push(messageContext.senderId);
        }
        
        return { targetId: mentions[0], targetQueue: queue };
    }

    // 3. Use sender's persisted target from thread metadata
    const persistedTarget = participantTargets[messageContext.senderId];
    if (persistedTarget) {
        // Validate the target still exists as an agent
        const targetAgent = availableAgents.find(a => 
            a.id === persistedTarget || a.name === persistedTarget
        );
        if (targetAgent) {
            return { targetId: persistedTarget, targetQueue: [] };
        }
    }

    // 4. Default: First non-self participant (that is an agent)
    const defaultTarget = thread.participants?.find(p => 
        p !== messageContext.senderName && 
        p !== messageContext.senderId &&
        availableAgents.some(a => a.name === p || a.id === p)
    );
    
    if (defaultTarget) {
        // Persist this as sender's default target
        await updateParticipantTarget(ops, thread, messageContext.senderId, defaultTarget);
        const targetAgent = availableAgents.find(a => a.name === defaultTarget || a.id === defaultTarget);
        return { targetId: (targetAgent?.id ?? defaultTarget) as string, targetQueue: [] };
    }

    // 5. No valid target found
    return null;
}

function toExecutableTool(tool: unknown): ExecutableTool | null {
    if (!tool || typeof tool !== "object") return null;
    const maybe = tool as Partial<ExecutableTool>;

    const executeSource = maybe.execute;
    if (typeof executeSource !== "function") return null;

    const executor: ToolExecutor = (args, context) =>
        executeSource.call(tool, args, context) as Promise<unknown> | unknown;

    const key = maybe.key;
    const name = maybe.name;
    const description = maybe.description;
    if (typeof key !== "string" || typeof name !== "string" || typeof description !== "string") {
        return null;
    }

    const toDate = (value: unknown): Date => {
        if (value instanceof Date) return value;
        if (typeof value === "string" || typeof value === "number") {
            const parsed = new Date(value);
            if (!Number.isNaN(parsed.getTime())) return parsed;
        }
        return new Date();
    };

    return {
        id: typeof maybe.id === "string"
            ? maybe.id
            : crypto.randomUUID(),
        key,
        name,
        description,
        externalId: typeof maybe.externalId === "string" ? maybe.externalId : null,
        metadata: (maybe.metadata && typeof maybe.metadata === "object")
            ? maybe.metadata
            : null,
        createdAt: toDate(maybe.createdAt),
        updatedAt: toDate(maybe.updatedAt),
        inputSchema: maybe.inputSchema ?? null,
        outputSchema: maybe.outputSchema ?? null,
        execute: executor,
    };
}

type NormalizedToolCall = {
    id: string | null;
    name: string;
    args: Record<string, unknown>;
    // Batch tracking for multiple tool calls from a single LLM response
    batchId?: string | null;
    batchSize?: number | null;
    batchIndex?: number | null;
};

interface MessageContextDetails {
    senderId: string;
    senderType: "agent" | "user" | "tool" | "system";
    senderName: string;
    contentText: string;
    toolCalls: NormalizedToolCall[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);

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

function normalizeToolCalls(toolCalls: MessagePayload["toolCalls"]): NormalizedToolCall[] {
    if (!Array.isArray(toolCalls)) return [];
    return toolCalls
        .filter((call): call is NonNullable<typeof call> => Boolean(call && call.name))
        .map((call) => {
            const callWithBatch = call as typeof call & {
                batchId?: string | null;
                batchSize?: number | null;
                batchIndex?: number | null;
            };
            return {
                id: call.id ?? null,
                name: call.name,
                args: (call.args && typeof call.args === "object")
                    ? call.args as Record<string, unknown>
                    : {},
                batchId: callWithBatch.batchId ?? null,
                batchSize: callWithBatch.batchSize ?? null,
                batchIndex: callWithBatch.batchIndex ?? null,
            };
        });
}

function getMessageContext(payload: MessagePayload): MessageContextDetails {
    const senderType = (payload.sender?.type ?? "user") as MessageContextDetails["senderType"];
    const senderId = payload.sender?.id ?? payload.sender?.externalId ?? payload.sender?.name ?? "user";
    const senderName = payload.sender?.name ?? senderId;
    return {
        senderId: senderId,
        senderType,
        senderName,
        contentText: extractTextContent(payload.content),
        toolCalls: normalizeToolCalls(payload.toolCalls),
    };
}

export const messageProcessor: EventProcessor<NewMessageEventPayload, ProcessorDeps> = {
    shouldProcess: () => true,
    process: async (event: Event, deps: ProcessorDeps) => {
        const { db, thread, context } = deps;
        const ops = db.ops;

        const payload = event.payload as NewMessageEventPayload;

        const threadId = typeof event.threadId === "string"
            ? event.threadId
            : (() => { throw new Error("Invalid thread id for message event"); })();

        const messageContext = getMessageContext(payload);

        const baseMetadata = (isRecord(payload.metadata) ? payload.metadata : {}) as Record<string, unknown>;

        const { messageMetadata, toolCallMetadata, contentOverride } = await processAssetsForNewMessage({
            payload,
            baseMetadata,
            senderType: messageContext.senderType,
            context,
            event,
            threadId,
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
            const firstToolCall = messageContext.toolCalls.find((call) => typeof call.id === "string" && call.id.length > 0);
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

        const incomingMsg = {
            id: crypto.randomUUID(),
            threadId,
            senderId: messageContext.senderId,
            senderType: messageContext.senderType,
            content: persistedContent,
            toolCallId: toolCallId,
            toolCalls: payload.toolCalls ?? null,
            metadata: messageMetadata,
        };

        // Persist incoming message before processing
        // Pass namespace for SENT_BY edge creation (user → message)
        const createdMessage = await ops.createMessage(incomingMsg, context.namespace);

        // Emit ENTITY_EXTRACT event for agents with entity extraction enabled
        const entityExtractEvents: Array<{ threadId: string; type: string; payload: unknown; parentEventId?: string; traceId?: string; priority?: number }> = [];
        const agentsForExtraction = context.agents || [];

        for (const agent of agentsForExtraction) {
            const entityConfig = agent.ragOptions?.entityExtraction;
            if (entityConfig?.enabled && persistedContent.trim()) {
                try {
                    const agentIdStr = typeof agent.id === "string" ? agent.id : agent.name;
                    const entityNamespace = resolveNamespace(
                        entityConfig.namespace ?? "agent",
                        { threadId, agentId: agentIdStr },
                        context.namespacePrefix
                    );

                    // Get the message node ID (from the dual-write)
                    // The message node uses the same namespace as the thread
                    const messageNodes = await ops.getNodesByNamespace(threadId, "message");
                    const messageNode = messageNodes.find(n => {
                        const data = n.data as Record<string, unknown> | null;
                        return data?.messageId === createdMessage.id;
                    });

                    if (messageNode) {
                        const extractPayload: EntityExtractPayload = {
                            sourceNodeId: messageNode.id as string,
                            content: persistedContent,
                            namespace: entityNamespace,
                            sourceType: "message",
                            sourceContext: {
                                threadId,
                                agentId: agentIdStr,
                            },
                        };

                        entityExtractEvents.push({
                            threadId,
                            type: "ENTITY_EXTRACT",
                            payload: extractPayload,
                            parentEventId: typeof event.id === "string" ? event.id : undefined,
                            traceId: typeof event.traceId === "string" ? event.traceId : undefined,
                            priority: 0, // Low priority - runs async after main processing
                        });
                    }
                } catch (err) {
                    console.warn(`[NEW_MESSAGE] Failed to queue entity extraction for agent "${agent.name}":`, err);
                }
            }
        }

        // Allow custom processors to emit follow-up NEW_MESSAGE events that should not trigger default routing/LLM
        const skipRouting = !!(messageMetadata && typeof messageMetadata === "object" && (messageMetadata as { skipRouting?: unknown }).skipRouting === true);
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
        
        if (isToolResult && batchInfo.batchId && batchInfo.batchSize && batchInfo.batchSize > 1) {
            // This is a batched tool result - we need to aggregate
            const toolCallMeta = Array.isArray(payload.metadata?.toolCalls)
                ? (payload.metadata.toolCalls as Array<{
                    name?: string;
                    args?: string;
                    output?: unknown;
                    id?: string;
                    status?: string;
                }>)[0]
                : null;
            
            if (toolCallMeta) {
                const storedResult: StoredToolResult = {
                    callId: toolCallMeta.id ?? `unknown_${Date.now()}`,
                    name: toolCallMeta.name ?? "unknown",
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
                    messageContext.senderName,
                    messageContext.senderId,
                    storedResult
                );
                
                if (!isComplete) {
                    // Not all results are in yet - skip routing, don't trigger LLM
                    // The message is already persisted, so it will be in history
                    console.log(`[NEW_MESSAGE] Batch ${batchInfo.batchId}: ${batch.results.length}/${batch.batchSize} results received, waiting for more...`);
                    return { producedEvents: entityExtractEvents as unknown as NewEvent[] };
                }
                
                // All results are in! Clear the batch and proceed with aggregated context
                console.log(`[NEW_MESSAGE] Batch ${batchInfo.batchId}: All ${batch.batchSize} results received, proceeding with LLM call`);
                await clearCompletedBatch(ops, thread, batchInfo.batchId);
                
                // The aggregated results are now in the message history (each was persisted)
                // We can proceed normally - the LLM will see all tool results in history
            }
        }

        // Resolve targets using new multi-agent routing
        const availableAgents = context.agents || [];
        
        // Check if event metadata already has target routing (from llm_call response)
        const eventMetadata = event.metadata as Record<string, unknown> | null;
        const metadataTargetId = eventMetadata?.targetId as string | null;
        const metadataTargetQueue = eventMetadata?.targetQueue as string[] | null;
        
        let targetResolution: TargetResolution | null;
        
        if (metadataTargetId) {
            // Use target from event metadata (set by llm_call processor)
            targetResolution = { 
                targetId: metadataTargetId, 
                targetQueue: metadataTargetQueue ?? [] 
            };
        } else {
            // Discover target from message content (@mentions, persisted target, default)
            targetResolution = await discoverTargetForMessage(messageContext, thread, availableAgents, ops);
        }

        const producedEvents: NewEvent[] = [];

        // If no target resolved, skip routing (no agents to respond)
        if (!targetResolution) {
            return { producedEvents: entityExtractEvents as unknown as NewEvent[] };
        }

        // Check for loop prevention (agent-to-agent turn limit)
        const maxAgentTurns = context.multiAgent?.maxAgentTurns ?? 5;
        const loopCheck = await checkAndUpdateAgentTurns(
            ops, 
            thread, 
            messageContext.senderType,
            targetResolution.targetId,
            availableAgents,
            maxAgentTurns
        );
        
        if (loopCheck.shouldForceUserTarget) {
            // Force target to user - don't trigger any more LLM calls
            if (loopCheck.userToTarget) {
                // Update the target to be the user instead
                targetResolution = { 
                    targetId: loopCheck.userToTarget, 
                    targetQueue: [] 
                };
            }
            // No LLM call for user targets
            return { producedEvents: entityExtractEvents as unknown as NewEvent[] };
        }

        // Assign descending priorities per target to enforce strict serial-per-target
        const basePriority = 1000;
        // If this event already has a priority (continuation of a chain), keep it
        const chainPriority = typeof event.priority === 'number' ? (event.priority as number) : basePriority;

        const normalizedToolCalls = messageContext.toolCalls;

        // ====================================================================
        // Tool Call Processing (BEFORE target resolution)
        // ====================================================================
        // If this message (from an agent) includes tool calls, we need to emit
        // TOOL_CALL events. The tool calls belong to the SENDER (the agent that
        // made the request), not the target.
        // ====================================================================
        if (normalizedToolCalls.length > 0 && messageContext.senderType === "agent") {
            // Find the sending agent
            const sendingAgent = availableAgents.find(a => 
                a.id === messageContext.senderId || a.name === messageContext.senderName
            );
            
            if (sendingAgent) {
                normalizedToolCalls.forEach((call, i: number) => {
                    const callName = call.name || sendingAgent.name || "unknown_tool";
                    const callId = call.id || `${callName}_${i}`;
                    const senderIdForTool = (sendingAgent.id ?? sendingAgent.name) as string;
                    const argumentsString = JSON.stringify(call.args ?? {});
                    const toolCallEventPayload = {
                        agentName: sendingAgent.name,
                        senderId: senderIdForTool,
                        senderType: "agent",
                        call: {
                            id: callId,
                            function: {
                                name: callName,
                                arguments: argumentsString,
                            }
                        },
                        // Pass batch info for tool result aggregation
                        batchId: call.batchId ?? null,
                        batchSize: call.batchSize ?? null,
                        batchIndex: call.batchIndex ?? null,
                    } as ToolCallEventPayload;
                    producedEvents.push({
                        threadId,
                        type: "TOOL_CALL",
                        payload: toolCallEventPayload,
                        parentEventId: typeof event.id === "string" ? event.id : undefined,
                        traceId: typeof event.traceId === "string" ? event.traceId : undefined,
                        priority: chainPriority
                    });
                });
                
                // Tool calls processed - return without triggering LLM call
                // The tool results will come back as NEW_MESSAGE events and route back to this agent
                return { producedEvents: [...producedEvents, ...(entityExtractEvents as unknown as NewEvent[])] };
            }
        }

        // Get the target agent
        const targetAgent = availableAgents.find(a => 
            a.id === targetResolution.targetId || a.name === targetResolution.targetId
        );
        
        if (!targetAgent) {
            // Target is not an agent (might be a user) - no LLM call needed
            return { producedEvents: entityExtractEvents as unknown as NewEvent[] };
        }

        // Process the target agent - create LLM_CALL
        const targets = [targetAgent];
        
        for (let idx = 0; idx < targets.length; idx++) {
            const agent = targets[idx];
            if (!agent) continue;

            /** If the message is not a tool call, we need to add the message to the LLM context */

            // Build processing context (include agent ID for fetching agent's participant node)
            const agentId = (agent.id ?? agent.name) as string;
            const ctx = await buildProcessingContext(ops, threadId, context, agent.name, agentId);

            // Build LLM request (pass agent node for persistent memory injection)
            const llmContext: LLMContextData = contextGenerator(
                agent, 
                thread, 
                ctx.activeTask, 
                ctx.availableAgents, 
                availableAgents, 
                ctx.userMetadata,
                ctx.agentNode  // NEW: Agent's participant node for memory
            );
            
            // Generate history with target context for multi-agent awareness
            const includeTargetContext = context.multiAgent?.includeTargetContext ?? true;
            const llmHistory: ChatMessage[] = historyGenerator(ctx.chatHistory, agent, { includeTargetContext });

            // Select tools available to this agent
            const allowedToolKeys: string[] = Array.isArray(agent.allowedTools) && agent.allowedTools.length > 0
                ? agent.allowedTools
                : ctx.allTools.map((t) => t.key);
            const agentTools: ExecutableTool[] = allowedToolKeys
                .map((key) => ctx.allTools.find((t) => t.key === key))
                .filter((t): t is ExecutableTool => Boolean(t));
            const llmTools: ToolDefinition[] = formatToolsForAI(agentTools);

            // Build system prompt
            let systemPrompt = typeof llmContext.systemPrompt === "string"
                ? llmContext.systemPrompt
                : JSON.stringify(llmContext.systemPrompt ?? {});

            // Auto-inject RAG context if agent has ragOptions.mode === "auto"
            if (agent.ragOptions?.mode === "auto" && context.embeddingConfig) {
                try {
                    // Get user ID from thread metadata if available
                    const threadMeta = thread.metadata as Record<string, unknown> | null;
                    const userId = threadMeta?.userExternalId as string | undefined;

                    const ragResult = await generateRagContext({
                        agent,
                        query: messageContext.contentText,
                        ops,
                        embeddingConfig: context.embeddingConfig,
                        threadId,
                        userId,
                    });

                    if (ragResult.context) {
                        systemPrompt = `${systemPrompt}\n\n${ragResult.context}`;
                    }
                } catch (error) {
                    console.warn(`[new_message] Failed to generate RAG context for agent "${agent.name}":`, error);
                }
            }

            const llmMessages: ChatMessage[] = [
                { role: "system", content: systemPrompt },
                ...llmHistory
            ];

            const resolverPayload = {
                agentName: agent.name,
                agentId: agent.id,
                messages: llmMessages,
                tools: llmTools,
            } as AgentLlmOptionsResolverArgs["payload"];

            let providerConfig: ProviderConfig = {};
            const agentLlmOptions = agent.llmOptions;
            if (agentLlmOptions) {
                if (typeof agentLlmOptions === "function") {
                    try {
                        const dynamicConfig = await agentLlmOptions({
                            payload: resolverPayload,
                            sourceEvent: event,
                            deps,
                        });
                        if (dynamicConfig && typeof dynamicConfig === "object") {
                            providerConfig = dynamicConfig;
                        }
                    } catch (error) {
                        console.warn(`[new_message] Failed to resolve dynamic llmOptions for agent "${agent.name ?? agent.id}":`, error);
                    }
                } else {
                    providerConfig = agentLlmOptions;
                }
            }

            resolverPayload.config = providerConfig;

            const llmPayload = {
                ...resolverPayload,
                config: providerConfig as unknown as Record<string, unknown>,
            } as LlmCallEventPayload;

            // Include target queue in LLM_CALL metadata for agent response routing
            // For tool responses: use the agent's persisted target (who they were talking to)
            // to avoid the agent targeting itself after responding
            let originalSenderId = messageContext.senderId;
            if (messageContext.senderType === "tool") {
                // Tool response - find who the agent was originally talking to
                const threadMeta = (thread.metadata ?? {}) as ThreadMetadata;
                const agentTarget = threadMeta.participantTargets?.[messageContext.senderId];
                if (agentTarget) {
                    originalSenderId = agentTarget;
                } else {
                    // Fallback: find a user in the thread participants
                    const userInThread = thread.participants?.find(p => 
                        !availableAgents.some(a => a.name === p || a.id === p)
                    );
                    if (userInThread) {
                        originalSenderId = userInThread;
                    }
                }
            }
            
            const llmEventMetadata = {
                targetId: targetResolution.targetId,
                targetQueue: targetResolution.targetQueue,
                sourceMessageSenderId: originalSenderId,
            };

            producedEvents.push({
                threadId,
                type: "LLM_CALL",
                payload: llmPayload,
                parentEventId: typeof event.id === "string" ? event.id : undefined,
                traceId: typeof event.traceId === "string" ? event.traceId : undefined,
                priority: chainPriority,
                metadata: llmEventMetadata,
            });

        }

        // Add entity extraction events (low priority, runs after main processing)
        return { producedEvents: [...producedEvents, ...(entityExtractEvents as unknown as NewEvent[])] };
    }
};

const formatToolsForAI = (tools: ExecutableTool[]): ToolDefinition[] => {
    return tools.map((tool) => ({
        type: "function" as const,
        function: {
            name: tool.key,
            description: tool.description,
            parameters: tool.inputSchema && typeof tool.inputSchema === "object"
                ? {
                    type: "object" as const,
                    properties: (tool.inputSchema as { properties?: Record<string, unknown> }).properties ?? {},
                    required: Array.isArray((tool.inputSchema as { required?: string[] }).required)
                        ? (tool.inputSchema as { required?: string[] }).required
                        : undefined,
                }
                : {
                    type: "object" as const,
                    properties: {},
                },
        },
    }));
};


async function buildProcessingContext(ops: Operations, threadId: string, context: ChatContext, senderIdForHistory: string, targetAgentId?: string) {
    const thread: Thread | undefined = await ops.getThreadById(threadId);
    if (!thread) throw new Error(`Thread not found: ${threadId}`);

    const chatHistory = await ops.getMessageHistory(threadId, senderIdForHistory);

    const activeTask = context.activeTaskId ? (await ops.getTaskById(context.activeTaskId)) || null : null;

    const availableAgents = context.agents || [];
    if (availableAgents.length === 0) {
        throw new Error("No agents provided in context for this session");
    }

    const nativeToolsArray = Object.values(getNativeTools())
        .map(toExecutableTool)
        .filter((tool): tool is ExecutableTool => Boolean(tool));
    const userTools =
        (context.tools || [])
            .map(toExecutableTool)
            .filter((tool): tool is ExecutableTool => Boolean(tool));
    const apiTools = context.apis ? generateAllApiTools(context.apis) : [];
    const mcpTools = context.mcpServers ? await generateAllMcpTools(context.mcpServers) : [];
    const allTools: ExecutableTool[] = [...nativeToolsArray, ...userTools, ...apiTools, ...mcpTools];

    let userMetadata = context.userMetadata;
    const threadMetadata = thread.metadata && typeof thread.metadata === "object"
        ? (thread.metadata as Record<string, unknown>)
        : undefined;

    if (!userMetadata && threadMetadata) {
        const stored = threadMetadata.userContext;
        if (stored && typeof stored === "object") {
            userMetadata = stored as Record<string, unknown>;
        }
    }

    if (!userMetadata && threadMetadata?.userExternalId) {
        const externalId = threadMetadata.userExternalId as string;
        try {
            // Use graph-based user lookup with namespace support
            const userNode = await ops.getUserNode(externalId, context.namespace);
            const userData = userNode?.data as Record<string, unknown> | undefined;
            if (userData?.metadata && typeof userData.metadata === "object") {
                userMetadata = userData.metadata as Record<string, unknown>;
            }
        } catch (error) {
            console.warn(`buildProcessingContext: failed to load user metadata for ${externalId}`, error);
        }
    }

    if (userMetadata && !context.userMetadata) {
        context.userMetadata = userMetadata;
    }

    // Fetch agent's participant node for persistent memory (if target agent specified)
    let agentNode: KnowledgeNode | undefined = undefined;
    if (targetAgentId) {
        try {
            agentNode = await ops.getParticipantNode(targetAgentId, context.namespace);
        } catch {
            // Ignore errors - agent node might not exist
        }
    }

    return {
        thread,
        chatHistory,
        activeTask,
        availableAgents,
        allTools,
        userMetadata,
        agentNode,
    } as {
        thread: Thread;
        chatHistory: NewMessage[];
        activeTask: unknown;
        availableAgents: Agent[];
        allTools: ExecutableTool[];
        userMetadata?: Record<string, unknown>;
        agentNode?: KnowledgeNode;
    };
}

/** @deprecated Use discoverTargetForMessage instead - kept for backward compatibility */
function _filterAllowedAgents(contextDetails: MessageContextDetails, targetAgents: Agent[], availableAgents: Agent[]): Agent[] {
    if (contextDetails.senderType !== "agent") return targetAgents;
    const senderAgent = availableAgents.find(a =>
        a.name === contextDetails.senderName ||
        a.id === contextDetails.senderId
    );
    if (!senderAgent) return targetAgents;
    const allowed = Array.isArray(senderAgent.allowedAgents) ? senderAgent.allowedAgents : [];
    if (allowed.length === 0) return targetAgents;
    return targetAgents.filter((agent) => allowed.includes(agent.name));
}

/** @deprecated Use discoverTargetForMessage instead - kept for backward compatibility */
function _discoverTargetAgentsForMessage(contextDetails: MessageContextDetails, thread: Thread, availableAgents: Agent[]): Agent[] {
    // Tool messages route back to the requesting agent by senderId
    if (
        (contextDetails.senderType === "tool" || contextDetails.toolCalls.length > 0) &&
        contextDetails.senderId
    ) {
        const agent = availableAgents.find(a => a.id === contextDetails.senderId || a.name === contextDetails.senderName);
        return agent ? [agent] : [];
    }

    // Mentions (preserve mention order)
    const mentions = contextDetails.contentText.match(/(?<!\w)@([\w](?:[\w.-]*[\w])?)/g);
    if (mentions && mentions.length > 0) {
        const names = mentions.map((m: string) => m.substring(1));
        // Build in the order mentioned, unique by name
        const seen = new Set<string>();
        const orderedMentioned: Agent[] = [];
        for (const name of names) {
            if (seen.has(name)) continue;
            const agent = availableAgents.find(a => a.name === name);
            if (agent) {
                orderedMentioned.push(agent);
                seen.add(name);
            }
        }
        const allowedMentionedAgents = _filterAllowedAgents(contextDetails, orderedMentioned, availableAgents);
        if (allowedMentionedAgents.length > 0) {
            return allowedMentionedAgents;
        }
        // Otherwise ignore unrecognized/disallowed mentions and continue to fallback logic below
    }

    // Default two-party fallback
    if (thread.participants && thread.participants.length === 2) {

        const otherParticipant: string | undefined = thread.participants.find((p: string) =>
            p !== contextDetails.senderName &&
            p !== contextDetails.senderId

        );
        if (otherParticipant) {
            const otherAgent = availableAgents.find(a => a.name === otherParticipant);
            if (otherAgent) return [otherAgent];
        }
    }

    // Otherwise: no implicit target
    return [];
}
