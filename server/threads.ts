/**
 * Framework-independent thread management helpers.
 *
 * @module
 */

import type { Copilotz } from "@/index.ts";
import type { Thread } from "@/database/schemas/index.ts";

/** Handlers returned by {@link createThreadHandlers}. */
export interface ThreadHandlers {
  list: (
    participantId: string,
    options?: {
      status?: "active" | "archived" | "all";
      limit?: number;
      offset?: number;
      order?: "asc" | "desc";
    },
  ) => Promise<Thread[]>;
  getById: (id: string) => Promise<Thread | undefined>;
  getByExternalId: (externalId: string) => Promise<Thread | undefined>;
  findOrCreate: (
    threadId: string | undefined,
    threadData: Parameters<Copilotz["ops"]["findOrCreateThread"]>[1],
  ) => Promise<Thread>;
  update: (
    id: string,
    updates: Parameters<Copilotz["ops"]["updateThread"]>[1],
  ) => Promise<Thread | null>;
  delete: (id: string) => Promise<void>;
  archive: (id: string, summary: string) => Promise<Thread | null>;
}

export function createThreadHandlers(copilotz: Copilotz): ThreadHandlers {
  const { ops } = copilotz;

  return {
    list: (participantId, options) =>
      ops.getThreadsForParticipant(participantId, options),
    getById: (id) => ops.getThreadById(id),
    getByExternalId: (externalId) => ops.getThreadByExternalId(externalId),
    findOrCreate: (threadId, threadData) =>
      ops.findOrCreateThread(threadId, threadData),
    update: (id, updates) => ops.updateThread(id, updates),
    delete: (id) => ops.deleteThread(id),
    archive: (id, summary) => ops.archiveThread(id, summary),
  };
}
