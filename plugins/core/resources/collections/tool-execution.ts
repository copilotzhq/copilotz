import {
  defineCollection,
  relation,
  type CollectionDefinition,
} from "@copilotz/copilotz/collections";
import {
  contentSequenceSchema,
  metadataSchema,
  safeErrorSchema,
  timestampsSchema,
} from "./schema.ts";

const TERMINAL = new Set(["completed", "failed", "cancelled"]);

function requireMutable(status: unknown, id: unknown): void {
  if (TERMINAL.has(String(status))) {
    throw new Error(`Tool execution '${id}' is already '${status}'.`);
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export const toolExecutionCollection: CollectionDefinition = defineCollection({
  name: "tool_execution",
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      id: { type: "string" },
      namespace: { type: "string" },
      threadId: { type: "string" },
      messageId: { type: "string" },
      participantId: { type: "string" },
      agentId: { type: "string" },
      toolCallId: { type: "string" },
      tool: { type: "object" },
      status: {
        type: "string",
        enum: ["pending", "running", "completed", "failed", "cancelled"],
      },
      content: contentSequenceSchema,
      historyVisibility: { type: "string" },
      safeError: safeErrorSchema,
      startedAt: { type: "string" },
      finishedAt: { type: "string" },
      durationMs: { type: "number" },
      metadata: metadataSchema,
      ...timestampsSchema,
    },
    required: [
      "id",
      "namespace",
      "threadId",
      "toolCallId",
      "tool",
      "status",
      "content",
      "metadata",
      "createdAt",
      "updatedAt",
    ],
  } as const,
  defaults: {
    status: "running",
    content: [],
    metadata: {},
  },
  identity: {
    sourceType: "tool_call",
    sourceField: "toolCallId",
  },
  relations: {
    thread: relation.belongsTo("thread", "threadId", "has_tool_execution"),
    message: relation.belongsTo("message", "messageId", "has_tool_execution"),
    participant: relation.belongsTo(
      "participant",
      "participantId",
      "has_tool_execution",
    ),
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
            ...(body.finishedAt ? { finishedAt: body.finishedAt } : {}),
            ...(body.durationMs !== undefined
              ? { durationMs: body.durationMs }
              : {}),
            ...(body.historyVisibility
              ? { historyVisibility: body.historyVisibility }
              : {}),
            ...(body.metadata ? { metadata: body.metadata } : {}),
          },
        };
      },
    },
    fail: {
      mutate({ current, input }) {
        requireMutable(current.status, current.id);
        const body = asRecord(input);
        return {
          set: {
            status: "failed",
            safeError: {
              message: String(body.message ?? "Tool execution failed"),
              ...(body.code ? { code: body.code } : {}),
            },
            ...(body.content ? { content: body.content } : {}),
            ...(body.finishedAt ? { finishedAt: body.finishedAt } : {}),
            ...(body.durationMs !== undefined
              ? { durationMs: body.durationMs }
              : {}),
            ...(body.historyVisibility
              ? { historyVisibility: body.historyVisibility }
              : {}),
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
            ...(body.content ? { content: body.content } : {}),
            ...(body.finishedAt ? { finishedAt: body.finishedAt } : {}),
            ...(body.durationMs !== undefined
              ? { durationMs: body.durationMs }
              : {}),
            ...(body.historyVisibility
              ? { historyVisibility: body.historyVisibility }
              : {}),
            ...(body.metadata ? { metadata: body.metadata } : {}),
          },
        };
      },
    },
  },
});
