/**
 * Event processing system for Copilotz.
 * 
 * This module provides the event queue processing infrastructure,
 * including built-in processors for messages, LLM calls, tool calls,
 * and RAG ingestion, as well as extension points for custom processors.
 * 
 * @module
 */

import { createDatabase, type CopilotzDb } from "@/database/index.ts";

import type {
    Thread,
    Event,
    NewEvent,
    MessagePayload,
    ToolCallEventPayload,
    LlmCallEventPayload,
    TokenEventPayload,
    NewUnknownEvent,
} from "@/interfaces/index.ts";

import { llmCallProcessor } from "./llm_call/index.ts";
import { messageProcessor } from "./new_message/index.ts";
import { toolCallProcessor } from "./tool_call/index.ts";
import { ragIngestProcessor } from "./rag_ingest/index.ts";
import { entityExtractProcessor } from "./entity_extract/index.ts";

type EventType = Event["type"];

import type { LLMCallPayload, LLMResultPayload } from "./llm_call/index.ts";
import type { ToolCallPayload, ToolResultPayload, ToolExecutionContext } from "./tool_call/index.ts";
import type { ChatContext } from "@/interfaces/index.ts";

import type { ExecutableTool, ToolExecutor } from "./tool_call/types.ts";

export type {
    /** Payload for LLM call events. */
    LLMCallPayload,
    /** Payload for LLM call results. */
    LLMResultPayload,
    /** Payload for tool call events. */
    ToolCallPayload,
    /** Payload for tool call results. */
    ToolResultPayload,
    /** Context passed to tool execution. */
    ToolExecutionContext,
    /** Tool with an execute function. */
    ExecutableTool,
    /** Function signature for tool execution. */
    ToolExecutor
};

/**
 * Result from processing an event, containing any new events to enqueue.
 */
export interface ProcessResult {
    /** Array of new events produced by processing. */
    producedEvents: Array<NewEvent | NewUnknownEvent>;
}

/**
 * Dependencies injected into event processors.
 * Provides access to database, current thread, and chat context.
 */
export type ProcessorDeps = {
    /** Database instance for data operations. */
    db: CopilotzDb;
    /** Current conversation thread. */
    thread: Thread;
    /** Chat context with configuration and callbacks. */
    context: ChatContext;
}

type Operations = CopilotzDb["ops"];

type EventProcessors = Record<EventType, EventProcessor<unknown, ProcessorDeps>>;

function castPayload<T>(payload: unknown): T {
    return payload as T;
}

// Processor registry
const tokenProcessor: EventProcessor<unknown, ProcessorDeps> = {
    shouldProcess: () => false,
    process: () => ({ producedEvents: [] }),
};

const processors: Record<string, EventProcessor<unknown, ProcessorDeps>> = {
    LLM_CALL: llmCallProcessor,
    NEW_MESSAGE: messageProcessor,
    TOOL_CALL: toolCallProcessor,
    TOKEN: tokenProcessor,
    RAG_INGEST: ragIngestProcessor,
    ENTITY_EXTRACT: entityExtractProcessor,
};

/**
 * Registers a custom event processor for a specific event type.
 * 
 * Use this to extend Copilotz with custom event handling logic.
 * Registered processors will be used instead of built-in processors
 * for the specified event type.
 * 
 * @param type - The event type to handle (e.g., "NEW_MESSAGE", "TOOL_CALL", "CUSTOM_EVENT")
 * @param processor - The processor implementation
 * 
 * @example
 * ```ts
 * registerEventProcessor("MY_CUSTOM_EVENT", {
 *   shouldProcess: (event) => event.type === "MY_CUSTOM_EVENT",
 *   process: async (event, deps) => {
 *     // Handle the custom event
 *     return { producedEvents: [] };
 *   }
 * });
 * ```
 */
export function registerEventProcessor<TPayload = unknown>(
    type: string,
    processor: EventProcessor<TPayload, ProcessorDeps>,
): void {
    (processors as Record<string, EventProcessor<unknown, ProcessorDeps>>)[type] =
        processor as unknown as EventProcessor<unknown, ProcessorDeps>;
}

// Public API
export async function enqueueEvent(db: CopilotzDb, event: NewEvent | NewUnknownEvent): Promise<void> {
    const ops = db.ops;
    const { threadId } = event;

    if (typeof threadId !== "string") {
        throw new Error("Invalid thread id for event");
    }

    if (event.type === "TOKEN") {
        throw new Error("TOKEN events are ephemeral and must not be enqueued");
    }

    const parentEventId = typeof event.parentEventId === "string"
        ? event.parentEventId
        : undefined;
    const traceId = typeof event.traceId === "string" ? event.traceId : undefined;

    await ops.addToQueue(threadId, {
        eventType: event.type,
        payload: event.payload as Record<string, unknown>,
        parentEventId,
        traceId,
        priority: event.priority ?? undefined,
        metadata: event.metadata,
        ttlMs: event.ttlMs ?? undefined,
        status: event.status,
        namespace: (event as { namespace?: string }).namespace,
    });
}

export async function startThreadEventWorker(
    db: CopilotzDb,
    threadId: string,
    context: ChatContext
): Promise<void> {
    const workerContext: WorkerContext = {
        callbacks: {
            onEvent: context.callbacks?.onEvent,
            onStreamPush: context.callbacks?.onStreamPush,
        },
        customProcessors: context.customProcessors,
    };

    await startEventWorker(
        db,
        threadId,
        workerContext,
        processors,
        async (ops: Operations, event: Event) => {
            const { threadId } = event;
            if (typeof threadId !== "string") {
                throw new Error("Invalid thread id for event");
            }

            const thread = await ops.getThreadById(threadId);
            if (!thread) throw new Error(`Thread not found: ${threadId}`);
            return { ops, db, thread, context } as ProcessorDeps;
        }
    );
}

/**
 * Interface for custom event processors.
 * 
 * Implement this interface to create custom event handlers that can
 * intercept and process events in the Copilotz event queue.
 * 
 * @typeParam TPayload - The expected payload type for events this processor handles
 * @typeParam TDeps - The dependencies type (usually ProcessorDeps)
 * 
 * @example
 * ```ts
 * const myProcessor: EventProcessor<MyPayload, ProcessorDeps> = {
 *   shouldProcess: (event) => event.type === "MY_EVENT",
 *   process: async (event, deps) => {
 *     const payload = event.payload as MyPayload;
 *     // Process the event...
 *     return { producedEvents: [{ type: "RESULT", payload: {...} }] };
 *   }
 * };
 * ```
 */
export interface EventProcessor<TPayload = unknown, TDeps = unknown> {
    /** 
     * Determines if this processor should handle the given event.
     * @param event - The event to check
     * @param deps - Processor dependencies
     * @returns True if this processor should process the event
     */
    shouldProcess: (event: Event, deps: TDeps) => boolean | Promise<boolean>;
    /** 
     * Processes the event and optionally produces new events.
     * @param event - The event to process
     * @param deps - Processor dependencies
     * @returns Optional object containing new events to enqueue
     */
    process: (event: Event, deps: TDeps) => Promise<{ producedEvents?: Array<NewEvent | NewUnknownEvent> } | void> | { producedEvents?: Array<NewEvent | NewUnknownEvent> } | void;
}

/**
 * Possible responses from an onEvent callback.
 */
export type OnEventResponse =
    | void
    | { event: Event }
    | { producedEvents: Array<NewEvent | NewUnknownEvent> }
    | { drop: true };

/**
 * Context for the event worker, containing callbacks and custom processors.
 */
export interface WorkerContext {
    /** Callback functions for event handling. */
    callbacks?: {
        /** Called for each event, can produce new events. */
        onEvent?: (ev: Event) => Promise<{ producedEvents?: Array<NewEvent | NewUnknownEvent> } | void> | { producedEvents?: Array<NewEvent | NewUnknownEvent> } | void;
        /** Called after processing to push events to the client stream. Only called if the event was not replaced by a custom processor. */
        onStreamPush?: (ev: Event) => void;
    };
    /** Custom processors organized by event type. */
    customProcessors?: Record<string, Array<EventProcessor<unknown, ProcessorDeps>>>;
    /** 
     * Minimum event priority to process. Events below this priority are skipped and left for background processing.
     * Default: 0 (skips negative-priority events like ENTITY_EXTRACT)
     */
    minPriority?: number;
}

// Generic worker
export async function startEventWorker(
    db: CopilotzDb,
    threadId: string,
    context: WorkerContext,
    processors: Record<string, EventProcessor<unknown, ProcessorDeps>>,
    buildDeps: (ops: Operations, event: Event, context: WorkerContext) => Promise<ProcessorDeps> | ProcessorDeps,
    shouldAcceptEvent?: (event: Event) => boolean
): Promise<void> {

    const dbInstance = db || await createDatabase({});

    const ops = dbInstance.ops as Operations;

    const processing = await ops.getProcessingQueueItem(threadId);

    if (processing) return;

    // Default: skip negative-priority events (background events like ENTITY_EXTRACT)
    // Set minPriority to undefined or a very negative number to process all events
    const minPriority = context.minPriority ?? 0;

    while (true) {

        const next = await ops.getNextPendingQueueItem(threadId, undefined, minPriority);

        if (!next) break;

        const eventType = next.eventType as Event["type"];
        const baseEvent = {
            id: next.id,
            threadId: next.threadId,
            parentEventId: next.parentEventId,
            traceId: next.traceId,
            priority: next.priority,
            metadata: next.metadata,
            ttlMs: next.ttlMs,
            expiresAt: next.expiresAt,
            createdAt: next.createdAt,
            updatedAt: next.updatedAt,
            status: next.status,
        };

        let event: Event;
        switch (eventType) {
            case "NEW_MESSAGE":
                event = {
                    ...baseEvent,
                    type: "NEW_MESSAGE",
                    payload: castPayload<MessagePayload>(next.payload),
                };
                break;
            case "TOOL_CALL":
                event = {
                    ...baseEvent,
                    type: "TOOL_CALL",
                    payload: castPayload<ToolCallEventPayload>(next.payload),
                };
                break;
            case "LLM_CALL":
                event = {
                    ...baseEvent,
                    type: "LLM_CALL",
                    payload: castPayload<LlmCallEventPayload>(next.payload),
                };
                break;
            case "TOKEN":
                event = {
                    ...baseEvent,
                    type: "TOKEN",
                    payload: castPayload<TokenEventPayload>(next.payload),
                };
                break;
            default:
                // Pass through unknown/custom event types; allow callback or custom processor to handle them
                event = {
                    ...baseEvent,
                    type: eventType,
                    payload: next.payload as Record<string, unknown>,
                } as unknown as Event;
                break;
        }

        if (typeof shouldAcceptEvent === 'function' && !shouldAcceptEvent(event)) {
            // Let another domain worker process this event
            break;
        }

        const queueId = typeof next.id === "string" ? next.id : String(next.id);

        await ops.updateQueueItemStatus(queueId, "processing");

        try {
            const deps: ProcessorDeps = (await buildDeps(ops, event, context)) as ProcessorDeps;

            const processor = processors[event.type];

            // Buckets to respect override semantics
            const preEvents: Array<NewEvent | NewUnknownEvent> = [];
            let finalEvents: Array<NewEvent | NewUnknownEvent> = [];

            // 1) onEvent callback with override semantics
            const handler = context?.callbacks?.onEvent;
            let overriddenByOnEvent = false;
            if (handler) {
                try {
                    const res = await handler(event);
                    if (res && (res as { producedEvents?: Array<NewEvent | NewUnknownEvent> }).producedEvents) {
                        finalEvents = (res as { producedEvents?: Array<NewEvent | NewUnknownEvent> }).producedEvents as Array<NewEvent | NewUnknownEvent>;
                        overriddenByOnEvent = true;
                    }
                } catch (_err) { /* ignore user callback errors */ }
            }

            // 2) Custom processors by event type (only if not overridden). Stop on first production.
            let replacedByCustomProcessor = false;
            if (!overriddenByOnEvent && context?.customProcessors) {
                const list = context.customProcessors[event.type] ?? [];
                for (const p of list) {
                    try {
                        const ok = await p.shouldProcess(event, deps);
                        if (!ok) continue;
                        const res = await p.process(event, deps);
                        if (res?.producedEvents && res.producedEvents.length > 0) {
                            finalEvents = res.producedEvents;
                            replacedByCustomProcessor = true;
                            // Stop at first production
                            break;
                        }
                    } catch (_err) {
                        // Ignore custom processor errors; move to next
                    }
                }
            }

            // 3) Default processor path (only if not overridden and nothing produced by custom)
            if (!overriddenByOnEvent && finalEvents.length === 0 && processor) {
                const ok = await processor.shouldProcess(event, deps);
                if (ok) {
                    const res = await processor.process(event, deps);
                    if (res?.producedEvents) finalEvents = res.producedEvents;
                }
            }

            const allToEnqueue = [...preEvents, ...finalEvents];

            if (allToEnqueue.length > 0) {
                for (const e of allToEnqueue) {
                    await enqueueEvent(db, e);
                }
            }

            // Push to stream only if not replaced by onEvent callback or custom processor
            const wasReplaced = overriddenByOnEvent || replacedByCustomProcessor;
            if (!wasReplaced && context?.callbacks?.onStreamPush) {
                try {
                    context.callbacks.onStreamPush(event);
                } catch { /* ignore stream push errors */ }
            }

            const finalStatus = overriddenByOnEvent ? "overwritten" : "completed";
            await ops.updateQueueItemStatus(queueId, finalStatus);
        } catch (err) {
            console.error("Event worker failed:", err);
            await ops.updateQueueItemStatus(queueId, "failed");
            break;
        }
    }

    // Fire-and-forget: trigger background event processing after main processing completes
    // Only if we skipped background events (minPriority > some threshold)
    if (minPriority > -Infinity) {
        // Use queueMicrotask to defer background processing without blocking return
        queueMicrotask(() => {
            processBackgroundEvents(db, threadId, context, processors, buildDeps).catch((err) => {
                console.warn("[BACKGROUND] Background event processing failed:", err);
            });
        });
    }
}

/**
 * Process background events (negative priority) for a thread.
 * Called automatically after main processing completes, or can be invoked manually.
 */
export async function processBackgroundEvents(
    db: CopilotzDb,
    threadId: string,
    context: WorkerContext,
    processors: Record<string, EventProcessor<unknown, ProcessorDeps>>,
    buildDeps: (ops: Operations, event: Event, context: WorkerContext) => Promise<ProcessorDeps> | ProcessorDeps,
): Promise<void> {
    // Process with no minimum priority (all events including negative)
    const backgroundContext: WorkerContext = {
        ...context,
        minPriority: -Infinity,
        // Don't push to stream for background events
        callbacks: {
            ...context.callbacks,
            onStreamPush: undefined,
        },
    };

    await startEventWorker(db, threadId, backgroundContext, processors, buildDeps);
}


