import {
  type CollectionDefinition,
  defineCollection,
  relation,
} from "@copilotz/copilotz/collections";
import {
  contentSequenceSchema,
  metadataSchema,
  safeErrorSchema,
  timestampsSchema,
} from "./schema.ts";

const TERMINAL = new Set(["closed", "failed", "abandoned"]);

function requireOpen(state: unknown, id: unknown): void {
  if (TERMINAL.has(String(state))) {
    throw new Error(`Stream '${id}' is already '${state}'.`);
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

/**
 * Stream lifecycle events are created/updated/deleted only. Bytes live in the
 * progressive body store. Phase 8 owns the writer; this file is the record.
 */
export const streamCollection: CollectionDefinition = defineCollection({
  name: "stream",
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      id: { type: "string" },
      namespace: { type: "string" },
      threadId: { type: "string" },
      participantId: { type: "string" },
      lane: { type: "string" },
      mediaType: { type: "string" },
      state: {
        type: "string",
        enum: ["open", "closed", "failed", "abandoned"],
      },
      content: contentSequenceSchema,
      safeError: safeErrorSchema,
      metadata: metadataSchema,
      ...timestampsSchema,
    },
    required: [
      "id",
      "namespace",
      "threadId",
      "lane",
      "mediaType",
      "state",
      "content",
      "metadata",
      "createdAt",
      "updatedAt",
    ],
  } as const,
  defaults: {
    state: "open",
    content: [],
    metadata: {},
  },
  relations: {
    thread: relation.belongsTo("thread", "threadId", "has_stream"),
    participant: relation.belongsTo(
      "participant",
      "participantId",
      "emitted_stream",
    ),
  },
  queries: {
    byThreadId: {
      filter({ input }) {
        return { threadId: String(input.threadId ?? "") };
      },
    },
    byThreadLaneState: {
      filter({ input }) {
        return {
          threadId: String(input.threadId ?? ""),
          lane: String(input.lane ?? ""),
          state: String(input.state ?? ""),
        };
      },
    },
  },
  commands: {
    close: {
      mutate({ current, input }) {
        requireOpen(current.state, current.id);
        const body = asRecord(input);
        return {
          set: {
            state: "closed",
            ...(body.content ? { content: body.content } : {}),
            ...(body.metadata ? { metadata: body.metadata } : {}),
          },
        };
      },
    },
    fail: {
      mutate({ current, input }) {
        requireOpen(current.state, current.id);
        const body = asRecord(input);
        const message = String(body.message ?? "Stream failed");
        return {
          set: {
            state: "failed",
            safeError: {
              message,
              ...(body.code ? { code: body.code } : {}),
            },
            ...(body.content ? { content: body.content } : {}),
            ...(body.metadata ? { metadata: body.metadata } : {}),
          },
        };
      },
    },
    abandon: {
      mutate({ current, input }) {
        requireOpen(current.state, current.id);
        const body = asRecord(input);
        return {
          set: {
            state: "abandoned",
            ...(body.reason
              ? { safeError: { message: String(body.reason) } }
              : {}),
            ...(body.metadata ? { metadata: body.metadata } : {}),
          },
        };
      },
    },
  },
});
