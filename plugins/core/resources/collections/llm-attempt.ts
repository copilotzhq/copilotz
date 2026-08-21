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

const TERMINAL = new Set([
  "completed",
  "failed",
  "cancelled",
  "superseded",
]);

function requireMutable(status: unknown, id: unknown): void {
  if (TERMINAL.has(String(status))) {
    throw new Error(`LLM attempt '${id}' is already '${status}'.`);
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export const llmAttemptCollection: CollectionDefinition = defineCollection({
  name: "llm_attempt",
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      id: { type: "string" },
      namespace: { type: "string" },
      threadId: { type: "string" },
      messageId: { type: "string" },
      participantId: { type: "string" },
      initiatorParticipantId: { type: "string" },
      agentId: { type: "string" },
      provider: { type: "string" },
      model: { type: "string" },
      status: {
        type: "string",
        enum: [
          "pending",
          "running",
          "completed",
          "failed",
          "cancelled",
          "superseded",
        ],
      },
      attemptIndex: { type: "integer" },
      parentAttemptId: { type: "string" },
      inputMessageIds: {
        type: "array",
        items: { type: "string" },
      },
      availableToolIds: {
        type: "array",
        items: { type: "string" },
      },
      content: contentSequenceSchema,
      finishReason: { type: "string" },
      usage: { type: "object" },
      cost: { type: "object" },
      safeError: safeErrorSchema,
      startedAt: { type: "string" },
      finishedAt: { type: "string" },
      metricsFinalizedAt: { type: "string" },
      metadata: metadataSchema,
      ...timestampsSchema,
    },
    required: [
      "id",
      "namespace",
      "threadId",
      "status",
      "attemptIndex",
      "inputMessageIds",
      "availableToolIds",
      "content",
      "metadata",
      "createdAt",
      "updatedAt",
    ],
  } as const,
  defaults: {
    status: "running",
    attemptIndex: 0,
    inputMessageIds: [],
    availableToolIds: [],
    content: [],
    metadata: {},
  },
  content: { fields: ["content"] },
  identity: {
    sourceType: "llm_attempt",
    sourceField: "id",
  },
  relations: {
    thread: relation.belongsTo("thread", "threadId", "has_llm_attempt"),
    message: relation.belongsTo("message", "messageId", "has_llm_attempt"),
  },
  queries: {
    byThreadParticipantStatus: {
      filter({ input }) {
        return {
          threadId: String(input.threadId ?? ""),
          participantId: String(input.participantId ?? ""),
          status: String(input.status ?? ""),
        };
      },
    },
  },
  commands: {
    complete: {
      mutate({ current, input }) {
        requireMutable(current.status, current.id);
        const body = asRecord(input);
        return {
          set: {
            status: "completed",
            ...(body.content ? { content: body.content } : {}),
            ...(body.finishReason ? { finishReason: body.finishReason } : {}),
            ...(body.usage ? { usage: body.usage } : {}),
            ...(body.cost ? { cost: body.cost } : {}),
            ...(body.finishedAt ? { finishedAt: body.finishedAt } : {}),
            ...(body.metricsFinalizedAt
              ? { metricsFinalizedAt: body.metricsFinalizedAt }
              : {}),
            ...(body.provider ? { provider: body.provider } : {}),
            ...(body.model ? { model: body.model } : {}),
            ...(body.metadata ? { metadata: body.metadata } : {}),
          },
        };
      },
    },
    fail: {
      mutate({ current, input }) {
        requireMutable(current.status, current.id);
        const body = asRecord(input);
        const message = String(body.message ?? "LLM attempt failed");
        return {
          set: {
            status: "failed",
            safeError: {
              message,
              ...(body.code ? { code: body.code } : {}),
            },
            ...(body.content ? { content: body.content } : {}),
            ...(body.finishedAt ? { finishedAt: body.finishedAt } : {}),
            ...(body.usage ? { usage: body.usage } : {}),
            ...(body.cost ? { cost: body.cost } : {}),
            ...(body.metadata ? { metadata: body.metadata } : {}),
          },
        };
      },
    },
    cancel: {
      mutate({ current, input }) {
        requireMutable(current.status, current.id);
        const body = asRecord(input);
        return {
          set: {
            status: "cancelled",
            ...(body.reason
              ? { safeError: { message: String(body.reason) } }
              : {}),
            ...(body.finishedAt ? { finishedAt: body.finishedAt } : {}),
            ...(body.metadata ? { metadata: body.metadata } : {}),
          },
        };
      },
    },
  },
});
