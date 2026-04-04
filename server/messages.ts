/**
 * Framework-independent message helpers.
 * Messages are a thread sub-resource.
 *
 * @module
 */

import type { Copilotz } from "@/index.ts";

export function createMessageHandlers(copilotz: Copilotz) {
    const { ops } = copilotz;

    return {
        /** Get messages for a thread (graph-backed). */
        listForThread: (
            threadId: string,
            options?: { limit?: number; offset?: number; order?: "asc" | "desc" },
        ) => ops.getMessagesForThread(threadId, options),

        /** Get message history for a thread + user pair. */
        getHistory: (
            threadId: string,
            userId: string,
            limit?: number,
        ) => ops.getMessageHistory(threadId, userId, limit),

        /** Get message history from graph (nodes with type='message'). */
        listFromGraph: (
            threadId: string,
            limit?: number,
        ) => ops.getMessageHistoryFromGraph(threadId, limit),
    };
}
