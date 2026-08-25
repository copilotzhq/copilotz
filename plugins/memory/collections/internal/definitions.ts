/**
 * Memory collection definitions retained as schema sources for leaf owners.
 *
 * @module
 */

import {
  type CollectionDefinitionInput,
  relation,
} from "@copilotz/copilotz/collections";

const MEMORY_EDGE = Object.freeze({
  usesSpace: "uses_memory_space",
  hasRecord: "has_memory_record",
  includesRecord: "includes_memory_record",
});

const memorySpaceSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    scopeType: { type: "string" },
    scopeId: { type: "string" },
    kind: { type: ["string", "null"] },
    ownerNodeId: { type: ["string", "null"] },
    threadId: { type: ["string", "null"] },
    access: {
      type: ["string", "null"],
      enum: ["read", "read_write", null],
    },
    defaultWrite: { type: ["boolean", "null"] },
    description: { type: ["string", "null"] },
    metadata: { type: ["object", "null"] },
  },
  required: ["scopeType", "scopeId"],
} as const;

export const memorySpaceCollection: CollectionDefinitionInput<
  typeof memorySpaceSchema
> = Object.freeze({
  name: "memory_space",
  schema: memorySpaceSchema,
  indexes: [
    ["scopeType", "scopeId"],
    ["kind", "ownerNodeId"],
    "threadId",
    ["threadId", "access", "defaultWrite"],
  ],
  relations: {
    thread: relation.belongsTo(
      "thread",
      "threadId",
      MEMORY_EDGE.usesSpace,
    ),
    records: relation.hasMany(
      "memory_record",
      "memorySpaceId",
      MEMORY_EDGE.hasRecord,
    ),
  },
});

const memorySpaceAccessSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    id: { type: "string" },
    namespace: { type: "string" },
    threadId: { type: "string" },
    memorySpaceId: { type: "string" },
    access: {
      type: "string",
      enum: ["read", "read_write"],
    },
    defaultWrite: { type: "boolean" },
    metadata: { type: ["object", "null"] },
    createdAt: { type: "string" },
    updatedAt: { type: "string" },
  },
  required: [
    "threadId",
    "memorySpaceId",
    "access",
    "defaultWrite",
  ],
} as const;

/** Many-to-many thread access to a durable memory space. */
export const memorySpaceAccessCollection: CollectionDefinitionInput<
  typeof memorySpaceAccessSchema
> = Object.freeze({
  name: "memory_space_access",
  schema: memorySpaceAccessSchema,
  indexes: [
    ["threadId", "memorySpaceId"],
    ["threadId", "access", "defaultWrite"],
    "memorySpaceId",
  ],
  relations: {
    thread: relation.belongsTo(
      "thread",
      "threadId",
      "has_memory_space_access",
    ),
    memorySpace: relation.belongsTo(
      "memory_space",
      "memorySpaceId",
      "grants_memory_space_access",
    ),
  },
});

const longTermMemorySchema = {
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

export const longTermMemoryCollection: CollectionDefinitionInput<
  typeof longTermMemorySchema
> = Object.freeze({
  name: "long_term_memory",
  schema: longTermMemorySchema,
  indexes: [
    "threadId",
    "memorySpaceId",
    "defaultWriteMemorySpaceId",
    ["threadId", "agentId", "status", "sequence"],
    ["memorySpaceId", "status", "sequence"],
  ],
  relations: {
    thread: relation.belongsTo(
      "thread",
      "threadId",
      "has_long_term_memory",
    ),
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
        const patch = input && typeof input === "object" &&
            !Array.isArray(input)
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

const memoryRecordSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    id: { type: "string" },
    namespace: { type: "string" },
    memorySpaceId: { type: "string" },
    consolidationId: { type: "string" },
    createdByAgentId: { type: "string" },
    originThreadId: { type: "string" },
    form: {
      type: "string",
      enum: [
        "entity",
        "assertion",
        "occurrence",
        "intent",
        "inquiry",
        "procedure",
      ],
    },
    status: {
      type: "string",
      enum: [
        "active",
        "merged",
        "archived",
        "current",
        "superseded",
        "retracted",
        "disputed",
        "scheduled",
        "happened",
        "cancelled",
        "proposed",
        "completed",
        "open",
        "answered",
        "obsolete",
        "deprecated",
      ],
    },
    kind: { type: "string" },
    summary: { type: "string" },
    content: { type: "array" },
    temporal: { type: "object" },
    epistemic: { type: ["object", "null"] },
    provenance: { type: "object" },
    data: { type: "object" },
    embedding: { type: ["array", "null"] },
    metadata: { type: ["object", "null"] },
    createdAt: { type: "string" },
    updatedAt: { type: "string" },
  },
  required: [
    "memorySpaceId",
    "consolidationId",
    "createdByAgentId",
    "originThreadId",
    "form",
    "status",
    "kind",
    "summary",
    "temporal",
    "provenance",
    "data",
  ],
} as const;

export const memoryRecordCollection: CollectionDefinitionInput<
  typeof memoryRecordSchema
> = Object.freeze({
  name: "memory_record",
  schema: memoryRecordSchema,
  indexes: [
    "memorySpaceId",
    "consolidationId",
    "createdByAgentId",
    "originThreadId",
    ["memorySpaceId", "createdByAgentId"],
    ["form", "kind"],
    "status",
    "kind",
  ],
  relations: {
    memorySpace: relation.belongsTo(
      "memory_space",
      "memorySpaceId",
      MEMORY_EDGE.hasRecord,
    ),
    checkpoint: relation.belongsTo(
      "long_term_memory",
      "consolidationId",
      MEMORY_EDGE.includesRecord,
    ),
  },
  search: { enabled: true, fields: ["summary"] },
  content: { fields: ["content"] },
});
