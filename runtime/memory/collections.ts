import { defineCollection, relation } from "../domain/index.ts";
import type { CollectionDefinition } from "../domain/index.ts";

const MEMORY_EDGE = Object.freeze({
  usesSpace: "uses_memory_space",
  hasNode: "has_brain_node",
  includesNode: "includes_brain_node",
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

export const memorySpaceCollection: CollectionDefinition<
  typeof memorySpaceSchema
> = defineCollection({
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
    brainNodes: relation.hasMany(
      "brain_node",
      "memorySpaceId",
      MEMORY_EDGE.hasNode,
    ),
  },
});

const memorySpaceAccessSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    id: { type: "string" },
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
export const memorySpaceAccessCollection: CollectionDefinition<
  typeof memorySpaceAccessSchema
> = defineCollection({
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
      enum: ["pending", "ready", "failed"],
    },
    memorySpaceId: { type: ["string", "null"] },
    readMemorySpaceIds: { type: "array", items: { type: "string" } },
    writeMemorySpaceIds: { type: "array", items: { type: "string" } },
    defaultWriteMemorySpaceId: { type: ["string", "null"] },
    sequence: { type: "number" },
    agentId: { type: "string" },
    sourceStartMessageId: { type: "string" },
    sourceEndMessageId: { type: "string" },
    // v3 writes canonical ContentRef arrays. String remains accepted only so
    // isolated v1 upgrades and legacy readers can inspect old checkpoints.
    content: { type: ["array", "string", "null"] },
    embedding: { type: ["array", "null"] },
    contentHash: { type: ["string", "null"] },
    tokenEstimate: { type: ["number", "null"] },
    error: { type: ["object", "null"] },
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

export const longTermMemoryCollection: CollectionDefinition<
  typeof longTermMemorySchema
> = defineCollection({
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
    brainNodes: relation.hasMany(
      "brain_node",
      "checkpointId",
      MEMORY_EDGE.includesNode,
    ),
  },
  content: { fields: ["content"] },
});

const brainNodeSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    memorySpaceId: { type: "string" },
    checkpointId: { type: "string" },
    createdByAgentId: { type: "string" },
    originThreadId: { type: "string" },
    layer: {
      type: "string",
      enum: ["knowledge", "working"],
    },
    status: {
      type: "string",
      enum: ["active", "superseded", "archived"],
    },
    kind: {
      type: "string",
      enum: [
        "entity",
        "fact",
        "claim",
        "decision",
        "preference",
        "task",
        "event",
        "constraint",
        "challenge",
        "purpose",
        "desired_outcome",
        "success_criterion",
        "decision_criterion",
        "current_state",
        "active_approach",
        "risk",
        "open_question",
        "next_action",
      ],
    },
    name: { type: "string" },
    content: { type: "string" },
    confidence: { type: ["number", "null"] },
    sourceMessageIds: { type: "array", items: { type: "string" } },
    sourceField: { type: ["string", "null"] },
    embedding: { type: ["array", "null"] },
    supersedesNodeId: { type: ["string", "null"] },
    metadata: { type: ["object", "null"] },
  },
  required: [
    "memorySpaceId",
    "checkpointId",
    "createdByAgentId",
    "originThreadId",
    "layer",
    "status",
    "kind",
    "name",
    "content",
    "sourceMessageIds",
  ],
} as const;

export const brainNodeCollection: CollectionDefinition<
  typeof brainNodeSchema
> = defineCollection({
  name: "brain_node",
  schema: brainNodeSchema,
  indexes: [
    "memorySpaceId",
    "checkpointId",
    "createdByAgentId",
    "originThreadId",
    ["memorySpaceId", "createdByAgentId"],
    ["layer", "kind"],
    "status",
    "kind",
  ],
  relations: {
    memorySpace: relation.belongsTo(
      "memory_space",
      "memorySpaceId",
      MEMORY_EDGE.hasNode,
    ),
    checkpoint: relation.belongsTo(
      "long_term_memory",
      "checkpointId",
      MEMORY_EDGE.includesNode,
    ),
  },
  search: { enabled: true, fields: ["name", "content"] },
});
