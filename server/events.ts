/**
 * Framework-independent event/queue helpers.
 *
 * @module
 */

import type { Copilotz } from "@/index.ts";
import type { Queue } from "@/database/schemas/index.ts";
import type { QueueEventInput } from "@/database/operations/index.ts";

/** Handlers returned by {@link createEventHandlers}. */
export interface EventHandlers {
    enqueue: (
        threadId: string,
        event: QueueEventInput,
    ) => Promise<Record<string, unknown>>;
    getProcessing: (
        threadId: string,
        minPriority?: number,
    ) => Promise<Queue | undefined>;
    getNextPending: (
        threadId: string,
        namespace?: string,
        minPriority?: number,
    ) => Promise<Queue | undefined>;
    updateStatus: (
        eventId: string,
        status: "pending" | "processing" | "completed" | "failed" | "expired",
    ) => Promise<void>;
}

export function createEventHandlers(copilotz: Copilotz): EventHandlers {
    const { ops } = copilotz;

    return {
        enqueue: (threadId, event) =>
            ops.addToQueue(threadId, event),
        getProcessing: (threadId, minPriority) =>
            ops.getProcessingQueueItem(threadId, minPriority),
        getNextPending: (threadId, namespace, minPriority) =>
            ops.getNextPendingQueueItem(threadId, namespace, minPriority),
        updateStatus: (eventId, status) =>
            ops.updateQueueItemStatus(eventId, status),
    };
}
