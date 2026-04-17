import { defineSchema, type JsonSchema } from "omnipg";
import type { FromSchema } from "json-schema-to-ts";
import { ulid } from "ulid";

// RAG Ingest payload (used by rag_ingest processor)
export interface RagIngestPayload {
  source: string;
  title?: string;
  namespace?: string;
  metadata?: Record<string, unknown>;
  forceReindex?: boolean;
}

// Entity Extract payload (used by entity_extract processor)
export interface EntityExtractPayload {
  /** The source node ID (message or chunk) to extract entities from */
  sourceNodeId: string;
  /** The content to extract entities from */
  content: string;
  /** The namespace scope for extracted entities */
  namespace: string;
  /** Source type for provenance tracking */
  sourceType: "message" | "chunk";
  /** Optional context about the source */
  sourceContext?: {
    threadId?: string;
    agentId?: string;
    documentId?: string;
  };
  /** Inline extraction config (avoids lookup, enables deduplication) */
  extractionConfig?: {
    /** LLM config for extraction calls */
    llmConfig?: {
      provider: string;
      model?: string;
      apiKey?: string;
      temperature?: number;
      maxTokens?: number;
    };
    /** Similarity threshold for dedup candidate matching */
    similarityThreshold?: number;
    /** Threshold above which to auto-merge without LLM confirm */
    autoMergeThreshold?: number;
    /** Entity types to extract */
    entityTypes?: string[];
  };
}

const ULID_SCHEMA: JsonSchema = {
  type: "string",
};

const READONLY_ULID_SCHEMA: JsonSchema = {
  ...ULID_SCHEMA,
  readOnly: true,
};

const JSON_ANY_SCHEMA: JsonSchema = {
  anyOf: [
    { type: "object" },
    { type: "array" },
    { type: "string" },
    { type: "number" },
    { type: "boolean" },
    { type: "null" },
  ],
};

// Standalone JSON Schemas for queue payloads (internal - not exported)
const ToolMessageMetadataSchema = {
  type: "object",
  additionalProperties: true,
  properties: {
    toolName: { type: "string" },
    arguments: { type: "string" },
    // Allow any JSON for output/error
    output: {
      type: "object",
      additionalProperties: true,
    },
    error: {
      type: "object",
      additionalProperties: true,
    },
  },
} as const;

export const ToolInvocationSchema = {
  type: "object",
  additionalProperties: true,
  properties: {
    id: { type: ["string", "null"] },
    tool: {
      type: "object",
      properties: {
        id: { type: "string" },
        name: { type: ["string", "null"] },
      },
      required: ["id"],
    },
    args: { type: ["object", "string", "null"] },
    output: {},
    status: {
      type: ["string", "null"],
      enum: [
        "pending",
        "processing",
        "completed",
        "failed",
        "expired",
        "overwritten",
      ],
    },
    batchId: { type: ["string", "null"] },
    batchSize: { type: ["number", "null"] },
    batchIndex: { type: ["number", "null"] },
  },
  required: ["id", "tool", "args"],
} as const;

const MessagePayloadSchema = {
  type: "object",
  additionalProperties: true,
  properties: {
    content: {
      anyOf: [
        { type: "string" },
        {
          type: "array",
          items: {
            anyOf: [
              {
                type: "object",
                additionalProperties: false,
                properties: {
                  type: { const: "text" },
                  text: { type: "string" },
                },
                required: ["type", "text"],
              },
              {
                type: "object",
                additionalProperties: false,
                properties: {
                  type: { const: "image" },
                  url: { type: "string" },
                  dataBase64: { type: "string" },
                  mimeType: { type: "string" },
                  alt: { type: "string" },
                },
                required: ["type"],
              },
              {
                type: "object",
                additionalProperties: false,
                properties: {
                  type: { const: "audio" },
                  url: { type: "string" },
                  dataBase64: { type: "string" },
                  mimeType: { type: "string" },
                  transcript: { type: "string" },
                },
                required: ["type"],
              },
              {
                type: "object",
                additionalProperties: false,
                properties: {
                  type: { const: "file" },
                  url: { type: "string" },
                  dataBase64: { type: "string" },
                  mimeType: { type: "string" },
                  name: { type: "string" },
                },
                required: ["type"],
              },
              {
                type: "object",
                additionalProperties: false,
                properties: {
                  type: { const: "json" },
                  value: {},
                },
                required: ["type", "value"],
              },
            ],
          },
        },
      ],
    },
    toolCalls: {
      anyOf: [
        { type: "null" },
        {
          type: "array",
          items: ToolInvocationSchema,
        },
      ],
    },
    target: {
      anyOf: [
        { type: "null" },
        { type: "string" },
      ],
    },
    targetQueue: {
      anyOf: [
        { type: "null" },
        {
          type: "array",
          items: { type: "string" },
        },
      ],
    },
    sender: {
      type: "object",
      additionalProperties: false,
      properties: {
        id: { type: ["string", "null"] },
        externalId: { type: ["string", "null"] },
        type: { type: "string", enum: ["agent", "user", "tool", "system"] },
        name: { type: ["string", "null"] },
        identifierType: {
          type: ["string", "null"],
          enum: ["id", "name", "email"],
        },
        metadata: { type: ["object", "null"] },
      },
      required: ["type"],
    },
    thread: {
      anyOf: [
        { type: "null" },
        {
          type: "object",
          additionalProperties: false,
          properties: {
            id: { type: ["string", "null"] },
            name: { type: ["string", "null"] },
            description: { type: ["string", "null"] },
            externalId: { type: ["string", "null"] },
            participants: {
              type: ["array", "null"],
              items: { type: "string" },
            },
            metadata: { type: ["object", "null"] },
          },
        },
      ],
    },
    reasoning: {
      anyOf: [
        { type: "null" },
        { type: "string" },
      ],
    },
    metadata: {
      anyOf: [
        { type: "null" },
        {
          type: "object",
          additionalProperties: true,
          properties: {
            toolCalls: {
              type: ["array", "null"],
              items: ToolInvocationSchema,
            },
          },
        },
      ],
    },
  },
  required: ["content", "sender"],
} as const;

/**
 * Payload structure for incoming messages to Copilotz.
 * Contains the message content, sender information, thread context, routing, and optional tool calls.
 */
export type MessagePayload = FromSchema<typeof MessagePayloadSchema>;

const NewMessageEventPayloadSchema = MessagePayloadSchema;

export type NewMessageEventPayload = MessagePayload;

// create ulid
export function generateId(): string {
  return ulid();
}

const schemaDefinition = {
  events: {
    schema: {
      type: "object",
      additionalProperties: false,
      $defs: {
        TokenEventPayload: {
          type: "object",
          additionalProperties: false,
          properties: {
            threadId: { type: "string" },
            agent: {
              type: "object",
              properties: {
                id: { type: ["string", "null"] },
                name: { type: "string" },
              },
              required: ["name"],
            },
            token: { type: "string" },
            isComplete: { type: "boolean" },
            isReasoning: { type: "boolean" },
          },
          required: ["threadId", "agent", "token", "isComplete"],
        },
        ChatContentPart: {
          anyOf: [
            {
              type: "object",
              additionalProperties: false,
              properties: {
                type: { const: "text" },
                text: { type: "string" },
              },
              required: ["type", "text"],
            },
            {
              type: "object",
              additionalProperties: true,
              properties: {
                type: { type: "string" },
              },
              required: ["type"],
            },
          ],
        },
        ChatMessage: {
          type: "object",
          additionalProperties: true,
          properties: {
            role: {
              type: "string",
              enum: ["system", "user", "assistant", "tool", "tool_result"],
            },
            content: {
              anyOf: [
                { type: "string" },
                {
                  type: "array",
                  items: { $ref: "#/$defs/ChatContentPart" },
                },
              ],
            },
            tool_call_id: { type: ["string", "null"] },
            toolCalls: {
              type: ["array", "null"],
              items: {
                type: "object",
                additionalProperties: true,
              },
            },
          },
          required: ["role", "content"],
        },
        ToolDefinition: {
          type: "object",
          additionalProperties: true,
          properties: {
            type: { const: "function" },
            function: {
              type: "object",
              additionalProperties: true,
              properties: {
                name: { type: "string" },
                description: { type: ["string", "null"] },
                parameters: { type: ["object", "null"] },
              },
              required: ["name"],
            },
          },
          required: ["type", "function"],
        },
        ToolMessageMetadata: ToolMessageMetadataSchema,
        ToolCallEventPayload: {
          type: "object",
          additionalProperties: false,
          properties: {
            agent: {
              type: "object",
              properties: {
                id: { type: ["string", "null"] },
                name: { type: "string" },
              },
              required: ["name"],
            },
            senderId: { type: "string" },
            senderType: { const: "agent" },
            toolCall: ToolInvocationSchema,
          },
          required: ["agent", "senderId", "senderType", "toolCall"],
        },
        ToolResultEventPayload: {
          type: "object",
          additionalProperties: false,
          properties: {
            agent: {
              type: "object",
              properties: {
                id: { type: ["string", "null"] },
                name: { type: "string" },
              },
              required: ["name"],
            },
            toolCallId: { type: "string" },
            tool: {
              type: "object",
              properties: {
                id: { type: "string" },
                name: { type: ["string", "null"] },
              },
              required: ["id"],
            },
            args: JSON_ANY_SCHEMA,
            status: {
              type: "string",
              enum: ["completed", "failed", "cancelled"],
            },
            output: JSON_ANY_SCHEMA,
            projectedOutput: JSON_ANY_SCHEMA,
            error: JSON_ANY_SCHEMA,
            content: { type: ["string", "null"] },
            historyVisibility: { type: ["string", "null"] },
            batchId: { type: ["string", "null"] },
            batchSize: { type: ["number", "null"] },
            batchIndex: { type: ["number", "null"] },
            startedAt: { type: ["string", "null"], format: "date-time" },
            finishedAt: { type: "string", format: "date-time" },
            durationMs: { type: ["number", "null"] },
            resultMessageId: { type: ["string", "null"] },
          },
          required: ["agent", "toolCallId", "tool", "status", "finishedAt"],
        },
        NewMessageEventPayload: NewMessageEventPayloadSchema,
        LlmCallEventPayload: {
          type: "object",
          additionalProperties: false,
          properties: {
            agent: {
              type: "object",
              properties: {
                id: { type: ["string", "null"] },
                name: { type: "string" },
              },
              required: ["name"],
            },
            messages: {
              type: "array",
              items: { $ref: "#/$defs/ChatMessage" },
              minItems: 1,
            },
            tools: {
              type: "array",
              items: { $ref: "#/$defs/ToolDefinition" },
            },
            config: { type: "object" },
          },
          required: ["agent", "messages", "tools", "config"],
        },
        LlmResultEventPayload: {
          type: "object",
          additionalProperties: false,
          properties: {
            llmCallId: { type: "string" },
            agent: {
              type: "object",
              properties: {
                id: { type: ["string", "null"] },
                name: { type: "string" },
              },
              required: ["name"],
            },
            provider: { type: ["string", "null"] },
            model: { type: ["string", "null"] },
            status: {
              type: "string",
              enum: ["completed", "failed", "cancelled"],
            },
            finishReason: { type: ["string", "null"] },
            answer: { type: ["string", "null"] },
            reasoning: { type: ["string", "null"] },
            toolCalls: {
              type: ["array", "null"],
              items: ToolInvocationSchema,
            },
            extractedTags: {
              type: ["object", "null"],
              additionalProperties: {
                type: "array",
                items: { type: "string" },
              },
            },
            usage: JSON_ANY_SCHEMA,
            cost: JSON_ANY_SCHEMA,
            usageNodeId: { type: ["string", "null"] },
            resultMessageId: { type: ["string", "null"] },
            startedAt: { type: ["string", "null"], format: "date-time" },
            finishedAt: { type: "string", format: "date-time" },
            durationMs: { type: ["number", "null"] },
          },
          required: ["llmCallId", "agent", "status", "finishedAt"],
        },
      },
      properties: {
        id: READONLY_ULID_SCHEMA,
        threadId: { $ref: "#/$defs/threads/properties/id" },
        eventType: {
          type: "string",
        },
        payload: { type: "object" },
        thread: {
          readOnly: true,
          anyOf: [
            { $ref: "#/$defs/threads" },
            { type: "null" },
          ],
        },
        parentEventId: {
          anyOf: [
            ULID_SCHEMA,
            { type: "null" },
          ],
        },
        parentEvent: {
          readOnly: true,
          anyOf: [
            { type: "object" },
            { type: "null" },
          ],
        },
        traceId: { type: ["string", "null"], maxLength: 255 },
        priority: { type: ["integer", "null"] },
        ttlMs: { type: ["integer", "null"] },
        expiresAt: { type: ["string", "null"], format: "date-time" },
        namespace: { type: ["string", "null"], maxLength: 255 },
        status: {
          type: "string",
          enum: [
            "pending",
            "processing",
            "completed",
            "failed",
            "expired",
            "overwritten",
          ],
          default: "pending",
        },
        metadata: { type: ["object", "null"] },
        createdAt: { type: "string", format: "date-time" },
        updatedAt: { type: "string", format: "date-time" },
      },
      required: [
        "id",
        "threadId",
        "eventType",
        "payload",
        "status",
      ],
      allOf: [
        {
          if: {
            properties: { eventType: { const: "NEW_MESSAGE" } },
          },
          then: {
            properties: {
              payload: { $ref: "#/$defs/NewMessageEventPayload" },
            },
          },
        },
        {
          if: {
            properties: { eventType: { const: "TOOL_CALL" } },
          },
          then: {
            properties: {
              payload: { $ref: "#/$defs/ToolCallEventPayload" },
            },
          },
        },
        {
          if: {
            properties: { eventType: { const: "LLM_CALL" } },
          },
          then: {
            properties: {
              payload: { $ref: "#/$defs/LlmCallEventPayload" },
            },
          },
        },
        {
          if: {
            properties: { eventType: { const: "TOOL_RESULT" } },
          },
          then: {
            properties: {
              payload: { $ref: "#/$defs/ToolResultEventPayload" },
            },
          },
        },
        {
          if: {
            properties: { eventType: { const: "LLM_RESULT" } },
          },
          then: {
            properties: {
              payload: { $ref: "#/$defs/LlmResultEventPayload" },
            },
          },
        },
        {
          if: {
            properties: { eventType: { const: "TOKEN" } },
          },
          then: {
            properties: {
              payload: { $ref: "#/$defs/TokenEventPayload" },
            },
          },
        },
      ],
    },
    keys: [{ property: "id" }],
    timestamps: {
      createdAt: "createdAt",
      updatedAt: "updatedAt",
    },
    defaults: {
      id: generateId,
    },
  },
  threads: {
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        id: READONLY_ULID_SCHEMA,
        name: { type: "string", minLength: 1 },
        externalId: { type: ["string", "null"], maxLength: 255 },
        description: { type: ["string", "null"] },
        participants: {
          type: ["array", "null"],
          items: { type: "string" },
        },
        initialMessage: { type: ["string", "null"] },
        mode: { type: "string", default: "immediate" },
        status: { type: "string", default: "active" },
        summary: { type: ["string", "null"] },
        workerLockedBy: { type: ["string", "null"], maxLength: 255 },
        workerLeaseExpiresAt: { type: ["string", "null"], format: "date-time" },
        parentThreadId: {
          anyOf: [
            ULID_SCHEMA,
            { type: "null" },
          ],
        },
        parentThread: {
          readOnly: true,
          anyOf: [
            { type: "object" },
            { type: "null" },
          ],
        },
        metadata: { type: ["object", "null"] },
        createdAt: { type: "string", format: "date-time" },
        updatedAt: { type: "string", format: "date-time" },
      },
      required: ["id", "name", "mode", "status"],
    },
    keys: [{ property: "id" }],
    timestamps: {
      createdAt: "createdAt",
      updatedAt: "updatedAt",
    },
    defaults: {
      id: generateId,
    },
  },
  nodes: {
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        id: READONLY_ULID_SCHEMA,
        namespace: {
          type: "string",
          minLength: 1,
          description: "Scoping: thread_id, agent_id, repo_id, or 'global'",
        },
        type: {
          type: "string",
          minLength: 1,
          description:
            "Node type: 'chunk', 'entity', 'concept', 'decision', 'file', etc.",
        },
        name: {
          type: "string",
          minLength: 1,
          description: "Human-readable identifier for the node",
        },
        // Embedding stored as JSON array of floats
        // PostgreSQL migration uses vector type
        embedding: {
          type: ["array", "null"],
          items: { type: "number" },
          description: "Vector embedding for semantic search",
        },
        content: {
          type: ["string", "null"],
          description: "Full text content (primarily for chunk nodes)",
        },
        data: {
          type: ["object", "null"],
          description: "Flexible properties specific to node type",
        },
        sourceType: {
          type: ["string", "null"],
          description:
            "Origin type: 'document', 'message', 'file', 'extraction'",
        },
        sourceId: {
          type: ["string", "null"],
          description: "Reference to source entity ID",
        },
        createdAt: { type: "string", format: "date-time" },
        updatedAt: { type: "string", format: "date-time" },
      },
      required: ["id", "namespace", "type", "name"],
    },
    keys: [{ property: "id" }],
    timestamps: {
      createdAt: "createdAt",
      updatedAt: "updatedAt",
    },
    defaults: {
      id: generateId,
    },
  },
  edges: {
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        id: READONLY_ULID_SCHEMA,
        sourceNodeId: {
          type: "string",
          description: "ID of the source node",
        },
        targetNodeId: {
          type: "string",
          description: "ID of the target node",
        },
        type: {
          type: "string",
          minLength: 1,
          description:
            "Relationship type: 'mentions', 'contains', 'caused', 'imports', etc.",
        },
        data: {
          type: ["object", "null"],
          description: "Relationship properties",
        },
        weight: {
          type: ["number", "null"],
          default: 1.0,
          description: "Relationship strength/confidence",
        },
        createdAt: { type: "string", format: "date-time" },
      },
      required: ["id", "sourceNodeId", "targetNodeId", "type"],
    },
    keys: [{ property: "id" }],
    // Edges are immutable, no updatedAt needed
    defaults: {
      id: generateId,
      weight: () => 1.0,
    },
  },
} as const;

type SchemaInternal = ReturnType<typeof defineSchema<typeof schemaDefinition>>;

const schemaInternal: SchemaInternal = defineSchema(schemaDefinition);

const events = schemaInternal.events;
const queue = events;
const threads = schemaInternal.threads;
const nodes = schemaInternal.nodes;
const edges = schemaInternal.edges;

/** Queue item in the event processing system. */
export type Queue = typeof queue.$inferSelect;
/** Input type for creating a new Queue item. */
export type NewQueue = Record<string, unknown>;

/** Conversation thread containing messages between users and agents. */
export type Thread = typeof threads.$inferSelect;
/** Input type for creating a new Thread. */
export type NewThread = typeof threads.$inferInsert;

/**
 * Knowledge graph node: can represent chunks, entities, concepts, decisions, etc.
 * This is the unified primitive for all knowledge in Copilotz.
 */
export type KnowledgeNode = typeof nodes.$inferSelect;
/** Input type for creating a new KnowledgeNode. */
export type NewKnowledgeNode = typeof nodes.$inferInsert;

/**
 * Knowledge graph edge: typed relationship between nodes.
 * Enables graph traversal for context retrieval.
 */
export type KnowledgeEdge = typeof edges.$inferSelect;
/** Input type for creating a new KnowledgeEdge. */
export type NewKnowledgeEdge = typeof edges.$inferInsert;

/** Database schema definitions for all Copilotz entities. */
export const schema: typeof schemaInternal = schemaInternal;

type QueueRow = typeof queue.$inferSelect;
type QueueStatus = QueueRow["status"];

/** Payload structure for tool call events, containing the tool invocation details. */
export type ToolCallEventPayload = FromSchema<
  typeof schemaDefinition.events.schema.$defs.ToolCallEventPayload
>;
/** Payload structure for LLM call events, containing messages and configuration. */
export type LlmCallEventPayload = FromSchema<
  typeof schemaDefinition.events.schema.$defs.LlmCallEventPayload
>;
/** Payload structure for tool result events, containing terminal tool execution state. */
export type ToolResultEventPayload = FromSchema<
  typeof schemaDefinition.events.schema.$defs.ToolResultEventPayload
>;
/** Payload structure for LLM result events, containing terminal LLM execution state. */
export type LlmResultEventPayload = FromSchema<
  typeof schemaDefinition.events.schema.$defs.LlmResultEventPayload
>;
/** Payload structure for streaming token events during LLM response generation. */
export type TokenEventPayload = FromSchema<
  typeof schemaDefinition.events.schema.$defs.TokenEventPayload
>;

export type EventPayloadMapBase = {
  NEW_MESSAGE: MessagePayload;
  TOOL_CALL: ToolCallEventPayload;
  LLM_CALL: LlmCallEventPayload;
  TOOL_RESULT: ToolResultEventPayload;
  LLM_RESULT: LlmResultEventPayload;
  TOKEN: TokenEventPayload;
};

type EventPayloadMap = EventPayloadMapBase;

/** Base event properties without type-specific payload. */
export type EventBase = Omit<QueueRow, "eventType" | "payload">;

/**
 * Event in the Copilotz event queue system.
 * A discriminated union of all possible event types with their typed payloads.
 */
export type Event = {
  [K in keyof EventPayloadMap]: EventBase & {
    type: K;
    payload: EventPayloadMap[K];
  };
}[keyof EventPayloadMap];

/** Specific event type for NEW_MESSAGE events with typed payload. */
export type NewMessageEvent = EventBase & {
  type: "NEW_MESSAGE";
  payload: MessagePayload;
};

/** Specific event type for TOOL_CALL events with typed payload. */
export type ToolCallEvent = EventBase & {
  type: "TOOL_CALL";
  payload: ToolCallEventPayload;
};

/** Specific event type for LLM_CALL events with typed payload. */
export type LlmCallEvent = EventBase & {
  type: "LLM_CALL";
  payload: LlmCallEventPayload;
};

/** Specific event type for TOOL_RESULT events with typed payload. */
export type ToolResultEvent = EventBase & {
  type: "TOOL_RESULT";
  payload: ToolResultEventPayload;
};

/** Specific event type for LLM_RESULT events with typed payload. */
export type LlmResultEvent = EventBase & {
  type: "LLM_RESULT";
  payload: LlmResultEventPayload;
};

/** Specific event type for TOKEN events with typed payload. */
export type TokenEvent = EventBase & {
  type: "TOKEN";
  payload: TokenEventPayload;
};

/**
 * Input type for creating a new Event in the queue.
 * Supports all built-in event types with their typed payloads.
 */
export type NewEvent = {
  [K in keyof EventPayloadMap]: {
    threadId: string;
    type: K;
    payload: EventPayloadMap[K];
    parentEventId?: string;
    traceId?: string;
    priority?: number;
    metadata?: Record<string, unknown> | null;
    ttlMs?: number;
    id?: string;
    status?: QueueStatus;
    namespace?: string;
    createdAt?: string | Date;
    updatedAt?: string | Date;
  };
}[keyof EventPayloadMap];

// Generic helpers to enable typed custom events without global augmentation
export type EventOfMap<TCustom extends Record<string, unknown>> = {
  [K in keyof (EventPayloadMapBase & TCustom)]: EventBase & {
    type: K;
    payload: (EventPayloadMapBase & TCustom)[K];
  };
}[keyof (EventPayloadMapBase & TCustom)];

export type NewEventOfMap<TCustom extends Record<string, unknown>> = {
  [K in keyof (EventPayloadMapBase & TCustom)]: {
    threadId: string;
    type: K;
    payload: (EventPayloadMapBase & TCustom)[K];
    parentEventId?: string;
    traceId?: string;
    priority?: number;
    metadata?: Record<string, unknown> | null;
    ttlMs?: number;
    id?: string;
    status?: QueueStatus;
    namespace?: string;
    createdAt?: string | Date;
    updatedAt?: string | Date;
  };
}[keyof (EventPayloadMapBase & TCustom)];

/**
 * Broadly-typed event shape to support custom events passed at runtime via config.processors.
 * Use this when creating events with custom types not in the built-in EventPayloadMap.
 */
export type NewUnknownEvent = {
  threadId: string;
  type: string;
  payload: Record<string, unknown>;
  parentEventId?: string;
  traceId?: string;
  priority?: number;
  metadata?: Record<string, unknown> | null;
  ttlMs?: number;
  id?: string;
  status?: QueueStatus;
  createdAt?: string | Date;
  updatedAt?: string | Date;
};
