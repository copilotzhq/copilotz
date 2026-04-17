/**
 * Type definitions and interfaces for the Copilotz framework.
 *
 * This module exports all the core types needed for working with Copilotz,
 * including entity types, configuration interfaces, and event handling types.
 *
 * @module
 */

import type {
  ChatMessage,
  LLMConfig,
  LLMRuntimeConfig,
  ToolDefinition,
  ToolInvocation,
} from "@/runtime/llm/types.ts";

import type {
  Event,
  KnowledgeNode,
  LlmCallEvent,
  LlmCallEventPayload,
  LlmResultEvent,
  LlmResultEventPayload,
  MessagePayload,
  NewEvent,
  NewMessageEvent,
  NewThread,
  NewUnknownEvent,
  Thread,
  TokenEvent,
  TokenEventPayload,
  ToolCallEvent,
  ToolCallEventPayload,
  ToolResultEvent,
  ToolResultEventPayload,
} from "@/database/schemas/index.ts";

export type {
  /** Event entity in the event queue system. */
  Event,
  /** Knowledge graph node. */
  KnowledgeNode,
  /** Specific LLM_CALL event with typed payload. */
  LlmCallEvent,
  /** Payload for LLM call events. */
  LlmCallEventPayload,
  /** Specific LLM_RESULT event with typed payload. */
  LlmResultEvent,
  /** Payload for LLM result events. */
  LlmResultEventPayload,
  /** Payload structure for incoming messages. */
  MessagePayload,
  /** Input type for creating a new Event. */
  NewEvent,
  /** Specific NEW_MESSAGE event with typed payload. */
  NewMessageEvent,
  /** Input type for creating a new Thread. */
  NewThread,
  /** Generic event type for custom event processors. */
  NewUnknownEvent,
  /** Thread entity representing a conversation. */
  Thread,
  /** Specific TOKEN event with typed payload. */
  TokenEvent,
  /** Payload for streaming token events. */
  TokenEventPayload,
  /** Specific TOOL_CALL event with typed payload. */
  ToolCallEvent,
  /** Payload for tool call events. */
  ToolCallEventPayload,
  /** Specific TOOL_RESULT event with typed payload. */
  ToolResultEvent,
  /** Payload for tool result events. */
  ToolResultEventPayload,
};

import type {
  CopilotzDb,
  DatabaseConfig,
  DbInstance,
} from "@/database/index.ts";

export type {
  /** Copilotz database instance with CRUD and custom operations. */
  CopilotzDb,
  /** Configuration options for database connection. */
  DatabaseConfig,
  /** Low-level database instance from Ominipg. */
  DbInstance,
};

import type {
  EventProcessor,
  ProcessorDeps,
} from "@/runtime/event-engine.ts";

export type {
  /** Interface for custom event processors. */
  EventProcessor,
  /** Dependencies injected into event processors. */
  ProcessorDeps,
  /** Context passed to tool execution. */
  ToolExecutionContext,
} from "@/runtime/event-engine.ts";

import type { AssetConfig, AssetStore } from "@/runtime/storage/assets.ts";
import type { AgentsFileInstructions } from "@/runtime/loaders/agents-file.ts";

/**
 * Payload passed to the agent LLM options resolver function.
 * Contains all context needed to dynamically configure LLM options per call.
 */
export interface AgentLlmOptionsResolverPayload {
  /** Details of the agent making the LLM call. */
  agent: {
    /** Optional ID of the agent making the LLM call. */
    id?: string;
    /** Name of the agent making the LLM call. */
    name: string;
  };
  /** Array of chat messages to send to the LLM. */
  messages: ChatMessage[];
  /** Array of tool definitions available for the call. */
  tools: ToolDefinition[];
  /** Current persisted LLM configuration (safe to store/stream). */
  config?: LLMConfig;
}

/**
 * Arguments passed to the agent LLM options resolver function.
 */
export interface AgentLlmOptionsResolverArgs {
  /** The payload containing LLM call context. */
  payload: AgentLlmOptionsResolverPayload;
  /** The source event that triggered this LLM call. */
  sourceEvent: Event;
  /** Processor dependencies including database access. */
  deps: ProcessorDeps;
}

/**
 * Function type for dynamically resolving LLM provider configuration.
 * Use this to customize LLM settings per-call based on context.
 *
 * @param args - The resolver arguments containing call context
 * @returns The provider configuration to use for the LLM call
 */
export type AgentLlmOptionsResolver = (
  args: AgentLlmOptionsResolverArgs,
) => LLMRuntimeConfig | Promise<LLMRuntimeConfig>;

export interface ResolveLLMRuntimeConfigArgs {
  provider?: string;
  model?: string;
  agent: {
    id?: string;
    name: string;
  };
  config?: LLMConfig;
  sourceEvent: Event;
  deps: ProcessorDeps;
}

export type ResolveLLMRuntimeConfig = (
  args: ResolveLLMRuntimeConfigArgs,
) => Partial<LLMRuntimeConfig> | Promise<Partial<LLMRuntimeConfig> | undefined> | undefined;

export type ToolHistoryVisibility =
  | "requester_only"
  | "public_result"
  | "public_full";

export interface ToolResultProjectorContext {
  toolKey: string;
  toolName: string;
  status: "completed" | "failed";
  error?: unknown;
}

export type ToolResultProjector = (
  args: unknown,
  output: unknown,
  context: ToolResultProjectorContext,
) => unknown | Promise<unknown>;

export interface ToolHistoryPolicyConfig {
  visibility?: ToolHistoryVisibility;
}

export interface ToolHistoryPolicy extends ToolHistoryPolicyConfig {
  projector?: ToolResultProjector;
}

type ToolExecuteFn = (
  // deno-lint-ignore no-explicit-any
  args: any,
  // deno-lint-ignore no-explicit-any
  context?: any,
) => Promise<unknown> | unknown;

/** Tool definition with optional runtime-only execution and history policy hooks. */
export interface Tool {
  id: string;
  key: string;
  name: string;
  externalId?: string | null;
  description: string;
  inputSchema?: Record<string, unknown> | null;
  outputSchema?: Record<string, unknown> | null;
  metadata?: Record<string, unknown> | null;
  createdAt?: string | Date;
  updatedAt?: string | Date;
  execute?: ToolExecuteFn;
  historyPolicy?: ToolHistoryPolicy;
}

/** Input type for creating a new Tool. */
export type NewTool = Partial<Tool> & Pick<Tool, "key" | "name" | "description">;

/** Auth configuration for API connections. */
export type APIAuth =
  | { type: "apiKey"; in: "header" | "query"; name: string; key: string }
  | { type: "bearer"; scheme?: string; token: string }
  | { type: "basic"; username: string; password: string }
  | {
    type: "custom";
    headers?: Record<string, string> | null;
    queryParams?: Record<string, string | number | boolean> | null;
  }
  | {
    type: "dynamic";
    authEndpoint: {
      url: string;
      method?: string;
      headers?: Record<string, string> | null;
      body?: unknown;
      credentials?: unknown;
    };
    tokenExtraction: {
      path: string;
      type: "bearer" | "apiKey";
      prefix?: string | null;
      headerName?: string | null;
    };
    cache?: { enabled: boolean; duration: number } | null;
    refreshConfig?: {
      refreshEndpoint?: string | null;
      refreshBeforeExpiry?: number | null;
      refreshPath?: string | null;
      expiryPath?: string | null;
    } | null;
  };

/** API configuration for connecting to external REST APIs via OpenAPI. */
export interface API {
  id: string;
  name: string;
  externalId?: string | null;
  description?: string | null;
  openApiSchema?: Record<string, unknown> | string | null;
  baseUrl?: string | null;
  headers?: Record<string, string> | null;
  auth?: APIAuth | null;
  timeout?: number | null;
  includeResponseHeaders?: boolean | null;
  metadata?: Record<string, unknown> | null;
  createdAt?: string | Date;
  updatedAt?: string | Date;
  historyPolicyDefaults?: ToolHistoryPolicyConfig;
  toolPolicies?: Record<string, ToolHistoryPolicy>;
}

/** Input type for creating a new API configuration. */
export type NewAPI = Partial<API> & Pick<API, "name">;

/** MCP (Model Context Protocol) server configuration. */
export interface MCPServer {
  id: string;
  name: string;
  externalId?: string | null;
  description?: string | null;
  transport?: Record<string, unknown> | null;
  capabilities?: Record<string, unknown> | null;
  env?: Record<string, unknown> | null;
  metadata?: Record<string, unknown> | null;
  createdAt?: string | Date;
  updatedAt?: string | Date;
  historyPolicyDefaults?: ToolHistoryPolicyConfig;
  toolPolicies?: Record<string, ToolHistoryPolicy>;
}

/** Input type for creating a new MCP server configuration. */
export type NewMCPServer = Partial<MCPServer> & Pick<MCPServer, "name">;

/**
 * Arguments passed to the history transform hook.
 * Allows applications to filter or rewrite LLM-visible history per call.
 */
export interface HistoryTransformArgs {
  /** History as generated for the LLM, before the system prompt is added. */
  messages: ChatMessage[];
  /** Raw stored thread messages used to build the generated history. */
  rawHistory: NewMessage[];
  /** Current thread being processed. */
  thread: Thread;
  /** Agent that will receive the final history. */
  agent: Agent;
  /** Event that triggered the current LLM call. */
  sourceEvent: Event;
  /** Processor dependencies for advanced lookups or logging. */
  deps: ProcessorDeps;
}

/**
 * Hook for rewriting the generated message history before it is sent to the LLM.
 */
export type HistoryTransform = (
  args: HistoryTransformArgs,
) => ChatMessage[] | Promise<ChatMessage[]>;

/**
 * Configuration for embedding generation in RAG.
 */
export interface EmbeddingConfig {
  /** Embedding provider to use. */
  provider: "openai" | "ollama" | "cohere";
  /** Model name for generating embeddings. */
  model: string;
  /** API key for the embedding provider. */
  apiKey?: string;
  /** Base URL for the embedding API endpoint. */
  baseUrl?: string;
  /** Embedding vector dimensions. */
  dimensions?: number;
  /** Number of texts to embed in a single batch. */
  batchSize?: number;
}

/**
 * Configuration for document chunking in RAG.
 */
export interface ChunkingConfig {
  /** Chunking strategy to use. Default: "fixed". */
  strategy?: "fixed" | "paragraph" | "sentence";
  /** Target chunk size in tokens. Default: 512. */
  chunkSize?: number;
  /** Overlap between chunks in tokens. Default: 50. */
  chunkOverlap?: number;
}

/**
 * Configuration for similarity-based retrieval in RAG.
 */
export interface RetrievalConfig {
  /** Default number of results to return. Default: 5. */
  defaultLimit?: number;
  /** Minimum similarity score threshold. Default: 0.7. */
  similarityThreshold?: number;
}

/**
 * Context passed to namespace resolver functions for dynamic namespace selection.
 */
export interface NamespaceContext {
  /** Thread context information. */
  thread?: {
    id?: string;
    externalId?: string;
    metadata?: Record<string, unknown>;
  };
  /** Sender context information. */
  sender?: {
    id?: string;
    externalId?: string;
    type?: string;
    metadata?: Record<string, unknown>;
  };
  /** Agent context information. */
  agent?: { id?: string; name?: string };
  /** Message context information. */
  message?: { content?: string };
}

/**
 * Function type for dynamically resolving RAG namespaces.
 * Use this to select which document namespaces to search based on context.
 *
 * @param context - Context information about the current request
 * @returns Array of namespace names to search
 */
export type NamespaceResolver = (
  context: NamespaceContext,
) => Promise<string[]> | string[];

/**
 * Complete RAG (Retrieval-Augmented Generation) configuration.
 */
export interface RagConfig {
  /** Whether RAG is enabled. Default: true. */
  enabled?: boolean;
  /** Embedding generation configuration. Required. */
  embedding: EmbeddingConfig;
  /** Document chunking configuration. */
  chunking?: ChunkingConfig;
  /** Retrieval configuration. */
  retrieval?: RetrievalConfig;
  /** Default namespace for document storage. */
  defaultNamespace?: string;
  /** Dynamic namespace resolver function. */
  namespaceResolver?: NamespaceResolver;
  /** LLM configuration for background RAG tasks (entity extraction, summarization). */
  llmConfig?: {
    provider: string;
    model?: string;
    apiKey?: string;
    temperature?: number;
  };
}

/**
 * Configuration for entity extraction from messages and documents.
 */
export interface EntityExtractionConfig {
  /** Whether entity extraction is enabled. Default: false. */
  enabled: boolean;
  /** Similarity threshold for dedup candidate matching. Default: 0.95. */
  similarityThreshold?: number;
  /** Threshold above which to auto-merge without LLM confirm. Default: 0.99. */
  autoMergeThreshold?: number;
  /** Namespace scope for extracted entities. Default: "agent". */
  namespace?: "thread" | "agent" | "global";
  /** Filter to specific entity types (open vocabulary). e.g., ["concept", "decision", "person"]. */
  entityTypes?: string[];
}

/**
 * RAG options specific to an individual agent.
 */
export interface AgentRagOptions {
  /** RAG mode for this agent. "tool" adds search tools, "auto" injects context, "disabled" turns off RAG. */
  mode?: "tool" | "auto" | "disabled";
  /** Namespaces this agent can search. */
  namespaces?: string[];
  /** Namespace for documents ingested by this agent. */
  ingestNamespace?: string;
  /** Number of chunks to auto-inject when mode is "auto". */
  autoInjectLimit?: number;
  /** Entity extraction configuration. */
  entityExtraction?: EntityExtractionConfig;
}

/**
 * Controls how an agent handles assets it produces directly or through its tool calls.
 */
export interface AgentAssetProduceOptions {
  /**
   * Whether generated assets should be persisted into the shared asset store.
   * When false, generated blobs are stripped/sanitized before message persistence.
   * Default: true
   */
  persistGeneratedAssets?: boolean;
}

/**
 * Per-agent asset behavior.
 */
export interface AgentAssetOptions {
  /** Controls persistence of assets generated by this agent or its tool calls. */
  produce?: AgentAssetProduceOptions;
  /**
   * Per-agent override for resolveInLLM.
   * When set, takes precedence over the global AssetConfig.resolveInLLM for
   * LLM calls made on behalf of this agent.
   */
  resolveInLLM?: boolean;
}

/**
 * Agent entity with extended LLM options supporting dynamic resolution.
 */
export interface Agent {
  id: string;
  name: string;
  externalId?: string | null;
  role: string;
  personality?: string | null;
  instructions?: string | null;
  description?: string | null;
  allowedAgents?: string[] | null;
  allowedTools?: string[] | null;
  metadata?: Record<string, unknown> | null;
  createdAt?: string | Date;
  updatedAt?: string | Date;
  /** LLM provider configuration or dynamic resolver function. */
  llmOptions?: LLMRuntimeConfig | AgentLlmOptionsResolver;
  /** RAG options for this agent. */
  ragOptions?: AgentRagOptions;
  /** Optional per-agent asset behavior. */
  assetOptions?: AgentAssetOptions;
  /**
   * Controls which skills this agent can access.
   * - `undefined` (default): all skills available
   * - `null`: no skills available
   * - `string[]`: only the named skills are available
   */
  allowedSkills?: string[] | null;
}

/** Input type for creating a new Agent. */
export type NewAgent = Partial<Agent> & Pick<Agent, "name" | "role">;

/** Message entity representing a single message in a thread. */
export interface Message {
  id: string;
  threadId: string;
  senderId: string;
  senderType: "agent" | "user" | "system" | "tool";
  senderUserId?: string | null;
  targetId?: string | null;
  targetQueue?: string[] | null;
  externalId?: string | null;
  content?: string | null;
  toolCallId?: string | null;
  toolCalls?: unknown[] | null;
  reasoning?: string | null;
  metadata?: Record<string, unknown> | null;
  createdAt?: string | Date;
  updatedAt?: string | Date;
}

/** Input type for creating a new Message. */
export type NewMessage = Partial<Message> &
  Pick<Message, "threadId" | "senderId" | "senderType">;

/** Document stored in the RAG knowledge base. */
export interface Document {
  id: string;
  namespace: string;
  externalId?: string | null;
  sourceType: "url" | "file" | "text" | "asset";
  sourceUri?: string | null;
  title?: string | null;
  mimeType?: string | null;
  contentHash: string;
  assetId?: string | null;
  status: "pending" | "processing" | "indexed" | "failed";
  chunkCount?: number | null;
  errorMessage?: string | null;
  metadata?: Record<string, unknown> | null;
  createdAt?: string | Date;
  updatedAt?: string | Date;
}

/** Input type for creating a new Document. */
export type NewDocument = Partial<Document> &
  Pick<Document, "sourceType" | "contentHash">;

/** Chunk of a document with embedding vector for similarity search. */
export interface DocumentChunk {
  id: string;
  documentId: string;
  namespace: string;
  chunkIndex: number;
  content: string;
  tokenCount?: number | null;
  embedding?: number[] | null;
  startPosition?: number | null;
  endPosition?: number | null;
  metadata?: Record<string, unknown> | null;
  createdAt?: string | Date;
  updatedAt?: string | Date;
}

/** Input type for creating a new DocumentChunk. */
export type NewDocumentChunk = Partial<DocumentChunk> &
  Pick<DocumentChunk, "documentId" | "namespace" | "chunkIndex" | "content">;

/**
 * Thread metadata interface for multi-agent conversation state.
 * Stored directly in thread.metadata for persistence.
 */
export interface ThreadMetadata {
  /** Per-participant target state: senderId → targetId */
  participantTargets?: {
    [senderId: string]: string;
  };
  /** Agent turn counter for loop prevention */
  agentTurnCount?: number;
  /** Max agent turns config (per-thread override) */
  maxAgentTurns?: number;
  /** User external ID for user context lookup */
  userExternalId?: string;
  /** Pending tool batches for aggregation */
  pendingToolBatches?: Record<string, unknown>;
  /** Allow additional properties */
  [key: string]: unknown;
}

/**
 * Context object passed through the chat processing pipeline.
 * Contains all configuration and state needed by event processors.
 */
export interface ChatContext {
  /** Available agents. */
  agents?: Agent[];
  /** Available tools. */
  tools?: Tool[];
  /** API configurations for external REST APIs. */
  apis?: API[];
  /** MCP server configurations. */
  mcpServers?: MCPServer[];
  /** Available skills loaded from project/user/bundled/remote sources. */
  skills?: import("@/runtime/loaders/skill-types.ts").Skill[];
  /** Whether streaming is enabled. Default: true. */
  stream?: boolean;
  /** Database instance. */
  dbInstance?: CopilotzDb;
  /** Database configuration. */
  dbConfig?: DatabaseConfig;
  /** Metadata to attach to threads. */
  threadMetadata?: Record<string, unknown>;
  /** TTL for queue items in milliseconds. */
  queueTTL?: number;
  /** User metadata. */
  userMetadata?: Record<string, unknown>;
  /** Hook for rewriting generated message history before the LLM call. */
  historyTransform?: HistoryTransform;
  /** Event processors by event type, ordered by priority. */
  processors?: Record<
    string,
    Array<EventProcessor<unknown, ProcessorDeps>>
  >;
  /** Asset storage instance. */
  assetStore?: AssetStore;
  /** Asset configuration. */
  assetConfig?: AssetConfig;
  /** Function to resolve asset references. */
  resolveAsset?: (ref: string) => Promise<{ bytes: Uint8Array; mime: string }>;
  /** RAG configuration. */
  ragConfig?: RagConfig;
  /** Embedding configuration. */
  embeddingConfig?: EmbeddingConfig;
  /** Security-related runtime hooks. */
  security?: {
    /**
     * Resolve runtime-only LLM configuration, such as API keys, just before
     * the provider call is made. Returned values are never persisted by the
     * runtime unless custom code does so explicitly.
     */
    resolveLLMRuntimeConfig?: ResolveLLMRuntimeConfig;
  };
  /** Optional namespace prefix for multi-tenancy isolation. */
  namespacePrefix?: string;
  /** Optional AGENTS.md instructions loaded from the current working directory. */
  agentsFileInstructions?: AgentsFileInstructions | null;
  /**
   * Resolved namespace for this run.
   * Priority: RunOptions.namespace > CopilotzConfig.namespace > undefined
   */
  namespace?: string;
  /**
   * Collections manager for custom data storage.
   * - If namespace is set: returns pre-scoped collections (no withNamespace needed)
   * - If no namespace: returns raw manager (use withNamespace manually)
   */
  collections?: ScopedCollectionsManager | CollectionsManager;
  /**
   * The sender of the current message being processed.
   * Available in processors and tools for the message that triggered this run.
   */
  sender?: {
    id?: string | null;
    externalId?: string | null;
    type?: "user" | "agent" | "tool" | "system";
    name?: string | null;
    metadata?: Record<string, unknown> | null;
  };
  /**
   * Multi-agent conversation configuration.
   * Controls how agents interact in threads with multiple participants.
   */
  multiAgent?: {
    /**
     * Whether multi-agent routing is enabled for this run.
     * When disabled, agent responses always route back to the original sender.
     * Default: false unless multiAgent config is explicitly provided.
     */
    enabled?: boolean;
    /**
     * Maximum consecutive agent-to-agent messages before forcing target to user.
     * Prevents infinite agent loops.
     * Default: 5
     */
    maxAgentTurns?: number;
    /**
     * Whether to include target info in conversation history.
     * Helps agents understand conversation flow.
     * Default: true
     */
    includeTargetContext?: boolean;
  };
}

/**
 * Collections manager interface for accessing custom collections.
 * Access collections by name and use withNamespace() for scoped access.
 */
export interface CollectionsManager {
  /** Get a scoped client with namespace pre-applied to all operations. */
  withNamespace(namespace: string): ScopedCollectionsManager;
  /** List all registered collection names. */
  getCollectionNames(): string[];
  /** Check if a collection exists. */
  hasCollection(name: string): boolean;
  /** Access collections by name. */
  [collectionName: string]: unknown;
}

/**
 * Scoped collections manager with namespace pre-applied.
 */
export interface ScopedCollectionsManager {
  /** Access scoped collections by name. */
  [collectionName: string]: unknown;
}

/**
 * Context for namespace resolution.
 */
export interface NamespaceResolutionContext {
  /** Thread ID for thread-scoped namespaces. */
  threadId?: string;
  /** Agent ID for agent-scoped namespaces. */
  agentId?: string;
}

/**
 * Resolves a namespace based on scope and optional prefix.
 *
 * @param scope - The scope level: "thread", "agent", or "global"
 * @param context - Context containing threadId and agentId
 * @param prefix - Optional namespace prefix for isolation
 * @returns Resolved namespace string
 *
 * @example
 * ```ts
 * resolveNamespace("agent", { agentId: "bot-1" }, "myapp")
 * // Returns: "myapp:agent:bot-1"
 *
 * resolveNamespace("thread", { threadId: "abc-123" })
 * // Returns: "thread:abc-123"
 * ```
 */
export function resolveNamespace(
  scope: "thread" | "agent" | "global",
  context: NamespaceResolutionContext,
  prefix?: string,
): string {
  const base = prefix ? `${prefix}:` : "";

  switch (scope) {
    case "thread":
      if (!context.threadId) {
        throw new Error("threadId required for thread-scoped namespace");
      }
      return `${base}thread:${context.threadId}`;
    case "agent":
      if (!context.agentId) {
        throw new Error("agentId required for agent-scoped namespace");
      }
      return `${base}agent:${context.agentId}`;
    case "global":
      return `${base}global`;
  }
}

/**
 * Type guard to check if an event is a TOKEN event.
 *
 * @param event - The event to check
 * @returns True if the event is a TOKEN event
 *
 * @example
 * ```ts
 * if (isTokenEvent(event)) {
 *   console.log(event.payload.token);
 * }
 * ```
 */
export function isTokenEvent(event: Event): event is TokenEvent {
  return event?.type === "TOKEN";
}
