import { chat } from "@/connectors/llm/index.ts";
import type { ChatMessage, ChatRequest, ChatResponse, ProviderConfig } from "@/connectors/llm/types.ts";
import type { Event, NewEvent, EventProcessor, MessagePayload, ProcessorDeps, LlmCallEventPayload } from "@/interfaces/index.ts";
import type { ToolCallInput } from "@/event-processors/tool_call/index.ts";
import { resolveAssetRefsInMessages } from "@/utils/assets.ts";

export type {
    ChatMessage,
}

export interface ContentStreamData {
    threadId: string;
    agentName: string;
    token: string;
    isComplete: boolean;
}

export type LLMCallPayload = LlmCallEventPayload;
export type LLMResultPayload = LlmCallEventPayload;

// Utilities reused from legacy engine (minimized/duplicated to avoid refactors)
const escapeRegex = (string: string): string => string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Parse @mentions from agent response content.
 * Returns array of mentioned names.
 */
function parseMentionsFromResponse(content: string): string[] {
    const mentionPattern = /(?<!\w)@([\w](?:[\w.-]*[\w])?)/g;
    const matches = content.matchAll(mentionPattern);
    
    const mentioned: string[] = [];
    const seen = new Set<string>();
    
    for (const match of matches) {
        const name = match[1];
        if (!seen.has(name)) {
            mentioned.push(name);
            seen.add(name);
        }
    }
    
    return mentioned;
}

/**
 * Resolve agent response target based on:
 * 1. @mentions in the response (explicit addressing)
 * 2. Source message's targetQueue (for multi-mention chains)
 * 3. Source message sender (default: respond back)
 */
function resolveAgentResponseTarget(
    response: string,
    _agentId: string,
    sourceEvent: Event,
): { targetId: string | null; targetQueue: string[] } {
    // Get source event metadata for target queue
    const eventMetadata = sourceEvent.metadata as Record<string, unknown> | null;
    const sourceTargetQueue = (eventMetadata?.targetQueue as string[] | null) ?? [];
    const sourceSenderId = (eventMetadata?.sourceMessageSenderId as string | null) ?? null;
    
    // 1. Parse @mentions from agent's response
    const mentions = parseMentionsFromResponse(response);
    
    if (mentions.length > 0) {
        // Agent explicitly mentioned someone(s)
        const queue = mentions.slice(1);
        return { targetId: mentions[0], targetQueue: queue };
    }
    
    // 2. Check if there's a remaining queue from source message
    if (sourceTargetQueue.length > 0) {
        const nextTarget = sourceTargetQueue[0];
        const remainingQueue = sourceTargetQueue.slice(1);
        return { targetId: nextTarget, targetQueue: remainingQueue };
    }
    
    // 3. Default: respond to whoever sent the message (via source metadata)
    return { 
        targetId: sourceSenderId,
        targetQueue: [] 
    };
}


export const llmCallProcessor: EventProcessor<LLMCallPayload, ProcessorDeps> = {
    shouldProcess: () => true,
    process: async (event: Event, deps: ProcessorDeps) => {

        const payload = event.payload as LlmCallEventPayload;

        const threadId = typeof event.threadId === "string"
            ? event.threadId
            : (() => { throw new Error("Invalid thread id for LLM call event"); })();

        const producedEvents: NewEvent[] = [];

        // Get context from dependencies
        const context = deps.context;

        // Streaming callback: ai/llm filters out <function_calls> already.
        const streamCallback = (context.stream && (context.callbacks?.onContentStream))
            ? (token: string) => {

                if (context.callbacks?.onContentStream) {

                    const callbackData: ContentStreamData = {
                        threadId,
                        agentName: payload.agentName,
                        token,
                        isComplete: false,
                    }
                    context.callbacks.onContentStream(callbackData);
                }
            }
            : undefined;

        const envVars: Record<string, string> = (() => {
            try {
                const anyGlobal = globalThis as unknown as {
                    Deno?: { env?: { toObject?: () => Record<string, string> } };
                    process?: { env?: Record<string, string | undefined> };
                };
                const fromDeno = anyGlobal?.Deno?.env?.toObject?.();
                if (fromDeno && typeof fromDeno === "object") return fromDeno;
                const fromNode = anyGlobal?.process?.env;
                if (fromNode && typeof fromNode === "object") {
                    const out: Record<string, string> = {};
                    for (const [k, v] of Object.entries(fromNode)) {
                        if (typeof v === "string") out[k] = v;
                    }
                    return out;
                }
            } catch {
                // ignore
            }
            return {};
        })();

        // If allowed, resolve asset:// refs in message parts to provider-acceptable data URLs.
        // Otherwise, strip multimodal parts and send text-only to let the LLM call a fetch tool.
        const shouldResolve = context.assetConfig?.resolveInLLM !== false;
        const resolvedMessages = (await (async () => {
            try {
                if (shouldResolve) {
                    // Warn if resolution is expected but store is missing
                    if (!context.assetStore) {
                        try {
                            const anyGlobal = globalThis as unknown as {
                                Deno?: { env?: { get?: (key: string) => string | undefined } };
                                console?: { warn?: (...args: unknown[]) => void };
                            };
                            const debugFlag = anyGlobal?.Deno?.env?.get?.("COPILOTZ_DEBUG");
                            if (debugFlag === "1" && anyGlobal.console?.warn) {
                                anyGlobal.console.warn("[llm_call] resolveInLLM is true but assetStore is undefined - asset refs will not be resolved");
                            }
                        } catch {
                            // ignore logging failures
                        }
                    }
                    const res = await resolveAssetRefsInMessages(payload.messages as ChatMessage[], context.assetStore);
                    return res.messages;
                }
                const msgs = (payload.messages as ChatMessage[]).map((m) => {
                    if (Array.isArray(m.content)) {
                        const textOnly = m.content
                            .map((p) => (p && typeof p === "object" && (p as { type?: string }).type === "text") ? (p as { text?: string }).text ?? "" : "")
                            .join("");
                        return { ...m, content: textOnly };
                    }
                    return m;
                });
                return msgs;
            } catch (err) {
                // In debug mode, surface the underlying error so asset resolution issues are visible.
                try {
                    const anyGlobal = globalThis as unknown as {
                        Deno?: { env?: { get?: (key: string) => string | undefined }; stderr?: { writeSync?: (data: Uint8Array) => unknown } };
                        console?: { warn?: (...args: unknown[]) => void };
                    };
                    const debugFlag = anyGlobal?.Deno?.env?.get?.("COPILOTZ_DEBUG");
                    if (debugFlag === "1" && anyGlobal.console?.warn) {
                        anyGlobal.console.warn("[llm_call] resolveAssetRefsInMessages failed:", err);
                    }
                } catch {
                    // ignore logging failures
                }
                return payload.messages as ChatMessage[];
            }
        })());

        const agentForCall = context.agents?.find((a) => a.id === payload.agentId);
        let finalConfig: ProviderConfig | undefined = payload.config;

        if (!finalConfig && agentForCall) {
            const agentLlmOptions = agentForCall.llmOptions;
            if (agentLlmOptions && typeof agentLlmOptions !== "function") {
                finalConfig = agentLlmOptions;
            }
        }

        const configForCall: ProviderConfig = finalConfig ?? {};


        if (Deno.env.get("COPILOTZ_DEBUG") === "1") {
            console.log("shouldResolve", shouldResolve);
            console.log("hasAssetStore", !!context.assetStore);
            console.log("configForCall", configForCall);
            console.log("resolvedMessages", resolvedMessages);
            console.log("payload.messages", payload.messages);
            console.log("payload.tools", payload.tools);
        }

        const response = await chat(
            {
                messages: resolvedMessages,
                tools: payload.tools,
            } as ChatRequest,
            configForCall,
            envVars,
            streamCallback
        );


        const llmResponse = response as unknown as ChatResponse;

        // finalize stream
        if (streamCallback) {
            if (context.callbacks?.onContentStream) {
                context.callbacks.onContentStream({
                    threadId,
                    agentName: payload.agentName,
                    token: "",
                    isComplete: true,
                } as ContentStreamData);
            }
        }

        // Clean response
        let answer: string | undefined = ("answer" in llmResponse) ? (llmResponse as unknown as { answer?: string }).answer : undefined;
        const toolCalls: ToolCallInput[] | undefined = ("toolCalls" in llmResponse) ? (llmResponse as unknown as { toolCalls?: ToolCallInput[] }).toolCalls : undefined;

        if (!answer && !toolCalls) {
            return { producedEvents: [] };
        }

        if (answer) {
            const selfPrefixPattern = new RegExp(`^(\\[${escapeRegex(payload.agentName)}\\]:\\s*|@${escapeRegex(payload.agentName)}\\b(:\\s*|\\s+))`, 'i');
            answer = answer.replace(selfPrefixPattern, '');
        }

        // Generate batch metadata for multiple tool calls
        const batchId = Array.isArray(toolCalls) && toolCalls.length > 1
            ? crypto.randomUUID()
            : null;
        const batchSize = Array.isArray(toolCalls) && toolCalls.length > 1
            ? toolCalls.length
            : null;

        const normalizedToolCalls = Array.isArray(toolCalls)
            ? toolCalls.map((call, index) => {
                let parsedArgs: Record<string, unknown> = {};
                try {
                    parsedArgs = call?.function?.arguments
                        ? JSON.parse(call.function.arguments)
                        : {};
                } catch (_err) {
                    parsedArgs = {};
                }
                return {
                    id: call?.id ?? null,
                    name: call?.function?.name ?? "",
                    args: parsedArgs,
                    // Include batch info for tool call aggregation
                    batchId,
                    batchSize,
                    batchIndex: batchId ? index : null,
                };
            })
            : undefined;

        // Resolve target for agent's response (based on @mentions or queue)
        const responseTarget = resolveAgentResponseTarget(
            answer || "",
            payload.agentId,
            event
        );

        const newMessagePayload: MessagePayload = {
            content: answer || "",
            sender: {
                id: payload.agentId,
                type: "agent",
                name: payload.agentName,
            },
            toolCalls: normalizedToolCalls,
        };

        // Include target info in message metadata for routing
        const messageMetadata: Record<string, unknown> = {
            targetId: responseTarget.targetId,
            targetQueue: responseTarget.targetQueue,
        };

        // Enqueue a NEW_MESSAGE event with target routing info
        producedEvents.push({
            threadId,
            type: "NEW_MESSAGE",
            payload: newMessagePayload,
            parentEventId: typeof event.id === "string" ? event.id : undefined,
            traceId: typeof event.traceId === "string" ? event.traceId : undefined,
            priority: typeof event.priority === "number" ? event.priority : undefined,
            metadata: messageMetadata,
        });

        return { producedEvents };
    }
};
