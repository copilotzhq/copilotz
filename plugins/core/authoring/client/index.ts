/** Typed conversation API over the browser-safe generic client. @module */
import type {
  CopilotzClient,
  ObserveOptions,
  OperationReceipt,
  ReadOptions,
  SubmitOptions,
} from "../../../../client/index.ts";
import type {
  ConversationMessage,
  ConversationThread,
} from "../../../core-collections/internal/contracts.ts";
import type { ContentInput } from "@copilotz/copilotz/content";
export type {
  ConversationMessage,
  ConversationThread,
} from "../../../core-collections/internal/contracts.ts";
export type Page<T> = Readonly<
  {
    data: readonly T[];
    pageInfo: Readonly<
      { next?: string; hasMore: boolean; checkpoint?: string }
    >;
  }
>;
export type HistoryQuery = Readonly<
  {
    after?: string;
    before?: string;
    limit?: number;
    order?: "asc" | "desc";
    view?: "active" | "all";
  }
>;
export type ThreadQuery =
  & HistoryQuery
  & Readonly<{ status?: "active" | "archived" | "closed" }>;
export type SendInput = Readonly<
  ({ threadId: string; externalThreadId?: never } | {
    externalThreadId: string;
    threadId?: never;
  }) & {
    content: ContentInput | readonly ContentInput[];
    /** Agent IDs to enroll without addressing the message to them. */
    participantIds?: readonly string[];
    recipientIds?: readonly string[];
  }
>;

export function createCoreClient(client: CopilotzClient): CoreClient {
  const path = (id: string) => `/threads/${encodeURIComponent(id)}`;
  const query = (input: unknown) =>
    `?query=${encodeURIComponent(JSON.stringify(input ?? {}))}`;
  return Object.freeze({
    threads: Object.freeze({
      list: (input: ThreadQuery = {}, options: ReadOptions = {}) =>
        client.http.json(`/threads${query(input)}`, options) as Promise<
          Page<ConversationThread>
        >,
      async get(id: string, options: ReadOptions = {}) {
        return (await client.http.json(path(id), options) as {
          data: ConversationThread;
        }).data;
      },
      messages: (
        id: string,
        input: HistoryQuery = {},
        options: ReadOptions = {},
      ) =>
        client.http.json(
          `${path(id)}/messages${query(input)}`,
          options,
        ) as Promise<
          Page<ConversationMessage>
        >,
      send: (input: SendInput, options: SubmitOptions) =>
        client.actions.submit(
          "copilotz.core.conversation.send",
          input,
          options,
        ),
      observe: (id: string, options: ObserveOptions) =>
        client.http.observe(`${path(id)}/observe`, {}, options),
      update: (
        id: string,
        patch: ThreadPatch,
        options: SubmitOptions,
      ) =>
        client.actions.submit("copilotz.core.conversation.update", {
          threadId: id,
          patch,
        }, options),
      delete: (id: string, options: SubmitOptions) =>
        client.actions.submit("copilotz.core.conversation.delete", {
          threadId: id,
        }, options),
    }),
    messages: Object.freeze({
      edit: (
        threadId: string,
        messageId: string,
        input: EditMessageInput,
        options: SubmitOptions,
      ) =>
        client.actions.submit("copilotz.core.conversation.edit-message", {
          ...input,
          threadId,
          messageId,
        }, options),
    }),
    operations: client.operations,
    assets: client.assets,
  });
}
export type ThreadPatch = Readonly<{
  name?: string;
  description?: string;
  tags?: readonly { id: string; name: string; color?: string }[];
  status?: "active" | "archived" | "closed";
}>;
export type EditMessageInput = {
  content: ContentInput | readonly ContentInput[];
};
export type CoreClient = Readonly<{
  threads: Readonly<{
    list(
      input?: ThreadQuery,
      options?: ReadOptions,
    ): Promise<Page<ConversationThread>>;
    get(id: string, options?: ReadOptions): Promise<ConversationThread>;
    messages(
      id: string,
      input?: HistoryQuery,
      options?: ReadOptions,
    ): Promise<Page<ConversationMessage>>;
    send(input: SendInput, options: SubmitOptions): Promise<OperationReceipt>;
    observe(id: string, options: ObserveOptions): Promise<string | undefined>;
    update(
      id: string,
      patch: ThreadPatch,
      options: SubmitOptions,
    ): Promise<OperationReceipt>;
    delete(id: string, options: SubmitOptions): Promise<OperationReceipt>;
  }>;
  messages: Readonly<{
    edit(
      threadId: string,
      messageId: string,
      input: EditMessageInput,
      options: SubmitOptions,
    ): Promise<OperationReceipt>;
  }>;
  operations: CopilotzClient["operations"];
  assets: CopilotzClient["assets"];
}>;
