/**
 * Framework-independent thread management helpers.
 *
 * @module
 */

import type { Copilotz } from "@/index.ts";

export function createThreadHandlers(copilotz: Copilotz) {
    const { ops } = copilotz;

    return {
        /** List threads for a participant. */
        list: (
            participantId: string,
            options?: {
                status?: "active" | "archived" | "all";
                limit?: number;
                offset?: number;
                order?: "asc" | "desc";
            },
        ) => ops.getThreadsForParticipant(participantId, options),

        /** Get a thread by its internal ID. */
        getById: (id: string) => ops.getThreadById(id),

        /** Get a thread by its external ID. */
        getByExternalId: (externalId: string) => ops.getThreadByExternalId(externalId),

        /** Find an existing thread or create a new one. */
        findOrCreate: (
            threadId: string | undefined,
            threadData: Parameters<typeof ops.findOrCreateThread>[1],
        ) => ops.findOrCreateThread(threadId, threadData),

        /** Archive a thread with a summary. */
        archive: (id: string, summary: string) => ops.archiveThread(id, summary),
    };
}
