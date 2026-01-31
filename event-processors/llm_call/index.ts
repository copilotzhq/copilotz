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

        const normalizedToolCalls = Array.isArray(toolCalls)
            ? toolCalls.map((call) => {
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
                };
            })
            : undefined;

        const newMessagePayload: MessagePayload = {
            content: answer || "",
            sender: {
                id: payload.agentId,
                type: "agent",
                name: payload.agentName,
            },
            toolCalls: normalizedToolCalls,
        };

        // Enqueue a NEW_MESSAGE event
        producedEvents.push({
            threadId,
            type: "NEW_MESSAGE",
            payload: newMessagePayload,
            parentEventId: typeof event.id === "string" ? event.id : undefined,
            traceId: typeof event.traceId === "string" ? event.traceId : undefined,
            priority: typeof event.priority === "number" ? event.priority : undefined,
        });

        return { producedEvents };
    }
};
