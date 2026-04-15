/**
 * Framework-independent message helpers.
 * Messages are a thread sub-resource.
 *
 * @module
 */

import type { Copilotz } from "@/index.ts";
import type { Message } from "@/types/index.ts";
import type {
  MessageHistoryPage,
  MessageHistoryPageOptions,
} from "@/database/operations/index.ts";

/** Handlers returned by {@link createMessageHandlers}. */
export interface MessageHandlers {
  listForThread: (
    threadId: string,
    options?: { limit?: number; offset?: number; order?: "asc" | "desc" },
  ) => Promise<Message[]>;
  getHistory: (
    threadId: string,
    userId: string,
    limit?: number,
  ) => Promise<Message[]>;
  listFromGraph: (
    threadId: string,
    limit?: number,
  ) => Promise<Message[]>;
  listPageFromGraph: (
    threadId: string,
    options?: MessageHistoryPageOptions,
  ) => Promise<MessageHistoryPage>;
  deleteForThread: (threadId: string) => Promise<void>;
}

export function createMessageHandlers(copilotz: Copilotz): MessageHandlers {
  const { ops } = copilotz;

  return {
    listForThread: (threadId, options) =>
      ops.getMessagesForThread(threadId, options),
    getHistory: (threadId, userId, limit) =>
      ops.getMessageHistory(threadId, userId, limit),
    listFromGraph: (threadId, limit) =>
      ops.getMessageHistoryFromGraph(threadId, limit),
    listPageFromGraph: (threadId, options) =>
      ops.getMessageHistoryPageFromGraph(threadId, options),
    deleteForThread: (threadId) => ops.deleteMessagesForThread(threadId),
  };
}
