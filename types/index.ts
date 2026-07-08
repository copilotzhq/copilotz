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
  RagIngestPayload,
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
  /** Payload for RAG ingestion background events. */
  RagIngestPayload,
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
  DatabaseRestoreConfig,
  DatabaseSnapshotFileOptions,
  DbInstance,
  PGliteConfig,
} from "@/database/index.ts";

export type {
  /** Copilotz database instance with CRUD and custom operations. */
  CopilotzDb,
  /** Configuration options for database connection. */
  DatabaseConfig,
  /** File-backed PGlite snapshot restore/dump configuration. */
  DatabaseRestoreConfig,
  /** File paths used when saving a PGlite data directory snapshot. */
  DatabaseSnapshotFileOptions,
  /** Low-level database instance from Ominipg. */
  DbInstance,
  /** Advanced PGlite runtime options forwarded through Ominipg. */
  PGliteConfig,
};
export type {
  DatabaseOperations,
  DomainMutationOperations,
  GraphMutateManyInput,
  GraphMutateManyResult,
  GraphMutationOptions,
  LlmAttemptInput,
  LlmAttemptPatch,
  OutboxEventInput,
  OutboxOperations,
  ToolExecutionInput,
  ToolExecutionPatch,
  UnsafeGraphOperations,
} from "@/database/operations/index.ts";

/** Payload emitted when the asset pipeline stores a new file or media object. */
export interface AssetCreatedEventPayload {
  /** The persisted asset ID. */
  assetId: string;
  /** Canonical asset reference, usually `asset://<id>`. */
  ref: string;
  /** MIME type of the stored asset. */
  mime?: string;
  /** Who produced the asset. */
  by: "tool" | "agent" | "user" | "system" | "job";
  /** Tool name when the asset came from a tool call. */
  tool?: string;
  /** Tool call ID when the asset came from a tool call. */
  toolCallId?: string;
  /** Full base64 payload for passthrough/client-managed storage flows. */
  base64?: string;
  /** Full data URL for passthrough/client-managed storage flows. */
  dataUrl?: string;
}

/** Payload emitted when the asset pipeline cannot persist or normalize media. */
export interface AssetErrorEventPayload {
  /** Normalized error details from the asset pipeline. */
  error: {
    message: string;
    code?: string;
    statusCode?: number;
  };
  /** Which asset pipeline stage failed. */
  source: "attachments" | "tool_output";
  /** Asset kind when known. */
  kind?: "image" | "audio" | "file";
  /** MIME type when known. */
  mime?: string;
  /** Original file name when known. */
  fileName?: string;
  /** Original byte size when known. */
  size?: number;
  /** Who initiated the asset creation attempt. */
  by: "tool" | "agent" | "user" | "system";
  /** Tool name when the failure came from a tool output. */
  tool?: string;
  /** Tool call ID when the failure came from a tool output. */
  toolCallId?: string;
  /** Resolved namespace when available. */
  namespace?: string;
}

import type { EventProcessor, ProcessorDeps } from "@/runtime/event-engine.ts";

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

/** Hook for resolving transient LLM runtime settings before provider calls. */
export type ResolveLLMRuntimeConfig = (
  args: ResolveLLMRuntimeConfigArgs,
) =>
  | Partial<LLMRuntimeConfig>
  | Promise<Partial<LLMRuntimeConfig> | undefined>
  | undefined;

/** Visibility level for persisted tool-call results in future LLM history. */
export type ToolHistoryVisibility =
  | "requester_only"
  | "public_status"
  | "public";

/** Declarative history policy attached to a tool or API-generated tool. */
export interface ToolHistoryPolicyConfig {
  /** How much of the tool result can be shown to later agents. */
  visibility?: ToolHistoryVisibility;
}

/** Runtime tool history policy after configuration defaults are merged. */
export interface ToolHistoryPolicy extends ToolHistoryPolicyConfig {}

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
export type NewTool =
  & Partial<Tool>
  & Pick<Tool, "key" | "name" | "description">;

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
      /** Dot path to extract from a JSON auth response. Omit to use the raw response body text as the token. */
      path?: string | null;
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

export interface APIPrepareRequestInput {
  url: string;
  method: string;
  headers: Record<string, string>;
  queryParams: URLSearchParams;
  body?: unknown;
}

export interface APIPrepareRequestContext {
  apiName: string;
  toolKey: string;
  threadId?: string;
  senderId?: string;
  senderType?: "user" | "agent" | "tool" | "system" | "job";
  userExternalId?: string;
  agent?: Agent | null;
  namespacePrefix?: string;
  userMetadata?: Record<string, unknown>;
  threadMetadata?: Record<string, unknown>;
  db?: CopilotzDb;
}

export type APIPrepareRequest = (
  request: APIPrepareRequestInput,
  context: APIPrepareRequestContext,
) =>
  | APIPrepareRequestInput
  | Promise<APIPrepareRequestInput | undefined>
  | undefined;

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
  prepareRequest?: APIPrepareRequest | null;
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

/** Which persisted reasoning entries are eligible for future LLM history. */
export type ReasoningHistoryInclude = "none" | "self" | "all";

/**
 * Controls whether persisted agent reasoning is included in future LLM-visible
 * history. Defaults to `{ include: "self", maxEstimatedTokens: 750 }`.
 */
export interface ReasoningHistoryOptions {
  /** Which persisted reasoning entries to include in future prompts. */
  include?: ReasoningHistoryInclude;
  /** Max estimated reasoning tokens included per message. Set 0 to disable caps. */
  maxEstimatedTokens?: number;
}

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
  /** Maximum estimated input tokens per embedded text. Defaults to 7,500. */
  maxInputTokens?: number;
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

export interface RagScope {
  /** Include documents directly linked to this thread and its knowledge spaces. */
  threadId?: string;
  /** Include documents/knowledge spaces this agent can access. */
  agentId?: string;
  /** Include explicitly selected knowledge-space nodes. */
  knowledgeSpaceIds?: string[];
  /** Include explicitly selected document nodes. */
  documentIds?: string[];
}

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
  /** Filter to specific entity types (open vocabulary). e.g., ["concept", "decision", "person"]. */
  entityTypes?: string[];
}

/**
 * RAG options specific to an individual agent.
 */
export interface AgentRagOptions {
  /** RAG mode for this agent. "tool" exposes search tools, "disabled" turns off RAG. */
  mode?: "tool" | "disabled";
  /** Graph scope this agent can search. Namespace remains the tenant partition. */
  scope?: RagScope;
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
  senderType: "agent" | "user" | "system" | "tool" | "job";
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
export type NewMessage =
  & Partial<Message>
  & Pick<Message, "threadId" | "senderId" | "senderType">;

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
export type NewDocument =
  & Partial<Document>
  & Pick<Document, "sourceType" | "contentHash">;

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
export type NewDocumentChunk =
  & Partial<DocumentChunk>
  & Pick<DocumentChunk, "documentId" | "namespace" | "chunkIndex" | "content">;

/**
 * Declarative memory resource loaded from `resources/memory/`.
 * These resources describe which memory capabilities are available at runtime.
 */
export interface MemoryResource {
  id?: string;
  name: string;
  kind: "participant" | "history" | "retrieval" | string;
  description?: string | null;
  enabled?: boolean;
  metadata?: Record<string, unknown> | null;
  config?: Record<string, unknown> | null;
}

export interface MemoryIdentityMetadata {
  userExternalId?: string;
  [key: string]: unknown;
}

export interface MemoryThreadMetadata {
  identity?: MemoryIdentityMetadata;
  [key: string]: unknown;
}

export interface MemoryContribution {
  resource: string;
  kind: string;
  content: string;
  tokenEstimate?: number;
}

export interface MemoryComposition {
  systemPromptSections: string[];
  contributions: MemoryContribution[];
  history: ChatMessage[];
  identity?: MemoryIdentityMetadata;
}

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
  /** Loaded memory resources. */
  memory?: MemoryResource[];
  /** Available skills loaded from project/user/bundled/remote sources. */
  skills?: import("@/runtime/loaders/skill-types.ts").Skill[];
  /** Whether streaming is enabled. Default: true. */
  stream?: boolean;
  /**
   * Minimum event priority this worker should process.
   * Defaults to 0 for foreground runs; recovery/background workers may use
   * lower values to resume deferred work.
   */
  minPriority?: number;
  /** Database instance. */
  dbInstance?: CopilotzDb;
  /** Database configuration. */
  dbConfig?: DatabaseConfig;
  /** Metadata to attach to threads. */
  threadMetadata?: Record<string, unknown>;
  /** TTL for queue items in milliseconds. */
  queueTTL?: number;
  /**
   * Default maximum wall-clock time for a single tool execution (in milliseconds).
   *
   * - Default (when omitted at createCopilotz): 300_000 (5 minutes)
   * - `undefined`: disable the framework timeout
   */
  toolExecutionTimeoutMs?: number | undefined;
  /**
   * Per-tool execution timeout overrides (in milliseconds), keyed by tool key.
   *
   * If a key is present, it takes precedence over `toolExecutionTimeoutMs`.
   * A value of `undefined` disables the framework timeout for that tool key.
   */
  toolExecutionTimeoutsMs?: Record<string, number | undefined>;
  /**
   * Max estimated tokens of JSON-serialized tool `output` per result in LLM
   * history (envelope included). Default **2_500** from `createCopilotz`; set **0** on
   * config to disable. Does not alter persisted messages — only history passed
   * to the model (before `historyTransform` / `formatMessages`).
   */
  toolResultHistoryMaxEstimatedTokens?: number;
  /**
   * Controls whether persisted agent reasoning is included in future LLM-visible
   * history. Defaults to `{ include: "self", maxEstimatedTokens: 750 }`.
   */
  reasoningHistory?: ReasoningHistoryOptions;
  /** User metadata. */
  userMetadata?: Record<string, unknown>;
  /** Hook for rewriting generated message history before the LLM call. */
  historyTransform?: HistoryTransform;
  /** Usage/cost tracking options (cost resolver + record hook). */
  usage?: import("@/runtime/usage/types.ts").UsageOptions;
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
  /** Available LLM providers keyed by provider name. */
  llmProviders?: Record<
    string,
    import("@/runtime/llm/types.ts").ProviderFactory
  >;
  /** Available embedding providers keyed by provider name. */
  embeddingProviders?: Record<
    string,
    import("@/runtime/embeddings/types.ts").EmbeddingProviderFactory
  >;
  /** Available asset storage backend names. */
  storageBackends?: string[];
  /** Security-related runtime hooks. */
  security?: {
    /**
     * Resolve runtime-only LLM configuration, such as API keys, just before
     * the provider call is made. Returned values are never persisted by the
     * runtime unless custom code does so explicitly.
     */
    resolveLLMRuntimeConfig?: ResolveLLMRuntimeConfig;
  };
  /** Optional AGENTS.md instructions loaded from the current working directory. */
  agentsFileInstructions?: AgentsFileInstructions | null;
  /**
   * Resolved namespace for this run.
   * Priority: RunOptions.namespace > CopilotzConfig.namespace > undefined
   */
  namespace?: string;
  /**
   * PostgreSQL schema for this run/worker lifecycle.
   * Propagated to background event workers so tenant-scoped DB writes
   * stay in the same schema as the initial run request.
   */
  schema?: string;
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
    type?: "user" | "agent" | "tool" | "system" | "job";
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
     * Agent to route to when maxAgentTurns is reached, instead of hard-stopping.
     * Useful for routing to a lead/coordinator agent that can synthesize and
     * reply to the user. When unset, the loop hard-stops with no response.
     */
    maxTurnsFallbackAgent?: string;
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
