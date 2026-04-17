/**
 * Event processing system for Copilotz.
 *
 * This module provides the event queue processing infrastructure,
 * including a unified processor pipeline and extension points for
 * custom processors.
 *
 * @module
 */

import { type CopilotzDb, createDatabase } from "@/database/index.ts";

import type {
  Event,
  LlmCallEventPayload,
  LlmResultEventPayload,
  MessagePayload,
  NewEvent,
  NewUnknownEvent,
  Thread,
  TokenEventPayload,
  ToolCallEventPayload,
  ToolResultEventPayload,
} from "@/types/index.ts";

type EventType = Event["type"];

import type { LLMCallPayload } from "@/resources/processors/llm_call/index.ts";
import type {
  ToolCallPayload,
  ToolExecutionContext,
} from "@/resources/processors/tool_call/index.ts";
import type { ChatContext } from "@/types/index.ts";

import type {
  ExecutableTool,
  ToolExecutor,
} from "@/resources/processors/tool_call/types.ts";

export type {
  /** Tool with an execute function. */
  ExecutableTool,
  /** Payload for LLM call events. */
  LLMCallPayload,
  /** Payload for LLM call results. */
  LlmResultEventPayload as LLMResultPayload,
  /** Payload for tool call events. */
  ToolCallPayload,
  /** Context passed to tool execution. */
  ToolExecutionContext,
  /** Function signature for tool execution. */
  ToolExecutor,
  /** Payload for tool call results. */
  ToolResultEventPayload as ToolResultPayload,
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
 * Provides access to database, current thread, chat context, and stream emission.
 */
export type ProcessorDeps = {
  /** Database instance for data operations. */
  db: CopilotzDb;
  /** Current conversation thread. */
  thread: Thread;
  /** Chat context with configuration. */
  context: ChatContext;
  /** Push an ephemeral event (e.g. TOKEN, ASSET_CREATED) directly to the client stream. */
  emitToStream: (event: Event) => void;
};

type Operations = CopilotzDb["ops"];

function castPayload<T>(payload: unknown): T {
  return payload as T;
}

// Public API
export async function enqueueEvent(
  db: CopilotzDb,
  event: NewEvent | NewUnknownEvent,
): Promise<void> {
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
  context: ChatContext,
  emitToStream: (event: Event) => void,
): Promise<void> {
  const workerContext: WorkerContext = {
    processors: context.processors ?? {},
    emitToStream,
    stream: context.stream ?? true,
  };

  await startEventWorker(
    db,
    threadId,
    workerContext,
    async (ops: Operations, event: Event) => {
      const { threadId } = event;
      if (typeof threadId !== "string") {
        throw new Error("Invalid thread id for event");
      }

      const thread = await ops.getThreadById(threadId);
      if (!thread) throw new Error(`Thread not found: ${threadId}`);
      return { ops, db, thread, context, emitToStream } as ProcessorDeps;
    },
  );
}

/**
 * Interface for custom event processors.
 *
 * Processors are executed in priority order (user/config first, built-in last)
 * for the matching event type. The first processor whose `process` returns
 * a `producedEvents` array wins — subsequent processors are skipped.
 *
 * ### Return semantics for `process`
 *
 * | Return value                       | Behavior                                        |
 * |------------------------------------|-------------------------------------------------|
 * | `{ producedEvents: [event, ...] }` | **Claim** — enqueue events, skip remaining processors |
 * | `{ producedEvents: [] }`           | **Swallow** — claim without producing anything  |
 * | `void` / `undefined`               | **Pass** — fall through to the next processor   |
 *
 * @typeParam TPayload - The expected payload type for events this processor handles
 * @typeParam TDeps - The dependencies type (usually ProcessorDeps)
 *
 * @example
 * ```ts
 * // Override: produce new events, prevent built-in from running
 * const override: EventProcessor<MyPayload, ProcessorDeps> = {
 *   shouldProcess: (event) => event.payload.custom === true,
 *   process: async (event, deps) => {
 *     return { producedEvents: [{ type: "RESULT", ... }] };
 *   },
 * };
 *
 * // Swallow: handle the event, prevent built-in, produce nothing
 * const swallow: EventProcessor<MyPayload, ProcessorDeps> = {
 *   shouldProcess: () => true,
 *   process: async (event, deps) => {
 *     console.log("Handled:", event.type);
 *     return { producedEvents: [] };
 *   },
 * };
 *
 * // Pass: let the next processor (or built-in) handle it
 * const observer: EventProcessor<MyPayload, ProcessorDeps> = {
 *   shouldProcess: () => true,
 *   process: async (event, deps) => {
 *     console.log("Observed:", event.type);
 *     // returning void falls through
 *   },
 * };
 * ```
 */
export interface EventProcessor<TPayload = unknown, TDeps = unknown> {
  /**
   * Determines if this processor should handle the given event.
   * Return `false` to skip this processor entirely (next processor runs).
   */
  shouldProcess: (event: Event, deps: TDeps) => boolean | Promise<boolean>;
  /**
   * Processes the event.
   *
   * - Return `{ producedEvents: [...] }` to claim the event and enqueue new events.
   * - Return `{ producedEvents: [] }` to claim without producing (swallow).
   * - Return `void` / `undefined` to pass through to the next processor.
   */
  process: (
    event: Event,
    deps: TDeps,
  ) =>
    | Promise<{ producedEvents?: Array<NewEvent | NewUnknownEvent> } | void>
    | { producedEvents?: Array<NewEvent | NewUnknownEvent> }
    | void;
}

/**
 * Context for the event worker, containing processors and stream emission.
 */
export interface WorkerContext {
  /** Processors organized by event type, ordered by priority. */
  processors: Record<
    string,
    Array<EventProcessor<unknown, ProcessorDeps>>
  >;
  /** Push an ephemeral event directly to the client stream. */
  emitToStream: (event: Event) => void;
  /** Whether streaming is enabled. */
  stream: boolean;
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
  buildDeps: (
    ops: Operations,
    event: Event,
    context: WorkerContext,
  ) => Promise<ProcessorDeps> | ProcessorDeps,
  shouldAcceptEvent?: (event: Event) => boolean,
): Promise<void> {
  const dbInstance = db || await createDatabase({});

  const ops = dbInstance.ops as Operations;

  const workerId = crypto.randomUUID();
  const { heartbeatMs } = ops.getThreadWorkerLeaseConfig();

  const acquiredLease = await ops.acquireThreadWorkerLease(threadId, workerId);
  if (!acquiredLease) return;

  let leaseLost = false;
  let leaseReleased = false;
  const assertLeaseOwnership = async (): Promise<void> => {
    const ownsLease = await ops.isThreadWorkerLeaseOwner(threadId, workerId);
    if (!ownsLease) {
      leaseLost = true;
      throw new Error(
        `Thread lease lost for thread ${threadId}; aborting worker progress.`,
      );
    }
  };
  const heartbeatTimer = setInterval(() => {
    Promise.resolve()
      .then(() => ops.renewThreadWorkerLease(threadId, workerId))
      .then((ok) => {
        if (!ok) {
          leaseLost = true;
          clearInterval(heartbeatTimer);
          console.warn(
            `[worker-lease] Lost thread lease for thread ${threadId}; stopping worker.`,
          );
        }
      })
      .catch((err) => {
        console.warn(
          `[worker-lease] Failed to renew thread lease for thread ${threadId}:`,
          err,
        );
      });
  }, heartbeatMs);

  const minPriority = context.minPriority ?? 0;

  try {
    const recovered = await ops.recoverThreadProcessingQueueItems(threadId);
    if (recovered > 0) {
      console.warn(
        `[recovery] Reset ${recovered} stuck "processing" event(s) to "pending" in thread ${threadId}.`,
      );
    }

    while (true) {
      if (leaseLost) break;

      const next = await ops.getNextPendingQueueItem(
        threadId,
        undefined,
        minPriority,
      );

      if (!next) {
        const released = await ops.releaseThreadWorkerLeaseIfNoPendingWork(
          threadId,
          workerId,
          minPriority,
        );
        if (released) {
          leaseReleased = true;
          break;
        }
        continue;
      }

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
        case "TOOL_RESULT":
          event = {
            ...baseEvent,
            type: "TOOL_RESULT",
            payload: castPayload<ToolResultEventPayload>(next.payload),
          };
          break;
        case "LLM_RESULT":
          event = {
            ...baseEvent,
            type: "LLM_RESULT",
            payload: castPayload<LlmResultEventPayload>(next.payload),
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
          event = {
            ...baseEvent,
            type: eventType,
            payload: next.payload as Record<string, unknown>,
          } as unknown as Event;
          break;
      }

      if (
        typeof shouldAcceptEvent === "function" && !shouldAcceptEvent(event)
      ) {
        break;
      }

      const queueId = typeof next.id === "string" ? next.id : String(next.id);

      await assertLeaseOwnership();
      await ops.updateQueueItemStatus(queueId, "processing");

      try {
        context.emitToStream(event);
      } catch { /* ignore stream push errors */ }

      try {
        const deps: ProcessorDeps = (await buildDeps(
          ops,
          event,
          context,
        )) as ProcessorDeps;

        let finalEvents: Array<NewEvent | NewUnknownEvent> = [];

        const processorList = context.processors[event.type] ?? [];
        for (const p of processorList) {
          try {
            const ok = await p.shouldProcess(event, deps);
            if (!ok) continue;
            const res = await p.process(event, deps);
            if (res?.producedEvents) {
              finalEvents = res.producedEvents;
              break;
            }
          } catch (_err) {
            // Ignore processor errors; try next processor in priority order
          }
        }

        const backgroundThreadIds = new Set<string>();

        await assertLeaseOwnership();

        if (finalEvents.length > 0) {
          for (const e of finalEvents) {
            await enqueueEvent(db, e);

            if (e.threadId !== threadId) {
              backgroundThreadIds.add(e.threadId);
            }
          }
        }

        for (const bgThreadId of backgroundThreadIds) {
          startBackgroundWorker(
            db,
            bgThreadId,
            context,
            buildDeps,
          );
        }

        await ops.updateQueueItemStatus(queueId, "completed");
      } catch (err) {
        console.error("Event worker failed:", err);
        if (!leaseLost) {
          await ops.updateQueueItemStatus(queueId, "failed");
        }
        break;
      }
    }
  } finally {
    clearInterval(heartbeatTimer);
    if (!leaseReleased) {
      await ops.releaseThreadWorkerLease(threadId, workerId);
    }
  }
}

/**
 * Start a background worker for a child thread.
 * This processes events in a separate thread queue without blocking the main thread.
 * Fire-and-forget: errors are logged but don't propagate.
 */
export function startBackgroundWorker(
  db: CopilotzDb,
  backgroundThreadId: string,
  context: WorkerContext,
  buildDeps: (
    ops: Operations,
    event: Event,
    context: WorkerContext,
  ) => Promise<ProcessorDeps> | ProcessorDeps,
): void {
  Promise.resolve().then(async () => {
    const noop = () => {};
    const backgroundContext: WorkerContext = {
      ...context,
      minPriority: -Infinity,
      emitToStream: noop,
    };

    await startEventWorker(
      db,
      backgroundThreadId,
      backgroundContext,
      buildDeps,
    );
  }).catch((err) => {
    console.warn("[BACKGROUND] Background worker failed:", err);
  });
}
