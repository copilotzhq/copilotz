// Import Database
import { createDatabase, type CopilotzDb } from "@/database/index.ts";

// Import Agent Interfaces  
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

// Import Processors
import { llmCallProcessor } from "./llm_call/index.ts";
import { messageProcessor } from "./new_message/index.ts";
import { toolCallProcessor } from "./tool_call/index.ts";
import { ragIngestProcessor } from "./rag_ingest/index.ts";

// Internal Event Types
type EventType = Event["type"];

// Typed Event Payloads
import type { LLMCallPayload, LLMResultPayload } from "./llm_call/index.ts";
import type { ToolCallPayload, ToolResultPayload, ToolExecutionContext } from "./tool_call/index.ts";
import type { ChatContext } from "@/interfaces/index.ts";

import type { ExecutableTool, ToolExecutor } from "./tool_call/types.ts";
export type { LLMCallPayload, LLMResultPayload, ToolCallPayload, ToolResultPayload, ToolExecutionContext, ExecutableTool, ToolExecutor };

export interface ProcessResult {
    producedEvents: Array<NewEvent | NewUnknownEvent>;
}

export type ProcessorDeps = {
    db: CopilotzDb;
    thread: Thread;
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
};

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
        metadata:event.metadata,
        ttlMs: event.ttlMs ?? undefined,
        status: event.status,
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

export interface EventProcessor<TPayload = unknown, TDeps = unknown> {
    shouldProcess: (event: Event, deps: TDeps) => boolean | Promise<boolean>;
    process: (event: Event, deps: TDeps) => Promise<{ producedEvents?: Array<NewEvent | NewUnknownEvent> } | void> | { producedEvents?: Array<NewEvent | NewUnknownEvent> } | void;
}

export type OnEventResponse =
    | void
    | { event: Event }
    | { producedEvents: Array<NewEvent | NewUnknownEvent> }
    | { drop: true };

export interface WorkerContext {
    callbacks?: {
        onEvent?: (ev: Event) => Promise<{ producedEvents?: Array<NewEvent | NewUnknownEvent> } | void> | { producedEvents?: Array<NewEvent | NewUnknownEvent> } | void;
        /** Called after processing to push events to the client stream. Only called if the event was not replaced by a custom processor. */
        onStreamPush?: (ev: Event) => void;
    };
    customProcessors?: Record<string, Array<EventProcessor<unknown, ProcessorDeps>>>;
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

    while (true) {

        const next = await ops.getNextPendingQueueItem(threadId);

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

}


