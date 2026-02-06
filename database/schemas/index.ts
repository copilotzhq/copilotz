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

const UUID_SCHEMA: JsonSchema = {
  type: "string",
};

const READONLY_UUID_SCHEMA: JsonSchema = {
  ...UUID_SCHEMA,
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
          items: {
            type: "object",
            additionalProperties: true,
            properties: {
              id: { type: ["string", "null"] },
              name: { type: "string" },
              args: { type: "object", additionalProperties: true },
            },
            required: ["name", "args"],
          },
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
    metadata: {
      anyOf: [
        { type: "null" },
        {
          type: "object",
          additionalProperties: true,
          properties: {
            toolCalls: {
              type: ["array", "null"],
              items: {
                type: "object",
                additionalProperties: true,
                properties: {
                  name: { type: "string" },
                  args: { type: "string" },
                  output: {},
                  id: { type: ["string", "null"] },
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
                },
                required: ["name", "args"],
              },
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
 * Contains the message content, sender information, thread context, and optional tool calls.
 */
export type MessagePayload = FromSchema<typeof MessagePayloadSchema>;

const NewMessageEventPayloadSchema = MessagePayloadSchema;

export type NewMessageEventPayload = MessagePayload;

// create ulid
export function generateId(): string {
  return ulid();
}

const schemaDefinition = {
  agents: {
    schema: {
      type: "object",
      additionalProperties: false,
      $defs: {
        ProviderName: {
          type: "string",
          enum: [
            "openai",
            "anthropic",
            "gemini",
            "groq",
            "deepseek",
            "ollama",
            "xai",
          ],
        },
        ProviderConfig: {
          type: "object",
          additionalProperties: true,
          properties: {
            provider: { $ref: "#/$defs/ProviderName" },
            apiKey: { type: "string" },
            model: { type: "string" },
            temperature: { type: "number" },
            maxTokens: { type: "number" },
            maxCompletionTokens: { type: "number" },
            maxLength: { type: "number" },
            responseType: { type: "string", enum: ["text", "json"] },
            stream: { type: "boolean" },
            topP: { type: "number" },
            topK: { type: "number" },
            presencePenalty: { type: "number" },
            frequencyPenalty: { type: "number" },
            stop: {
              anyOf: [
                { type: "string" },
                { type: "array", items: { type: "string" } },
              ],
            },
            stopSequences: {
              type: "array",
              items: { type: "string" },
            },
            seed: { type: "number" },
            baseUrl: { type: "string" },
            candidateCount: { type: "number" }, // Gemini
            responseMimeType: { type: "string" }, // Gemini JSON format
            repeatPenalty: { type: "number" }, // Ollama
            numCtx: { type: "number" }, // Ollama context window
            metadata: { type: "object" }, // Anthropic
            reasoningEffort: {
              type: "string",
              enum: ["minimal", "low", "medium", "high"], // OpenAI reasoning models
            },
            user: { type: "string" }, // OpenAI user identifier
            verbosity: {
              type: "string",
              enum: ["none", "low", "medium", "high"], // OpenAI reasoning
            },
          },
        },
      },
      properties: {
        id: READONLY_UUID_SCHEMA,
        name: { type: "string", minLength: 1 },
        externalId: { type: ["string", "null"], maxLength: 255 },
        role: { type: "string" },
        personality: { type: ["string", "null"] },
        instructions: { type: ["string", "null"] },
        description: { type: ["string", "null"] },
        allowedAgents: {
          type: ["array", "null"],
          items: { type: "string" },
        },
        allowedTools: {
          type: ["array", "null"],
          items: { type: "string" },
        },
        llmOptions: {
          anyOf: [
            { $ref: "#/$defs/ProviderConfig" },
            { type: "null" },
          ],
        },
        metadata: { type: ["object", "null"] },
        createdAt: { type: "string", format: "date-time" },
        updatedAt: { type: "string", format: "date-time" },
      },
      required: ["id", "name", "role"],
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
  apis: {
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        id: READONLY_UUID_SCHEMA,
        name: { type: "string", minLength: 1 },
        externalId: { type: ["string", "null"], maxLength: 255 },
        description: { type: ["string", "null"] },
        openApiSchema: {
          anyOf: [
            { type: "object" },
            { type: "string" },
            { type: "null" },
          ],
        },
        baseUrl: { type: ["string", "null"] },
        headers: {
          type: ["object", "null"],
          additionalProperties: { type: "string" },
        },
        auth: {
          anyOf: [
            {
              type: "object",
              additionalProperties: false,
              properties: {
                type: { const: "apiKey" },
                in: { type: "string", enum: ["header", "query"] },
                name: { type: "string" },
                key: { type: "string" },
              },
              required: ["type", "in", "name", "key"],
            },
            {
              type: "object",
              additionalProperties: false,
              properties: {
                type: { const: "bearer" },
                scheme: { type: "string" },
                token: { type: "string" },
              },
              required: ["type", "token"],
            },
            {
              type: "object",
              additionalProperties: false,
              properties: {
                type: { const: "basic" },
                username: { type: "string" },
                password: { type: "string" },
              },
              required: ["type", "username", "password"],
            },
            {
              type: "object",
              additionalProperties: false,
              properties: {
                type: { const: "custom" },
                headers: {
                  type: ["object", "null"],
                  additionalProperties: { type: "string" },
                },
                queryParams: {
                  type: ["object", "null"],
                  additionalProperties: {
                    type: ["string", "number", "boolean"],
                  },
                },
              },
              required: ["type"],
            },
            {
              type: "object",
              additionalProperties: false,
              properties: {
                type: { const: "dynamic" },
                authEndpoint: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    url: { type: "string" },
                    method: { type: "string" },
                    headers: {
                      type: ["object", "null"],
                      additionalProperties: { type: "string" },
                    },
                    body: JSON_ANY_SCHEMA,
                    credentials: JSON_ANY_SCHEMA,
                  },
                  required: ["url"],
                },
                tokenExtraction: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    path: { type: "string" },
                    type: { type: "string", enum: ["bearer", "apiKey"] },
                    prefix: { type: ["string", "null"] },
                    headerName: { type: ["string", "null"] },
                  },
                  required: ["path", "type"],
                },
                cache: {
                  type: ["object", "null"],
                  additionalProperties: false,
                  properties: {
                    enabled: { type: "boolean" },
                    duration: { type: "integer" },
                  },
                },
                refreshConfig: {
                  type: ["object", "null"],
                  additionalProperties: false,
                  properties: {
                    refreshEndpoint: { type: ["string", "null"] },
                    refreshBeforeExpiry: { type: ["integer", "null"] },
                    refreshPath: { type: ["string", "null"] },
                    expiryPath: { type: ["string", "null"] },
                  },
                },
              },
              required: ["type", "authEndpoint", "tokenExtraction"],
            },
            { type: "null" },
          ],
        },
        timeout: { type: ["integer", "null"] },
        metadata: {
          type: ["object", "null"],
          additionalProperties: true,
        },
        createdAt: { type: "string", format: "date-time" },
        updatedAt: { type: "string", format: "date-time" },
      },
      required: ["id", "name"],
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
  mcpServers: {
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        id: READONLY_UUID_SCHEMA,
        name: { type: "string", minLength: 1 },
        externalId: { type: ["string", "null"], maxLength: 255 },
        description: { type: ["string", "null"] },
        transport: { type: ["object", "null"] },
        capabilities: { type: ["object", "null"] },
        env: { type: ["object", "null"] },
        metadata: { type: ["object", "null"] },
        createdAt: { type: "string", format: "date-time" },
        updatedAt: { type: "string", format: "date-time" },
      },
      required: ["id", "name"],
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
  messages: {
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        id: READONLY_UUID_SCHEMA,
        threadId: { $ref: "#/$defs/threads/properties/id" },
        senderUserId: {
          anyOf: [
            UUID_SCHEMA,
            { type: "null" },
          ],
        },
        senderId: { type: "string" },
        senderType: {
          type: "string",
          enum: ["agent", "user", "system", "tool"],
        },
        // NEW: Multi-agent conversation routing fields
        targetId: {
          type: ["string", "null"],
          description:
            "Primary recipient of this message (participant ID or agent ID)",
        },
        targetQueue: {
          type: ["array", "null"],
          items: { type: "string" },
          description:
            "Remaining targets in queue for multi-@mention scenarios",
        },
        thread: {
          readOnly: true,
          anyOf: [
            { $ref: "#/$defs/threads" },
            { type: "null" },
          ],
        },
        externalId: { type: ["string", "null"], maxLength: 255 },
        content: { type: ["string", "null"] },
        toolCallId: { type: ["string", "null"], maxLength: 255 },
        toolCalls: { type: ["array", "null"], items: JSON_ANY_SCHEMA },
        metadata: { type: ["object", "null"] },
        createdAt: { type: "string", format: "date-time" },
        updatedAt: { type: "string", format: "date-time" },
      },
      required: [
        "id",
        "threadId",
        "senderId",
        "senderType",
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
            agentName: { type: "string" },
            token: { type: "string" },
            isComplete: { type: "boolean" },
          },
          required: ["threadId", "agentName", "token", "isComplete"],
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
            agentName: { type: "string" },
            senderId: { type: "string" },
            senderType: { const: "agent" },
            call: {
              type: "object",
              additionalProperties: false,
              properties: {
                id: { type: ["string", "null"] },
                function: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    name: { type: "string" },
                    arguments: { type: "string" },
                  },
                  required: ["name", "arguments"],
                },
              },
              required: ["function"],
            },
            // Batch tracking for multiple tool calls from a single LLM response
            batchId: { type: ["string", "null"] },
            batchSize: { type: ["number", "null"] },
            batchIndex: { type: ["number", "null"] },
          },
          required: ["agentName", "senderId", "senderType", "call"],
        },
        NewMessageEventPayload: NewMessageEventPayloadSchema,
        LlmCallEventPayload: {
          type: "object",
          additionalProperties: false,
          properties: {
            agentName: { type: "string" },
            agentId: { type: "string" },
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
          required: ["agentName", "agentId", "messages", "tools", "config"],
        },
      },
      properties: {
        id: READONLY_UUID_SCHEMA,
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
            UUID_SCHEMA,
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
  tasks: {
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        id: READONLY_UUID_SCHEMA,
        name: { type: "string", minLength: 1 },
        externalId: { type: ["string", "null"], maxLength: 255 },
        goal: { type: "string" },
        successCriteria: { type: ["string", "null"] },
        status: { type: "string", default: "pending" },
        notes: { type: ["string", "null"] },
        metadata: { type: ["object", "null"] },
        createdAt: { type: "string", format: "date-time" },
        updatedAt: { type: "string", format: "date-time" },
      },
      required: ["id", "name", "goal", "status"],
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
        id: READONLY_UUID_SCHEMA,
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
            UUID_SCHEMA,
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
  tools: {
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        id: READONLY_UUID_SCHEMA,
        key: { type: "string", minLength: 1 },
        name: { type: "string", minLength: 1 },
        externalId: { type: ["string", "null"], maxLength: 255 },
        description: { type: "string" },
        inputSchema: { type: ["object", "null"] },
        outputSchema: { type: ["object", "null"] },
        metadata: { type: ["object", "null"] },
        createdAt: { type: "string", format: "date-time" },
        updatedAt: { type: "string", format: "date-time" },
      },
      required: ["id", "key", "name", "description"],
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
  users: {
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        id: READONLY_UUID_SCHEMA,
        name: { type: ["string", "null"], maxLength: 255 },
        email: { type: ["string", "null"], maxLength: 255 },
        externalId: { type: ["string", "null"], maxLength: 255 },
        metadata: { type: ["object", "null"] },
        createdAt: { type: "string", format: "date-time" },
        updatedAt: { type: "string", format: "date-time" },
      },
      required: ["id"],
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
  // RAG (Retrieval-Augmented Generation) schemas
  documents: {
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        id: READONLY_UUID_SCHEMA,
        namespace: {
          type: "string",
          minLength: 1,
          default: "default",
        },
        externalId: { type: ["string", "null"], maxLength: 255 },
        sourceType: {
          type: "string",
          enum: ["url", "file", "text", "asset"],
        },
        sourceUri: { type: ["string", "null"] },
        title: { type: ["string", "null"] },
        mimeType: { type: ["string", "null"], maxLength: 128 },
        contentHash: { type: "string", maxLength: 128 },
        assetId: { type: ["string", "null"], maxLength: 255 },
        status: {
          type: "string",
          enum: ["pending", "processing", "indexed", "failed"],
          default: "pending",
        },
        chunkCount: { type: ["integer", "null"] },
        errorMessage: { type: ["string", "null"] },
        metadata: { type: ["object", "null"] },
        createdAt: { type: "string", format: "date-time" },
        updatedAt: { type: "string", format: "date-time" },
      },
      required: ["id", "namespace", "sourceType", "contentHash", "status"],
    },
    keys: [{ property: "id" }],
    timestamps: {
      createdAt: "createdAt",
      updatedAt: "updatedAt",
    },
    defaults: {
      id: generateId,
      namespace: () => "default",
      status: () => "pending",
    },
  },
  documentChunks: {
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        id: READONLY_UUID_SCHEMA,
        documentId: UUID_SCHEMA,
        namespace: {
          type: "string",
          minLength: 1,
        },
        chunkIndex: { type: "integer" },
        content: { type: "string" },
        tokenCount: { type: ["integer", "null"] },
        // Embedding stored as JSON array of floats
        // PostgreSQL migration will use vector type
        embedding: {
          type: ["array", "null"],
          items: { type: "number" },
        },
        startPosition: { type: ["integer", "null"] },
        endPosition: { type: ["integer", "null"] },
        metadata: { type: ["object", "null"] },
        createdAt: { type: "string", format: "date-time" },
        updatedAt: { type: "string", format: "date-time" },
      },
      required: ["id", "documentId", "namespace", "chunkIndex", "content"],
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
  // ============================================
  // KNOWLEDGE GRAPH SCHEMAS
  // ============================================
  // Unified knowledge graph: nodes can be chunks, entities, concepts, decisions, etc.
  // This generalizes RAG into a full graph-based knowledge system.
  nodes: {
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        id: READONLY_UUID_SCHEMA,
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
        id: READONLY_UUID_SCHEMA,
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

const agents = schemaInternal.agents;
const apis = schemaInternal.apis;
const mcpServers = schemaInternal.mcpServers;
const messages = schemaInternal.messages;
const events = schemaInternal.events;
const queue = events;
const tasks = schemaInternal.tasks;
const threads = schemaInternal.threads;
const tools = schemaInternal.tools;
const users = schemaInternal.users;
const documents = schemaInternal.documents;
const documentChunks = schemaInternal.documentChunks;
const nodes = schemaInternal.nodes;
const edges = schemaInternal.edges;

/** AI Agent entity with configuration for LLM interactions and capabilities. */
export type Agent = typeof agents.$inferSelect;
/** Input type for creating a new Agent. */
export type NewAgent = typeof agents.$inferInsert;

/** API configuration for connecting to external REST APIs via OpenAPI. */
export type API = typeof apis.$inferSelect;
/** Input type for creating a new API configuration. */
export type NewAPI = typeof apis.$inferInsert;

/** MCP (Model Context Protocol) server configuration. */
export type MCPServer = typeof mcpServers.$inferSelect;
/** Input type for creating a new MCP server configuration. */
export type NewMCPServer = typeof mcpServers.$inferInsert;

/** Individual message within a conversation thread. */
export type Message = typeof messages.$inferSelect;
/** Input type for creating a new Message. */
export type NewMessage = typeof messages.$inferInsert;

/** Queue item in the event processing system. */
export type Queue = typeof queue.$inferSelect;
/** Input type for creating a new Queue item. */
export type NewQueue = Record<string, unknown>;

/** Task entity for goal-oriented agent workflows. */
export type Task = typeof tasks.$inferSelect;
/** Input type for creating a new Task. */
export type NewTask = typeof tasks.$inferInsert;

/** Conversation thread containing messages between users and agents. */
export type Thread = typeof threads.$inferSelect;
/** Input type for creating a new Thread. */
export type NewThread = typeof threads.$inferInsert;

/** Tool definition with input/output schemas for agent capabilities. */
export type Tool = typeof tools.$inferSelect;
/** Input type for creating a new Tool. */
export type NewTool = typeof tools.$inferInsert;

/** User entity representing a conversation participant. */
export type User = typeof users.$inferSelect;
/** Input type for creating a new User. */
export type NewUser = typeof users.$inferInsert;

/** Document stored in the RAG knowledge base. */
export type Document = typeof documents.$inferSelect;
/** Input type for creating a new Document. */
export type NewDocument = typeof documents.$inferInsert;

/** Chunk of a document with embedding vector for similarity search. */
export type DocumentChunk = typeof documentChunks.$inferSelect;
/** Input type for creating a new DocumentChunk. */
export type NewDocumentChunk = typeof documentChunks.$inferInsert;

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
/** Payload structure for streaming token events during LLM response generation. */
export type TokenEventPayload = FromSchema<
  typeof schemaDefinition.events.schema.$defs.TokenEventPayload
>;

export type EventPayloadMapBase = {
  NEW_MESSAGE: MessagePayload;
  TOOL_CALL: ToolCallEventPayload;
  LLM_CALL: LlmCallEventPayload;
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
