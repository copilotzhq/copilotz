
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
} from "@/interfaces/index.ts";
import { resolveNamespace } from "@/interfaces/index.ts";
import type { EntityExtractPayload } from "@/database/schemas/index.ts";

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
        .map((call) => ({
            id: call.id ?? null,
            name: call.name,
            args: (call.args && typeof call.args === "object")
                ? call.args as Record<string, unknown>
                : {},
        }));
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
        const createdMessage = await ops.createMessage(incomingMsg);

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

        // Resolve targets
        const availableAgents = context.agents || [];
        const targets = discoverTargetAgentsForMessage(messageContext, thread, availableAgents);

        const producedEvents: NewEvent[] = [];

        // Assign descending priorities per target to enforce strict serial-per-target
        const basePriority = 1000;
        // If this event already has a priority (continuation of a chain), keep it

        const normalizedToolCalls = messageContext.toolCalls;

        for (let idx = 0; idx < targets.length; idx++) {

            const chainPriority = typeof event.priority === 'number' ? (event.priority as number) : (basePriority - idx);

            const agent = targets[idx];
            if (!agent) continue;

            // Emit tool calls as events
            if (normalizedToolCalls.length > 0) {
                normalizedToolCalls.forEach((call, i: number) => {
                    const callName = call.name || agent.name || "unknown_tool";
                    const callId = call.id || `${callName}_${i}`;
                    const senderIdForTool = agent.id ?? agent.name ?? "agent";
                    const argumentsString = JSON.stringify(call.args ?? {});
                    const toolCallEventPayload = {
                        agentName: agent.name,
                        senderId: senderIdForTool,
                        senderType: "agent",
                        call: {
                            id: callId,
                            function: {
                                name: callName,
                                arguments: argumentsString,
                            }
                        }
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
                continue;
            }

            /** If the message is not a tool call, we need to add the message to the LLM context */

            // Build processing context
            const ctx = await buildProcessingContext(ops, threadId, context, agent.name);

            // Build LLM request
            const llmContext: LLMContextData = contextGenerator(agent, thread, ctx.activeTask, ctx.availableAgents, availableAgents, ctx.userMetadata);
            const llmHistory: ChatMessage[] = historyGenerator(ctx.chatHistory, agent);

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

            producedEvents.push({
                threadId,
                type: "LLM_CALL",
                payload: llmPayload,
                parentEventId: typeof event.id === "string" ? event.id : undefined,
                traceId: typeof event.traceId === "string" ? event.traceId : undefined,
                priority: chainPriority,
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


async function buildProcessingContext(ops: Operations, threadId: string, context: ChatContext, senderIdForHistory: string) {
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
            const user = await ops.getUserByExternalId(externalId);
            if (user?.metadata && typeof user.metadata === "object") {
                userMetadata = user.metadata as Record<string, unknown>;
            }
        } catch (error) {
            console.warn(`buildProcessingContext: failed to load user metadata for ${externalId}`, error);
        }
    }

    if (userMetadata && !context.userMetadata) {
        context.userMetadata = userMetadata;
    }

    return {
        thread,
        chatHistory,
        activeTask,
        availableAgents,
        allTools,
        userMetadata,
    } as {
        thread: Thread;
        chatHistory: NewMessage[];
        activeTask: unknown;
        availableAgents: Agent[];
        allTools: ExecutableTool[];
        userMetadata?: Record<string, unknown>;
    };
}

function filterAllowedAgents(contextDetails: MessageContextDetails, targetAgents: Agent[], availableAgents: Agent[]): Agent[] {
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

function discoverTargetAgentsForMessage(contextDetails: MessageContextDetails, thread: Thread, availableAgents: Agent[]): Agent[] {
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
        const allowedMentionedAgents = filterAllowedAgents(contextDetails, orderedMentioned, availableAgents);
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
