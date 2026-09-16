/** Reserved and settled long-term-memory checkpoint collection definition. @module */
import {
  type CollectionDefinition,
  defineCollection,
  relation,
} from "@copilotz/copilotz/collections";
import { MEMORY_EDGE } from "../internal/relations.ts";
const schema = {
  type: "object",
  properties: {
    id: { type: "string" },
    threadId: { type: "string" },
    schemaVersion: { type: "string" },
    strategy: { type: "string" },
    status: {
      type: "string",
      enum: ["pending", "ready", "failed", "cancelled"],
    },
    memorySpaceId: { type: ["string", "null"] },
    readMemorySpaceIds: { type: "array", items: { type: "string" } },
    writeMemorySpaceIds: { type: "array", items: { type: "string" } },
    defaultWriteMemorySpaceId: { type: ["string", "null"] },
    sequence: { type: "number" },
    agentId: { type: "string" },
    sourceStartMessageId: { type: "string" },
    sourceEndMessageId: { type: "string" },
    content: { type: "array" },
    embedding: { type: ["array", "null"] },
    contentHash: { type: ["string", "null"] },
    tokenEstimate: { type: ["number", "null"] },
    error: { type: ["object", "null"] },
    contextSnapshotContent: { type: "array" },
    contextSnapshot: { type: ["array", "null"] },
    metadata: { type: ["object", "null"] },
  },
  required: [
    "threadId",
    "schemaVersion",
    "strategy",
    "status",
    "sequence",
    "agentId",
    "sourceStartMessageId",
    "sourceEndMessageId",
  ],
} as const;
export const longTermMemoryCollection: CollectionDefinition<typeof schema> =
  defineCollection({
    name: "long_term_memory",
    schema: schema,
    indexes: ["threadId", "memorySpaceId", "defaultWriteMemorySpaceId", [
      "threadId",
      "agentId",
      "status",
      "sequence",
    ], ["memorySpaceId", "status", "sequence"]],
    relations: {
      thread: relation.belongsTo("thread", "threadId", "has_long_term_memory"),
      memoryRecords: relation.hasMany(
        "memory_record",
        "consolidationId",
        MEMORY_EDGE.includesRecord,
      ),
    },
    content: { fields: ["content", "contextSnapshotContent"] },
    commands: {
      completeConsolidation: {
        mutate({ current, input }) {
          if (current.status !== "pending") {
            throw new Error(
              `Memory checkpoint '${current.id}' is not pending.`,
            );
          }
          const patch =
            input && typeof input === "object" && !Array.isArray(input)
              ? input as Record<string, unknown>
              : {};
          if (patch.status !== "ready") {
            throw new TypeError(
              "Atomic memory consolidation must settle the checkpoint as ready.",
            );
          }
          return { set: patch };
        },
      },
    },
  });

export default longTermMemoryCollection;
