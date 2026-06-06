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
import { createMessageService } from "@/runtime/collections/native.ts";

export interface MessageEditResult {
  message: Message;
  rootMessageId: string;
  previousRevisionMessageId: string;
  revisionIndex: number;
}

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
  edit: (
    threadId: string,
    messageId: string,
    content: string,
  ) => Promise<MessageEditResult>;
  deleteForThread: (threadId: string) => Promise<void>;
}

/** Creates framework-independent handlers for thread message history. */
export function createMessageHandlers(copilotz: Copilotz): MessageHandlers {
  const service = createMessageService({
    collections: copilotz.collections,
    ops: copilotz.ops,
  });

  return {
    listForThread: (threadId, options) =>
      service.listForThread(threadId, options),
    getHistory: (threadId, userId, limit) =>
      service.getHistory(threadId, userId, limit),
    listFromGraph: (threadId, limit) => service.listHistory(threadId, limit),
    listPageFromGraph: (threadId, options) =>
      service.listHistoryPage(threadId, options),
    edit: (threadId, messageId, content) =>
      service.edit(threadId, messageId, content),
    deleteForThread: (threadId) => service.deleteForThread(threadId),
  };
}
