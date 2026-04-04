/**
 * Framework-independent event/queue helpers.
 *
 * @module
 */

import type { Copilotz } from "@/index.ts";

export function createEventHandlers(copilotz: Copilotz) {
    const { ops } = copilotz;

    return {
        /** Enqueue a new event for a thread. */
        enqueue: (
            threadId: string,
            event: Parameters<typeof ops.addToQueue>[1],
        ) => ops.addToQueue(threadId, event),

        /** Get the currently processing event for a thread. */
        getProcessing: (
            threadId: string,
            minPriority?: number,
        ) => ops.getProcessingQueueItem(threadId, minPriority),

        /** Get the next pending event for a thread. */
        getNextPending: (
            threadId: string,
            namespace?: string,
            minPriority?: number,
        ) => ops.getNextPendingQueueItem(threadId, namespace, minPriority),

        /** Update the status of a queue item. */
        updateStatus: (
            eventId: string,
            status: "pending" | "processing" | "completed" | "failed" | "expired",
        ) => ops.updateQueueItemStatus(eventId, status),
    };
}
