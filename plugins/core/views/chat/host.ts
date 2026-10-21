/** The host capability behind live replies, Stop and attachments. @module */
import type { CopilotzClient } from "../../../../client/index.ts";
import type { FeedFrame } from "../../shared/chat-feed.ts";

/** A persisted attachment reference, as Core content stores it. */
export type UploadedContent = Readonly<{
  assetId: string;
  kind: string;
  role?: string;
  mediaType: string;
  name?: string;
  disposition?: string;
}>;

/**
 * Granted by the host as `adapters.core.feed`. Without it the chat still works
 * from live Collections, without progressive replies, Stop or uploads.
 */
export interface ThreadFeedAdapter {
  /** Follow a thread's feed from `checkpoint`; resolves with the last applied one. */
  observe(
    threadId: string,
    options: {
      checkpoint?: string;
      signal: AbortSignal;
      onFrame(frame: FeedFrame): void | Promise<void>;
    },
  ): Promise<string | undefined>;
  /** Cancel one running operation (Stop). */
  cancel(operationId: string): Promise<void>;
  /** Publish an attachment body; the result goes into the message content. */
  upload?(
    file: Blob,
    options: {
      name?: string;
      mediaType: string;
      idempotencyKey: string;
      signal?: AbortSignal;
    },
  ): Promise<UploadedContent>;
  /** Read a persisted attachment body for a preview or download. */
  asset?(
    threadId: string,
    messageId: string,
    assetId: string,
    signal?: AbortSignal,
  ): Promise<Blob>;
}

function uploaded(value: unknown): UploadedContent {
  const body = value && typeof value === "object"
    ? value as Record<string, unknown>
    : {};
  const content = (body.content ??
    (body.data as Record<string, unknown> | undefined)?.content) as
      | UploadedContent
      | undefined;
  if (!content || typeof content.assetId !== "string") {
    throw new Error("The upload returned no content reference.");
  }
  return content;
}

const thread = (id: string) => `/threads/${encodeURIComponent(id)}`;

/**
 * The SDK binding over Core HTTP (`coreHttpPlugin`): the thread feed
 * (`POST /threads/:id/observe`), operation cancel, Asset upload and message
 * attachments.
 */
export function threadFeedAdapter(client: CopilotzClient): ThreadFeedAdapter {
  return {
    observe: (threadId, options) =>
      client.http.observe(`${thread(threadId)}/observe`, {}, {
        ...(options.checkpoint ? { checkpoint: options.checkpoint } : {}),
        signal: options.signal,
        onFrame: (frame) => options.onFrame(frame as FeedFrame),
      }),
    async cancel(operationId) {
      await client.operations.cancel(operationId);
    },
    async upload(file, options) {
      return uploaded(
        await client.assets.upload(file, {
          mediaType: options.mediaType,
          ...(options.name ? { filename: options.name } : {}),
          idempotencyKey: options.idempotencyKey,
          ...(options.signal ? { signal: options.signal } : {}),
        }),
      );
    },
    async asset(threadId, messageId, assetId, signal) {
      const response = await client.http.request(
        `${thread(threadId)}/messages/${encodeURIComponent(messageId)}/assets/${
          encodeURIComponent(assetId)
        }`,
        signal ? { signal } : {},
      );
      if (!response.ok) throw new Error("The attachment is unavailable.");
      return await response.blob();
    },
  };
}
