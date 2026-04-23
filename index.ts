import {
  createCollectionsManager,
  createDatabase,
  dropTenantSchema,
  generateCollectionIndexes,
  listTenantSchemas,
  migrations,
  provisionTenantSchema,
  schema,
  schemaExists,
  warmSchemaCache,
  withSchema,
} from "@/database/index.ts";
import type { OminipgWithCrud } from "omnipg";
import { type RunHandle, type RunOptions, runThread } from "@/runtime/index.ts";
import type {
  CollectionCrud,
  CollectionDefinition,
  ScopedCollectionCrud,
} from "@/database/collections/types.ts";
import {
  hasRunInput,
  normalizeInboundRunMessage,
} from "@/utils/inbound-message.ts";
import loadResources from "@/runtime/loaders/resources.ts";
import type {
  FeatureEntry,
  LoadedEmbeddingProvider,
  LoadedLlmProvider,
  LoadedStorageAdapter,
  Resources,
} from "@/runtime/loaders/resources.ts";
import {
  type ChannelEntry,
  type ChannelOverrides,
  decorateChannelEntries,
  mergeChannelEntries,
} from "@/server/channels.ts";
import { mergeResourceArrays } from "@/utils/merge-resources.ts";
import type { Skill } from "@/runtime/loaders/skill-types.ts";
import {
  type AgentsFileConfig,
  loadAgentsFileInstructions,
} from "@/runtime/loaders/agents-file.ts";
import {
  loadSkillFromUrl,
  mergeSkills,
} from "@/runtime/loaders/skill-loader.ts";
import type {
  Agent,
  API,
  AssetCreatedEventPayload,
  AssetErrorEventPayload,
  ChatContext,
  CopilotzDb,
  DatabaseConfig,
  EventProcessor,
  HistoryTransform,
  LlmCallEventPayload,
  MCPServer,
  MemoryResource,
  MessagePayload,
  NewAPI,
  NewMCPServer,
  NewTool,
  ProcessorDeps,
  RagIngestPayload,
  ResolveLLMRuntimeConfig,
  TokenEventPayload,
  Tool,
  ToolCallEventPayload,
} from "@/types/index.ts";

import defaultBanner from "@/runtime/banner.ts";
import { startInteractiveCli } from "@/runtime/cli.ts";

export type {
  /** AI Agent configuration with LLM options and capabilities. */
  Agent,
  /** RAG options specific to an agent. */
  AgentRagOptions,
  /** API configuration for connecting to external REST APIs via OpenAPI. */
  API,
  /** Payload for asset creation stream events. */
  AssetCreatedEventPayload,
  /** Payload for asset pipeline error stream events. */
  AssetErrorEventPayload,
  /** Context object passed through the chat pipeline. */
  ChatContext,
  /** Configuration for document chunking strategies. */
  ChunkingConfig,
  /** Database instance with CRUD operations and custom ops. */
  CopilotzDb,
  /** Configuration options for the database connection. */
  DatabaseConfig,
  /** Low-level database instance type from Ominipg. */
  DbInstance,
  /** Document stored in the RAG knowledge base. */
  Document,
  /** Chunk of a document with embedding vector. */
  DocumentChunk,
  /** Configuration for embedding generation. */
  EmbeddingConfig,
  /** Configuration for entity extraction. */
  EntityExtractionConfig,
  /** Event in the event queue system. */
  Event,
  /** Interface for custom event processors. */
  EventProcessor,
  /** Hook for rewriting generated message history before the LLM call. */
  HistoryTransform,
  /** Arguments passed to the history transform hook. */
  HistoryTransformArgs,
  /** Specific LLM_CALL event type with typed payload. */
  LlmCallEvent,
  /** Payload structure for LLM call events. */
  LlmCallEventPayload,
  /** MCP (Model Context Protocol) server configuration. */
  MCPServer,
  /** Declarative memory resource loaded from resources/memory. */
  MemoryResource,
  /** Individual message within a conversation thread. */
  Message,
  /** Payload structure for incoming messages. */
  MessagePayload,
  /** Context for namespace resolution. */
  NamespaceResolutionContext,
  /** Input type for creating a new Agent. */
  NewAgent,
  /** Input type for creating a new API configuration. */
  NewAPI,
  /** Input type for creating a new Document. */
  NewDocument,
  /** Input type for creating a new DocumentChunk. */
  NewDocumentChunk,
  /** New event to be created in the event queue. */
  NewEvent,
  /** Input type for creating a new MCP server configuration. */
  NewMCPServer,
  /** Input type for creating a new Message. */
  NewMessage,
  /** Specific NEW_MESSAGE event type with typed payload. */
  NewMessageEvent,
  /** Input type for creating a new Thread. */
  NewThread,
  /** Input type for creating a new Tool. */
  NewTool,
  /** Dependencies injected into event processors. */
  ProcessorDeps,
  /** Configuration for RAG (Retrieval-Augmented Generation). */
  RagConfig,
  /** Payload for background RAG ingestion events. */
  RagIngestPayload,
  /** Runtime hook for resolving LLM execution config. */
  ResolveLLMRuntimeConfig,
  /** Configuration for similarity-based retrieval. */
  RetrievalConfig,
  /** Conversation thread containing messages between users and agents. */
  Thread,
  /** Thread metadata interface for multi-agent conversation state. */
  ThreadMetadata,
  /** Payload structure for streaming token events. */
  TokenEventPayload,
  /** Tool definition with input/output schemas for agent capabilities. */
  Tool,
  /** Specific TOOL_CALL event type with typed payload. */
  ToolCallEvent,
  /** Payload structure for tool call events. */
  ToolCallEventPayload,
  /** Context passed to custom tool `execute` handlers (db, threadId, collections, etc.). */
  ToolExecutionContext,
  /** Runtime tool history policy with optional projector callback. */
  ToolHistoryPolicy,
  /** Declarative history policy for tools. */
  ToolHistoryPolicyConfig,
  /** Runtime-only history visibility for tool results across agents. */
  ToolHistoryVisibility,
  /** Callback type for projecting shared tool results. */
  ToolResultProjector,
  /** Context passed to tool result projector callbacks. */
  ToolResultProjectorContext,
} from "@/types/index.ts";
export type {
  ChannelAdapterRequest,
  ChannelEgressOverrides,
  ChannelEntry,
  ChannelIngressOverrides,
  ChannelOverrideArgs,
  ChannelOverrideCallback,
  ChannelOverrides,
  ChannelOverridesEntry,
  ChannelRouteSpec,
  EgressAdapter,
  EgressDeliveryContext,
  IngressAdapter,
  IngressEnvelope,
  IngressResult,
} from "@/server/channels.ts";

/**
 * Returns a record of all built-in native tools available to agents.
 * Native tools include file operations, HTTP requests, task management, and more.
 *
 * @returns Record of tool names to tool definitions
 */
export { getNativeTools } from "@/resources/tools/_registry.ts";

/**
 * Creates a new database connection for Copilotz.
 * Supports PostgreSQL, PGlite (in-memory), and file-based databases.
 */
export { createDatabase };

/** Database schema definitions used by Copilotz. */
export { schema };

/** SQL migrations for setting up the database schema. */
export { migrations };

/**
 * Schema context utilities for multi-tenant PostgreSQL schema isolation.
 * Use withSchema() to execute operations in a specific tenant's schema.
 *
 * @example
 * ```ts
 * import { withSchema } from "@copilotz/lib";
 *
 * // Execute operations in a specific schema
 * await withSchema('tenant_abc', async () => {
 *   await db.query('SELECT * FROM users');
 * });
 * ```
 */
export { withSchema } from "@/database/schema-context.ts";

/**
 * Schema provisioning utilities for creating and managing tenant schemas.
 *
 * @example
 * ```ts
 * import { provisionTenantSchema, schemaExists } from "@copilotz/lib";
 *
 * // Create a new tenant schema with all tables
 * await provisionTenantSchema(db, 'tenant_abc');
 *
 * // Check if a schema exists
 * if (await schemaExists(db, 'tenant_abc')) {
 *   // Ready to use
 * }
 * ```
 */
export {
  clearSchemaCache,
  dropTenantSchema,
  listTenantSchemas,
  provisionTenantSchema,
  schemaExists,
  warmSchemaCache,
} from "@/database/schema-provisioning.ts";

/**
 * Define a custom collection with JSON Schema.
 * Collections map to the graph structure (nodes + edges) with a developer-friendly CRUD interface.
 *
 * @example
 * ```ts
 * const customerSchema = {
 *   type: 'object',
 *   properties: {
 *     id: { type: 'string' },
 *     email: { type: 'string' },
 *     plan: { type: 'string', enum: ['free', 'pro', 'enterprise'] },
 *   },
 *   required: ['id', 'email'],
 * } as const;
 *
 * const customers = defineCollection({
 *   name: 'customer',
 *   schema: customerSchema,
 *   indexes: ['email'],
 * });
 *
 * type Customer = typeof customers.$inferSelect;
 * ```
 */
export {
  defineCollection,
  index,
  relation,
} from "@/database/collections/index.ts";

/** Type definitions for collections API. */
export type {
  CollectionCrud,
  CollectionDefinition,
  CollectionsConfig,
  IndexDefinition,
  QueryOptions,
  RelationDefinition,
  ScopedCollectionCrud,
  SearchOptions,
  WhereFilter,
  WhereOperators,
} from "@/database/collections/types.ts";

/**
 * Resolves a namespace based on scope and optional prefix.
 * Use for multi-tenancy and entity scope resolution.
 */
export { resolveNamespace } from "@/types/index.ts";

/**
 * Asset utilities and stores.
 */
export {
  createAssetStoreForNamespace,
  createMemoryAssetStore,
  extractAssetId,
  getBase64ForRef,
  getDataUrlForRef,
  isAssetRef,
  parseAssetRef,
} from "@/runtime/storage/assets.ts";

/** Event emitted from the streaming event queue. */
export type { StreamEvent } from "@/runtime/index.ts";
export type { LLMConfig, LLMRuntimeConfig } from "@/runtime/llm/index.ts";

import type { AssetConfig, AssetStore } from "@/runtime/storage/assets.ts";
import {
  bytesToBase64,
  createAssetStoreForNamespace,
  createMemoryAssetStore,
  resolveAssetIdForStore,
  resolveAssetNamespace,
} from "@/runtime/storage/assets.ts";

/** Type representing all database schemas. */
export type DbSchemas = typeof schema;

/** CRUD operations interface for database entities. */
export type DbCrud = OminipgWithCrud<DbSchemas>["crud"];

/**
 * Loads resources (agents, APIs, tools, processors) from a file-based directory structure.
 * Useful for organizing agent configurations in separate files.
 *
 * @param options - Options including the path to the resources directory
 * @returns Loaded resources ready to pass to createCopilotz
 */
export { default as loadResources } from "@/runtime/loaders/resources.ts";

/** Type for resources loaded from the file system. */
export type {
  FeatureEntry,
  ResourceManifest,
  Resources,
} from "@/runtime/loaders/resources.ts";
export type {
  AgentsFileConfig,
  AgentsFileInstructions,
} from "@/runtime/loaders/agents-file.ts";

/**
 * Returns a simplified list of agents suitable for public API responses.
 */
export { listPublicAgents } from "@/utils/list-agents.ts";

/**
 * Merges two resource arrays with "append, explicit wins on ID collision" semantics.
 */
export { mergeResourceArrays } from "@/utils/merge-resources.ts";

/**
 * Skill type representing a loaded skill definition.
 */
export type { Skill, SkillIndexEntry } from "@/runtime/loaders/skill-types.ts";

/**
 * Filter skills based on an agent's allowedSkills configuration.
 */
export { filterSkillsForAgent } from "@/runtime/loaders/skill-loader.ts";

/**
 * Union type representing all possible events in the Copilotz event system.
 * Used for type-safe event handling in callbacks and processors.
 */
export type CopilotzEvent =
  | { type: "NEW_MESSAGE"; payload: MessagePayload }
  | { type: "TOOL_CALL"; payload: ToolCallEventPayload }
  | { type: "LLM_CALL"; payload: LlmCallEventPayload }
  | {
    type: "TOOL_RESULT";
    payload: import("@/types/index.ts").ToolResultEventPayload;
  }
  | {
    type: "LLM_RESULT";
    payload: import("@/types/index.ts").LlmResultEventPayload;
  }
  | { type: "RAG_INGEST"; payload: RagIngestPayload }
  | { type: "ASSET_CREATED"; payload: AssetCreatedEventPayload }
  | { type: "ASSET_ERROR"; payload: AssetErrorEventPayload }
  | { type: "TOKEN"; payload: TokenEventPayload };

/** Alias for Agent type, used in configuration. */
export type AgentConfig = Agent;

/** Alias for Tool type, used in configuration. */
export type ToolConfig = NewTool;

/** Alias for API type, used in configuration. */
export type APIConfig = NewAPI;

/** Alias for MCPServer type, used in configuration. */
export type MCPServerConfig = NewMCPServer;

type NormalizedCopilotzConfig =
  & Omit<CopilotzConfig, "agents" | "tools" | "apis" | "mcpServers" | "memory">
  & {
    agents: Agent[];
    tools?: Tool[];
    apis?: API[];
    mcpServers?: MCPServer[];
    memory?: MemoryResource[];
    skills?: import("@/runtime/loaders/skill-types.ts").Skill[];
    processorsByType?: ChatContext["processors"];
  };

function normalizeAgent(agent: AgentConfig): Agent {
  return agent as Agent;
}

function normalizeTool(tool: ToolConfig): Tool {
  return {
    ...tool,
    id: ("id" in tool && tool.id ? tool.id : tool.key) as Tool["id"],
  };
}

function normalizeApi(api: APIConfig): API {
  return {
    ...api,
    id: ("id" in api && api.id ? api.id : api.name) as API["id"],
  };
}

function normalizeMcpServer(server: MCPServerConfig): MCPServer {
  return {
    ...server,
    id: ("id" in server && server.id ? server.id : server.name) as MCPServer[
      "id"
    ],
  };
}

/**
 * Configuration options for creating a Copilotz instance.
 *
 * @example
 * ```ts
 * const config: CopilotzConfig = {
 *   agents: [{ id: "1", name: "Assistant", role: "helper" }],
 *   tools: [],
 *   stream: true,
 *   rag: {
 *     embedding: { provider: "openai", model: "text-embedding-3-small" }
 *   }
 * };
 * ```
 */
export interface CopilotzConfig {
  /**
   * Array of agent configurations.
   * Required unless `resources.path` is provided (agents will be loaded from files).
   * When both are set, explicit agents are merged with file-loaded agents (explicit wins on ID collision).
   */
  agents?: AgentConfig[];
  /** Optional array of custom tool definitions. */
  tools?: ToolConfig[];
  /** Optional array of API configurations for external REST APIs. */
  apis?: APIConfig[];
  /** Optional array of MCP server configurations. */
  mcpServers?: MCPServerConfig[];
  /** Optional array of declarative memory resources. */
  memory?: MemoryResource[];
  /** Optional custom event processors to extend or override default behavior. */
  processors?: Array<
    (EventProcessor<unknown, ProcessorDeps> & {
      eventType: string;
      priority?: number;
      id?: string;
    })
  >;
  /**
   * Optional feature handlers for application-level business logic.
   * Each feature has a name and a set of action handlers accessible via `/features/:name/:action`.
   */
  features?: FeatureEntry[];
  /** Optional channel adapters addressable via `/channels/:ingress(/to/:egress)`. */
  channels?: ChannelEntry[];
  /**
   * Load resources (agents, tools, APIs, processors) from a directory structure.
   * When set, `createCopilotz` internally calls `loadResources` and merges results
   * with any explicitly provided resource arrays.
   *
   * @example
   * ```ts
   * const copilotz = await createCopilotz({
   *   dbConfig: { url: Deno.env.get("DATABASE_URL") },
   *   resources: { path: "./resources" },
   * });
   * ```
   */
  resources?: {
    /**
     * Path(s) to resource directories or remote packages.
     * Accepts a single path or an array of paths. Each path can be:
     * - A local directory (relative to cwd or absolute)
     * - A remote specifier (`jsr:`, `npm:`, `https://`)
     *
     * Remote packages require a `manifest.ts` at their root.
     * Local directories use `readDir` discovery, or manifest-guided loading
     * if `manifest.ts` exists.
     *
     * @example
     * ```ts
     * resources: { path: "./resources" }
     * resources: { path: ["./resources", "jsr:@copilotz/browser-session@^1.0.0"] }
     * ```
     */
    path?: string | string[];
    /**
     * Named preset groups to load before applying explicit imports.
     * Bundled/native resources default to `["core"]`; user resource paths only
     * use presets when explicitly provided.
     */
    preset?: string[];
    /**
     * Dot-notation selectors used to pre-load only specific resources.
     *
     * @example
     * ```ts
     * imports: ["channels", "tools.read_file", "channels.whatsapp"]
     * ```
     */
    imports?: string[];
    /**
     * Filter callback to include/exclude resources after loading and merging.
     * Runs before normalization. Return `false` to exclude a resource.
     */
    filterResources?: (
      resource: { id?: string; name?: string; [key: string]: unknown },
      type: string,
    ) => boolean;
    /**
     * Optional resource-specific decorators applied after loading and merging.
     * Override callbacks receive both the original input and the default output.
     * Return `void` to keep the default behavior, or return a replacement output.
     */
    overrides?: {
      channels?: ChannelOverrides;
    };
    /** Enable live reload of file-based resources during development. Reserved for future use. */
    watch?: boolean;
  };
  /** Optional hook for rewriting generated message history before the LLM call. */
  historyTransform?: HistoryTransform;
  /** Optional database configuration. Defaults to in-memory PGlite. */
  dbConfig?: DatabaseConfig;
  /** Optional pre-existing database instance to reuse. */
  dbInstance?: CopilotzDb;
  /** Optional metadata to attach to all threads. */
  threadMetadata?: Record<string, unknown>;
  /** Optional TTL (time-to-live) in milliseconds for queue items. */
  queueTTL?: number;
  /**
   * Stale processing event threshold in milliseconds.
   * Events stuck in "processing" status longer than this will be reset to "pending" on next check.
   * This provides crash recovery for events that were being processed when the server crashed.
   * Default: 300000 (5 minutes).
   */
  staleProcessingThresholdMs?: number;
  /** Whether to enable streaming mode for real-time token output. */
  stream?: boolean;
  /**
   * Default namespace for collections and data isolation.
   * Can be overridden per-run via RunOptions.namespace.
   * Used for multi-tenancy isolation.
   *
   * @example
   * ```ts
   * const copilotz = await createCopilotz({
   *   agents: [...],
   *   collections: [customers],
   *   namespace: 'tenant-123', // All operations scoped to this namespace
   * });
   * ```
   */
  namespace?: string;
  /** Optional asset storage configuration for handling files and media. */
  assets?: {
    /** Asset storage configuration options. */
    config?: AssetConfig;
    /** Pre-existing asset store instance. */
    store?: AssetStore;
  };
  /** Optional RAG (Retrieval-Augmented Generation) configuration. */
  rag?: {
    /** Whether RAG is enabled. Defaults to true if rag config is provided. */
    enabled?: boolean;
    /** Embedding provider configuration (required for RAG). */
    embedding: {
      /** Embedding provider: "openai", "ollama", or "cohere". */
      provider: "openai" | "ollama" | "cohere";
      /** Model name for generating embeddings. */
      model: string;
      /** API key for the embedding provider. */
      apiKey?: string;
      /** Base URL for the embedding API. */
      baseUrl?: string;
      /** Embedding vector dimensions. */
      dimensions?: number;
      /** Batch size for embedding generation. */
      batchSize?: number;
    };
    /** Document chunking configuration. */
    chunking?: {
      /** Chunking strategy: "fixed", "paragraph", or "sentence". */
      strategy?: "fixed" | "paragraph" | "sentence";
      /** Target chunk size in tokens. */
      chunkSize?: number;
      /** Overlap between chunks in tokens. */
      chunkOverlap?: number;
    };
    /** Retrieval configuration. */
    retrieval?: {
      /** Default number of results to return. */
      defaultLimit?: number;
      /** Minimum similarity score threshold. */
      similarityThreshold?: number;
    };
    /** Default namespace for document storage. */
    defaultNamespace?: string;
    /** LLM configuration for background RAG tasks (entity extraction, summarization). */
    llmConfig?: {
      /** LLM provider name. */
      provider: string;
      /** Model name. */
      model?: string;
      /** API key for the LLM provider. */
      apiKey?: string;
      /** Temperature for generation. */
      temperature?: number;
    };
  };
  /**
   * Custom collections for application data storage.
   * Collections map to the graph structure (nodes + edges) with a developer-friendly CRUD interface.
   *
   * @example
   * ```ts
   * const customers = defineCollection({
   *   name: 'customer',
   *   schema: customerSchema,
   *   indexes: ['email'],
   * });
   *
   * const copilotz = await createCopilotz({
   *   agents: [...],
   *   collections: [customers],
   * });
   *
   * // Use collections
   * const db = copilotz.collections.withNamespace('tenant-123');
   * await db.customer.create({ email: 'alice@example.com' });
   * ```
   */
  // deno-lint-ignore no-explicit-any
  collections?: CollectionDefinition<any, any, any>[];
  /** Configuration options for collections. */
  collectionsConfig?: {
    /** Auto-create indexes on startup. Default: true */
    autoIndex?: boolean;
    /** Validate writes against schema. Default: false */
    validateOnWrite?: boolean;
  };
  /**
   * Multi-agent conversation configuration.
   * Controls how agents interact in threads with multiple participants.
   */
  multiAgent?: {
    /**
     * Whether multi-agent routing is enabled.
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
  /**
   * Remote skill URLs or inline skill definitions.
   * Merged with skills discovered from `resources.path` and default locations.
   *
   * @example
   * ```ts
   * skills: [
   *   "https://skills.example.com/create-agent/SKILL.md",
   *   { name: "my-skill", description: "...", content: "..." },
   * ]
   * ```
   */
  skills?: Array<
    string | {
      url?: string;
      name?: string;
      description?: string;
      content?: string;
    }
  >;
  /**
   * Security-related runtime hooks.
   * Use these to inject secrets or other runtime-only configuration without
   * persisting them in events or streaming them to clients.
   */
  security?: {
    /**
     * Resolve runtime-only LLM configuration, such as API keys, immediately
     * before an LLM provider call is made.
     */
    resolveLLMRuntimeConfig?: ResolveLLMRuntimeConfig;
  };
  /**
   * Base agent configuration applied to all agents.
   * Every loaded agent inherits from this; agent-specific fields override.
   *
   * - Scalars (model, provider, role): agent-specific wins, falls back to base
   * - `llmOptions`: deep-merge — base provides defaults, agent overrides specific fields
   * - Arrays (`allowedTools`): agent-specific replaces entirely (no merge)
   *
   * @example
   * ```ts
   * agent: {
   *   llmOptions: { provider: "openai", model: "gpt-4o", apiKey: "..." },
   * }
   * ```
   */
  agent?: Partial<AgentConfig>;
  /**
   * Automatically load local agent instructions from an AGENTS.md-style file
   * in the current working directory and append them to the active agent's prompt.
   * Enabled by default.
   */
  agentsFile?: boolean | AgentsFileConfig;
}

/**
 * Result returned from running a message through Copilotz.
 * Contains the queue ID, thread ID, status, event stream, and completion promise.
 */
export type CopilotzRunResult = RunHandle;

/** Reserved for future use - run-time overrides. */
export type CopilotzRunOverrides = never;

/**
 * Entry in the session history, containing the original message and its result.
 */
export interface CopilotzSessionHistoryEntry {
  /** The original message that was sent. */
  message: MessagePayload;
  /** The result from processing the message. */
  result: CopilotzRunResult;
}

/**
 * Interface for CLI input/output operations.
 */
export interface CopilotzCliIO {
  /**
   * Prompts the user for input.
   * @param message - The prompt message to display
   * @returns The user's input
   */
  prompt(message: string): Promise<string>;
  /**
   * Prints a line to the output.
   * @param line - The line to print
   */
  print(line: string): void;
}

/**
 * Controller for managing an interactive CLI session.
 */
export interface CopilotzCliController {
  /** Stops the CLI session. */
  stop(): void;
  /** Promise that resolves when the session is fully closed. */
  readonly closed: Promise<void>;
}

/**
 * Main Copilotz instance interface.
 * Provides methods for running messages, starting interactive sessions, and managing resources.
 */
export interface Copilotz {
  /** The frozen configuration used to create this instance. */
  readonly config: Readonly<CopilotzConfig>;
  /** Database operations for direct data access. */
  readonly ops: CopilotzDb["ops"];
  /**
   * Runs a message through the agent pipeline.
   * @param message - The message payload to process
   * @param options - Optional run configuration
   * @returns Promise resolving to the run result with event stream
   */
  run(
    message: MessagePayload,
    options?: RunOptions,
  ): Promise<CopilotzRunResult>;
  /**
   * Starts an interactive CLI session.
   * @param initialMessage - Optional initial message or configuration
   * @returns Controller for managing the session
   */
  start(
    initialMessage?:
      | (MessagePayload & {
        banner?: string | null;
        quitCommand?: string;
        threadExternalId?: string;
      })
      | string,
  ): CopilotzCliController;
  /** Shuts down the instance and releases resources. */
  shutdown(): Promise<void>;
  /** Asset utilities for working with stored files and media. */
  assets: {
    /**
     * Gets an asset as base64-encoded string.
     * @param refOrId - Asset reference (asset://id) or ID
     * @param options - Optional options (e.g., namespace)
     * @returns Base64 data and MIME type
     */
    getBase64: (
      refOrId: string,
      options?: { namespace?: string },
    ) => Promise<{ base64: string; mime: string }>;
    /**
     * Gets an asset as a data URL.
     * @param refOrId - Asset reference (asset://id) or ID
     * @param options - Optional options (e.g., namespace)
     * @returns Data URL string
     */
    getDataUrl: (
      refOrId: string,
      options?: { namespace?: string },
    ) => Promise<string>;
  };
  /**
   * Custom collections for application data storage.
   * Access collections with explicit namespace or use withNamespace() for scoped access.
   *
   * @example
   * ```ts
   * // Explicit namespace
   * await copilotz.collections.customer.create(data, { namespace: 'tenant-123' });
   *
   * // Scoped namespace (recommended)
   * const db = copilotz.collections.withNamespace('tenant-123');
   * await db.customer.create(data);
   * await db.customer.find({ plan: 'pro' });
   * await db.customer.search('enterprise companies');
   * ```
   */
  collections: CollectionsManager | undefined;

  /**
   * Schema management utilities for multi-tenant PostgreSQL schema isolation.
   * Use these methods to provision, check, and manage tenant schemas.
   *
   * @example
   * ```ts
   * // Provision a new tenant schema (creates all tables)
   * await copilotz.schema.provision('tenant_abc');
   *
   * // Check if a schema exists
   * if (await copilotz.schema.exists('tenant_abc')) {
   *   // Safe to use
   * }
   *
   * // Run with a specific schema
   * await copilotz.run(message, { schema: 'tenant_abc' });
   *
   * // Drop a tenant schema (WARNING: deletes all data!)
   * await copilotz.schema.drop('tenant_abc');
   * ```
   */
  schema: {
    /**
     * Provisions a new tenant schema with all required tables.
     * Idempotent - safe to call multiple times.
     * @param schemaName - Name of the schema to create
     */
    provision: (schemaName: string) => Promise<void>;
    /**
     * Drops a tenant schema and all its data.
     * WARNING: This permanently deletes all data in the schema!
     * @param schemaName - Name of the schema to drop
     */
    drop: (schemaName: string) => Promise<void>;
    /**
     * Checks if a schema exists in the database.
     * @param schemaName - Name of the schema to check
     * @returns true if the schema exists
     */
    exists: (schemaName: string) => Promise<boolean>;
    /**
     * Lists all tenant schemas (excludes system schemas).
     * @returns Array of schema names
     */
    list: () => Promise<string[]>;
    /**
     * Warms the schema cache by loading all existing schemas.
     * Call during startup to avoid first-request latency for existing tenants.
     */
    warmCache: () => Promise<void>;
  };
}

/**
 * Collections manager interface with dynamic collection access.
 * Access collections by name: `manager.customer`, `manager.order`, etc.
 * Use `withNamespace()` to get a scoped client with namespace pre-applied.
 *
 * Note: The index signature allows accessing any collection by name.
 * TypeScript will show methods and collections together in autocomplete.
 */
export interface CollectionsManager {
  /** Get a scoped client with namespace pre-applied to all operations. */
  withNamespace(namespace: string): ScopedCollectionsManager;
  /** List all registered collection names. */
  getCollectionNames(): string[];
  /** Check if a collection exists. */
  hasCollection(name: string): boolean;
  /** Access collections by name. */
  [collectionName: string]: CollectionCrud<unknown, unknown> | unknown;
}

/**
 * Scoped collections manager with namespace pre-applied.
 * Access collections by name: `scoped.customer`, `scoped.order`, etc.
 */
export interface ScopedCollectionsManager {
  /** Access scoped collections by name. */
  [collectionName: string]: ScopedCollectionCrud<unknown, unknown>;
}

/**
 * Creates a new Copilotz instance with the provided configuration.
 *
 * This is the main entry point for using Copilotz. It initializes the database,
 * sets up agents, tools, and processors, and returns an instance ready for use.
 *
 * @param config - Configuration options for the Copilotz instance
 * @returns Promise resolving to a configured Copilotz instance
 *
 * @example
 * ```ts
 * const copilotz = await createCopilotz({
 *   agents: [{
 *     id: "assistant",
 *     name: "Assistant",
 *     role: "A helpful AI assistant",
 *     instructions: "Help users with their questions.",
 *     llmOptions: { provider: "openai", model: "gpt-4" }
 *   }],
 *   stream: true
 * });
 *
 * const result = await copilotz.run({
 *   content: "What is the weather today?",
 *   sender: { type: "user", name: "User" }
 * });
 *
 * for await (const event of result.events) {
 *   console.log(event.type, event.payload);
 * }
 * ```
 */
// ============================================
// DB CONNECTION CACHE
// ============================================

const _dbConnectionCache = new Map<
  string,
  { db: CopilotzDb; refCount: number }
>();
const isInitDebugEnabled = () => Deno.env.get("COPILOTZ_INIT_DEBUG") === "1";
const elapsedMs = (startedAt: number) =>
  Number((performance.now() - startedAt).toFixed(1));

export async function createCopilotz(
  config: CopilotzConfig,
): Promise<Copilotz> {
  const initDebug = isInitDebugEnabled();
  const initStartedAt = performance.now();
  const logInit = (
    phase: string,
    startedAt: number,
    extra?: Record<string, unknown>,
  ) => {
    if (!initDebug) return;
    console.log("[copilotz:init]", {
      phase,
      elapsedMs: elapsedMs(startedAt),
      ...(extra ?? {}),
    });
  };

  // ---- Phase 1: Load bundled + user resources via unified resource loader ----
  let startedAt = performance.now();

  // 1a. Load bundled resources from the library's own resources/ directory
  const bundledResourcesUrl = new URL("./resources/", import.meta.url).href;
  const bundledPresets = Array.from(
    new Set(["core", ...(config.resources?.preset ?? [])]),
  );
  const bundledImports = config.resources?.imports;
  const bundledResources = await loadResources({
    path: bundledResourcesUrl,
    preset: bundledPresets,
    imports: bundledImports,
  });
  logInit("loadBundledResources", startedAt, {
    agents: bundledResources.agents?.length ?? 0,
    tools: bundledResources.tools?.length ?? 0,
    memory: bundledResources.memory?.length ?? 0,
    processors: bundledResources.processors?.length ?? 0,
    skills: bundledResources.skills?.length ?? 0,
  });

  // 1b. Load user resources (if path provided)
  let userResources: Resources | undefined;
  if (config.resources?.path) {
    startedAt = performance.now();
    userResources = await loadResources({
      path: config.resources.path,
      preset: config.resources.preset,
    });
    logInit("loadUserResources", startedAt, {
      path: config.resources.path,
      agents: userResources.agents?.length ?? 0,
      tools: userResources.tools?.length ?? 0,
      apis: userResources.apis?.length ?? 0,
      memory: userResources.memory?.length ?? 0,
      mcpServers: userResources.mcpServers?.length ?? 0,
      skills: userResources.skills?.length ?? 0,
      processors: userResources.processors?.length ?? 0,
    });

    if (config.resources.watch) {
      console.warn(
        "[copilotz] resources.watch is reserved for future use and has no effect yet.",
      );
    }
  }

  // 1c. Merge resources: user/config win on ID collision over bundled.
  //     User-defined resources appear first (higher priority for routing).
  //     Bundled resources fill in non-colliding entries after.
  startedAt = performance.now();
  let resolvedAgents = mergeResourceArrays<AgentConfig>(
    bundledResources.agents ?? [],
    mergeResourceArrays<AgentConfig>(
      userResources?.agents ?? [],
      config.agents,
    ),
    { prioritize: "explicit" },
  );
  let resolvedTools = mergeResourceArrays<ToolConfig>(
    bundledResources.tools as ToolConfig[] ?? [],
    mergeResourceArrays<ToolConfig>(
      userResources?.tools as ToolConfig[] ?? [],
      config.tools,
    ),
    { prioritize: "explicit" },
  );
  let resolvedApis = mergeResourceArrays<APIConfig>(
    bundledResources.apis as APIConfig[] ?? [],
    mergeResourceArrays<APIConfig>(
      userResources?.apis as APIConfig[] ?? [],
      config.apis,
    ),
    { prioritize: "explicit" },
  );
  let resolvedMcpServers = mergeResourceArrays<MCPServerConfig>(
    bundledResources.mcpServers as MCPServerConfig[] ?? [],
    mergeResourceArrays<MCPServerConfig>(
      userResources?.mcpServers as MCPServerConfig[] ?? [],
      config.mcpServers,
    ),
    { prioritize: "explicit" },
  );
  let resolvedCollections = mergeResourceArrays<
    CollectionDefinition
  >(
    (bundledResources.collections as CollectionDefinition[] | undefined) ?? [],
    mergeResourceArrays<CollectionDefinition>(
      (userResources?.collections as CollectionDefinition[] | undefined) ?? [],
      config.collections,
    ),
    { prioritize: "explicit" },
  );

  let resolvedProcessors = [
    // User/config processors first (higher priority), built-in last
    ...(userResources?.processors ?? []),
    ...(config.processors ?? []),
    ...(bundledResources.processors ?? []),
  ];

  // 1d. Resolve features (user/config first, bundled last — merge on name)
  const resolvedFeatures = [
    ...(userResources?.features ?? []),
    ...(config.features ?? []),
    ...(bundledResources.features ?? []),
  ];
  // Deduplicate by name (first wins)
  const featuresByName = new Map<string, (typeof resolvedFeatures)[0]>();
  for (const f of resolvedFeatures) {
    if (!featuresByName.has(f.name)) {
      featuresByName.set(f.name, f);
    }
  }
  let mergedFeatures = [...featuresByName.values()];

  // 1e. Resolve channels (user/config first, bundled last — first wins per side)
  let mergedChannels = mergeChannelEntries(
    userResources?.channels,
    config.channels,
    bundledResources.channels,
  );
  const mergeNamed = <T extends { name: string }>(
    bundled: T[] | undefined,
    user: T[] | undefined,
  ): T[] => {
    const merged: T[] = [];
    const seen = new Set<string>();
    for (const entry of [...(user ?? []), ...(bundled ?? [])]) {
      if (!seen.has(entry.name)) {
        merged.push(entry);
        seen.add(entry.name);
      }
    }
    return merged;
  };
  let resolvedLlmProviders = mergeNamed<LoadedLlmProvider>(
    bundledResources.llm,
    userResources?.llm,
  );
  let resolvedEmbeddingProviders = mergeNamed<LoadedEmbeddingProvider>(
    bundledResources.embeddings,
    userResources?.embeddings,
  );
  let resolvedStorageAdapters = mergeNamed<LoadedStorageAdapter>(
    bundledResources.storage,
    userResources?.storage,
  );
  let resolvedMemory = mergeNamed<MemoryResource>(
    bundledResources.memory,
    mergeNamed<MemoryResource>(userResources?.memory, config.memory),
  );

  logInit("mergeResources", startedAt);

  // 1g. Resolve skills (bundled + project + explicit)
  const bundledSkills = bundledResources.skills ?? [];
  const projectSkills = userResources?.skills ?? [];

  startedAt = performance.now();
  const explicitSkills: Skill[] = [];
  if (config.skills) {
    for (const s of config.skills) {
      try {
        if (typeof s === "string") {
          explicitSkills.push(await loadSkillFromUrl(s));
        } else if (s.url) {
          explicitSkills.push(await loadSkillFromUrl(s.url));
        } else if (s.name && s.content) {
          explicitSkills.push({
            name: s.name,
            description: s.description ?? "",
            content: s.content,
            source: "remote",
            sourcePath: "inline",
            hasReferences: false,
          });
        }
      } catch (err) {
        console.warn(
          `[copilotz] Failed to load skill: ${
            typeof s === "string" ? s : s.url ?? s.name
          }`,
          err,
        );
      }
    }
  }
  logInit("loadExplicitSkills", startedAt, {
    configured: config.skills?.length ?? 0,
    loaded: explicitSkills.length,
  });

  let allSkills = mergeSkills(
    projectSkills,
    explicitSkills,
    bundledSkills,
  );
  logInit("mergeSkills", startedAt, {
    totalSkills: allSkills.length,
    projectSkills: projectSkills.length,
  });

  // 1f. Apply filterResources callback
  const resourceFilter = config.resources?.filterResources;
  if (resourceFilter) {
    const filter = resourceFilter;
    const asFilterable = (r: unknown) =>
      r as { id?: string; name?: string; [key: string]: unknown };
    resolvedAgents = resolvedAgents.filter((r) =>
      filter(asFilterable(r), "agent")
    );
    resolvedTools = resolvedTools.filter((r) =>
      filter(asFilterable(r), "tool")
    );
    resolvedApis = resolvedApis.filter((r) => filter(asFilterable(r), "api"));
    resolvedMcpServers = resolvedMcpServers.filter((r) =>
      filter(asFilterable(r), "mcpServer")
    );
    resolvedMemory = resolvedMemory.filter((r) =>
      filter(asFilterable(r), "memory")
    );
    resolvedProcessors = resolvedProcessors.filter((r) =>
      filter(asFilterable(r), "processor")
    );
    allSkills = allSkills.filter((r) => filter(asFilterable(r), "skill"));
    mergedFeatures = mergedFeatures.filter((r) =>
      filter(asFilterable(r), "feature")
    );
    mergedChannels = mergedChannels.filter((r) =>
      filter(asFilterable(r), "channel")
    );
    resolvedLlmProviders = resolvedLlmProviders.filter((r) =>
      filter(asFilterable(r), "llm")
    );
    resolvedEmbeddingProviders = resolvedEmbeddingProviders.filter((r) =>
      filter(asFilterable(r), "embedding")
    );
    resolvedStorageAdapters = resolvedStorageAdapters.filter((r) =>
      filter(asFilterable(r), "storage")
    );
    resolvedCollections = resolvedCollections.filter((r) =>
      filter(asFilterable(r), "collection")
    );
    logInit("filterResources", startedAt);
  }

  mergedChannels = decorateChannelEntries(
    mergedChannels,
    config.resources?.overrides?.channels,
  ) ?? mergedChannels;

  // 1g. Apply agent base config (only when explicitly provided)
  if (config.agent) {
    const base = config.agent;
    resolvedAgents = resolvedAgents.map((agent) => ({
      ...base,
      ...agent,
      llmOptions: agent.llmOptions
        ? { ...base.llmOptions, ...agent.llmOptions }
        : base.llmOptions,
    } as AgentConfig));
  }

  if (resolvedAgents.length === 0) {
    throw new Error(
      "createCopilotz requires at least one agent. " +
        "Provide agents explicitly, via resources.path, or import a bundled agent such as resources.imports: ['agents.copilotz'].",
    );
  }

  // ---- Phase 2: Normalize resources ----
  startedAt = performance.now();
  const normalizedAgents = resolvedAgents.map(normalizeAgent);
  const normalizedTools = resolvedTools?.map(normalizeTool);
  const normalizedApis = resolvedApis?.map(normalizeApi);
  const normalizedMcpServers = resolvedMcpServers?.map(normalizeMcpServer);
  const llmProviderRegistry = Object.fromEntries(
    resolvedLlmProviders.map((entry) => [entry.name, entry.factory]),
  );
  const embeddingProviderRegistry = Object.fromEntries(
    resolvedEmbeddingProviders.map((entry) => [entry.name, entry.factory]),
  );
  const availableStorageBackends = resolvedStorageAdapters.map((entry) =>
    entry.name
  );

  const baseConfig: NormalizedCopilotzConfig = {
    ...config,
    agents: normalizedAgents,
    tools: normalizedTools,
    apis: normalizedApis,
    mcpServers: normalizedMcpServers,
    memory: resolvedMemory,
    collections: resolvedCollections,
    skills: allSkills,
    features: mergedFeatures,
    channels: mergedChannels,
  };
  logInit("normalizeResources", startedAt, {
    agents: normalizedAgents.length,
    tools: normalizedTools?.length ?? 0,
    apis: normalizedApis?.length ?? 0,
    mcpServers: normalizedMcpServers?.length ?? 0,
    memory: resolvedMemory.length,
  });

  // ---- Phase 3: Resolve database (with connection caching) ----
  const dbCacheKey = config.dbConfig?.url ?? ":memory:";
  let managedDb: CopilotzDb | undefined;
  let fromCache = false;
  startedAt = performance.now();

  if (config.dbInstance) {
    managedDb = undefined;
  } else if (dbCacheKey !== ":memory:" && _dbConnectionCache.has(dbCacheKey)) {
    const cached = _dbConnectionCache.get(dbCacheKey)!;
    cached.refCount++;
    managedDb = cached.db;
    fromCache = true;
  } else {
    const indexStatements: string[] = [];
    if (config.collectionsConfig?.autoIndex !== false) {
      for (const def of resolvedCollections) {
        indexStatements.push(...generateCollectionIndexes(def));
      }
    }

    managedDb = await createDatabase({
      ...config.dbConfig,
      schemaSQL: [...(config.dbConfig?.schemaSQL || []), ...indexStatements],
      staleProcessingThresholdMs: config.staleProcessingThresholdMs ??
        config.dbConfig?.staleProcessingThresholdMs,
    });
    if (dbCacheKey !== ":memory:" && managedDb) {
      _dbConnectionCache.set(dbCacheKey, { db: managedDb, refCount: 1 });
    }
  }
  logInit("resolveDatabase", startedAt, {
    cacheKey: dbCacheKey,
    fromCache,
    usedProvidedInstance: Boolean(config.dbInstance),
  });

  const baseDb = config.dbInstance ?? managedDb;
  if (!baseDb) {
    throw new Error("Failed to initialize Copilotz database instance.");
  }
  const baseOps = baseDb.ops;

  // Build unified processor map (order preserved: user/config first, built-in last)
  if (Array.isArray(resolvedProcessors) && resolvedProcessors.length > 0) {
    const byType: Record<
      string,
      Array<EventProcessor<unknown, ProcessorDeps>>
    > = {};
    for (const p of resolvedProcessors) {
      if (!p || typeof p !== "object") continue;
      const eventType = (p as { eventType?: string }).eventType;
      if (
        !eventType ||
        typeof (p as EventProcessor<unknown, ProcessorDeps>).shouldProcess !==
          "function" ||
        typeof (p as EventProcessor<unknown, ProcessorDeps>).process !==
          "function"
      ) continue;
      const key = String(eventType).toUpperCase();
      if (!byType[key]) byType[key] = [];
      byType[key].push(p as EventProcessor<unknown, ProcessorDeps>);
    }
    baseConfig.processorsByType = byType;
  }

  // Normalize asset config: passthrough backend implies resolveInLLM: false
  let normalizedAssetConfig: AssetConfig | undefined = undefined;
  if (config.assets?.config) {
    const srcConfig = config.assets.config;
    if (
      srcConfig.backend &&
      srcConfig.backend !== "memory" &&
      srcConfig.backend !== "passthrough" &&
      !availableStorageBackends.includes(srcConfig.backend)
    ) {
      throw new Error(
        `Asset storage backend "${srcConfig.backend}" is not loaded. ` +
          `Add it via resources.preset/resources.imports before using it.`,
      );
    }
    normalizedAssetConfig = {
      inlineThresholdBytes: srcConfig.inlineThresholdBytes,
      resolveInLLM: srcConfig.backend === "passthrough"
        ? false
        : srcConfig.resolveInLLM,
      backend: srcConfig.backend,
      fs: srcConfig.fs,
      s3: srcConfig.s3,
      namespacing: srcConfig.namespacing,
    };
  }

  const staticAssetStore = (config.assets && config.assets.store)
    ? config.assets.store
    : undefined;
  const assetStoreCache = new Map<string, AssetStore>();

  const getAssetStoreForNamespace = (contextNamespace?: string): AssetStore => {
    if (staticAssetStore) return staticAssetStore;
    const resolved = resolveAssetNamespace(
      normalizedAssetConfig,
      contextNamespace,
    );
    const cached = assetStoreCache.get(resolved.cacheKey);
    if (cached) return cached;
    const store = normalizedAssetConfig
      ? createAssetStoreForNamespace(normalizedAssetConfig, contextNamespace)
      : createMemoryAssetStore();
    assetStoreCache.set(resolved.cacheKey, store);
    return store;
  };

  // Initialize collections if defined
  startedAt = performance.now();
  let collectionsManager: CollectionsManager | undefined = undefined;
  if (resolvedCollections.length > 0) {
    // Create embedding function for collections search
    const collectionEmbeddingFn = config.rag?.embedding
      ? async (text: string): Promise<number[]> => {
        // Import embedding connector dynamically to avoid circular deps
        const { embed } = await import("@/runtime/embeddings/index.ts");
        const result = await embed(
          [text],
          config.rag!.embedding,
          {},
          embeddingProviderRegistry,
        );
        return result.embeddings[0] ?? [];
      }
      : undefined;

    // Create collections manager
    collectionsManager = createCollectionsManager(
      baseDb,
      resolvedCollections,
      {
        embeddingFn: collectionEmbeddingFn,
        autoIndex: config.collectionsConfig?.autoIndex ?? true,
        validateOnWrite: config.collectionsConfig?.validateOnWrite ?? false,
      },
    ) as unknown as CollectionsManager;
  }
  logInit("initializeCollections", startedAt, {
    collections: resolvedCollections.length,
    hasManager: Boolean(collectionsManager),
  });

  const performRun = async (
    message: MessagePayload,
    options?: RunOptions,
  ): Promise<CopilotzRunResult> => {
    const normalizedMessage = normalizeInboundRunMessage(message);

    if (!hasRunInput(normalizedMessage)) {
      throw new Error("message with content or toolCalls is required.");
    }

    // Resolve schema: RunOptions > DbConfig > undefined
    // When set, all queries will execute in the specified schema
    const resolvedSchema = options?.schema ?? config.dbConfig?.defaultSchema;

    // Resolve namespace: RunOptions > CopilotzConfig > undefined
    const resolvedNamespace = options?.namespace ?? config.namespace;

    // Resolve collections: scoped with namespace (defaulting to "global" if none provided)
    const resolvedCollections = collectionsManager
      ? collectionsManager.withNamespace(resolvedNamespace ?? "global")
      : undefined;

    // Resolve agents: RunOptions > CopilotzConfig
    // If RunOptions provides agents, they completely override config agents
    const resolvedAgents = options?.agents ?? baseConfig.agents;

    // Resolve tools: RunOptions > CopilotzConfig
    // If RunOptions provides tools, they completely override config tools
    const resolvedTools = options?.tools ?? baseConfig.tools;

    const assetStoreForRun = getAssetStoreForNamespace(resolvedNamespace);
    const agentsFileInstructions = await loadAgentsFileInstructions(
      config.agentsFile,
    );

    const ctx: ChatContext = {
      agents: resolvedAgents,
      tools: resolvedTools,
      apis: baseConfig.apis,
      mcpServers: baseConfig.mcpServers,
      memory: baseConfig.memory,
      skills: baseConfig.skills,
      historyTransform: baseConfig.historyTransform,
      dbConfig: baseConfig.dbConfig,
      dbInstance: baseDb,
      threadMetadata: baseConfig.threadMetadata,
      queueTTL: baseConfig.queueTTL,
      stream: options?.stream ?? baseConfig.stream ?? true,
      processors: baseConfig.processorsByType,
      assetStore: assetStoreForRun,
      assetConfig: normalizedAssetConfig,
      resolveAsset: async (ref: string) => {
        const id = resolveAssetIdForStore(ref, assetStoreForRun);
        return await assetStoreForRun.get(id);
      },
      // RAG configuration
      ragConfig: config.rag
        ? {
          enabled: config.rag.enabled ?? true,
          embedding: config.rag.embedding,
          chunking: config.rag.chunking,
          retrieval: config.rag.retrieval,
          defaultNamespace: config.rag.defaultNamespace,
          llmConfig: config.rag.llmConfig,
        }
        : undefined,
      embeddingConfig: config.rag?.embedding,
      llmProviders: llmProviderRegistry,
      embeddingProviders: embeddingProviderRegistry,
      storageBackends: availableStorageBackends,
      security: baseConfig.security,
      // Resolved namespace for this run
      namespace: resolvedNamespace,
      // Collections: scoped if namespace is set, otherwise raw manager
      collections: resolvedCollections,
      agentsFileInstructions,
      // Sender of the current message (available to processors and tools)
      sender: normalizedMessage.sender
        ? {
          id: normalizedMessage.sender.id ?? null,
          externalId: normalizedMessage.sender.externalId ?? null,
          type: normalizedMessage.sender.type ?? "user",
          name: normalizedMessage.sender.name ?? null,
          metadata: normalizedMessage.sender.metadata ?? null,
        }
        : undefined,
      // Multi-agent routing is opt-in. Without explicit config, agent replies
      // should go back to the original sender instead of delegating via @mentions.
      multiAgent: config.multiAgent
        ? {
          enabled: config.multiAgent.enabled ?? true,
          maxAgentTurns: config.multiAgent.maxAgentTurns ?? 5,
          includeTargetContext: config.multiAgent.includeTargetContext ?? true,
        }
        : undefined,
    };

    // If schema is specified, wrap execution in schema context
    // This sets the search_path for all queries within this run
    if (resolvedSchema && resolvedSchema !== "public") {
      return withSchema(resolvedSchema, async () => {
        return await runThread(
          baseDb,
          ctx,
          normalizedMessage,
          options,
        );
      });
    }

    return await runThread(baseDb, ctx, normalizedMessage, options);
  };

  const copilotz = {
    config: Object.freeze({ ...baseConfig }),
    get ops() {
      return baseOps;
    },
    run: performRun,
    start: (
      initialMessage?:
        | (MessagePayload & {
          banner?: string | null;
          quitCommand?: string;
          threadExternalId?: string;
        })
        | string,
    ) =>
      startInteractiveCli({
        performRun: (message, runOptions) => performRun(message, runOptions),
        initialMessage,
        agents: baseConfig.agents.map((agent) => ({
          id: typeof agent.id === "string" ? agent.id : undefined,
          name: agent.name,
          role: agent.role,
        })),
        tools: baseConfig.tools?.map((tool) => ({
          id: typeof tool.id === "string" ? tool.id : undefined,
          key: tool.key,
          name: tool.name,
        })),
        banner: typeof defaultBanner === "string" ? defaultBanner : null,
        cwd: (() => {
          try {
            return Deno.cwd();
          } catch {
            return undefined;
          }
        })(),
      }),
    shutdown: async () => {
      if (managedDb) {
        if (fromCache) {
          const cached = _dbConnectionCache.get(dbCacheKey);
          if (cached) {
            cached.refCount--;
            if (cached.refCount <= 0) {
              _dbConnectionCache.delete(dbCacheKey);
            } else {
              return; // Other instances still using this connection
            }
          }
        }
        const resource = managedDb as unknown as {
          close?: () => Promise<void> | void;
          end?: () => Promise<void> | void;
        };
        if (typeof resource.close === "function") {
          await resource.close.call(resource);
        } else if (typeof resource.end === "function") {
          await resource.end.call(resource);
        }
      }
    },
    assets: {
      getBase64: async (refOrId: string, options?: { namespace?: string }) => {
        const store = getAssetStoreForNamespace(
          options?.namespace ?? config.namespace,
        );
        const id = resolveAssetIdForStore(refOrId, store);
        const { bytes, mime } = await store.get(id);
        const base64 = bytesToBase64(bytes);
        return { base64, mime };
      },
      getDataUrl: async (refOrId: string, options?: { namespace?: string }) => {
        const store = getAssetStoreForNamespace(
          options?.namespace ?? config.namespace,
        );
        const id = resolveAssetIdForStore(refOrId, store);
        const { bytes, mime } = await store.get(id);
        const base64 = bytesToBase64(bytes);
        return `data:${mime};base64,${base64}`;
      },
    },
    collections: collectionsManager,
    schema: {
      provision: (schemaName: string) =>
        provisionTenantSchema(baseDb, schemaName),
      drop: (schemaName: string) => dropTenantSchema(baseDb, schemaName),
      exists: (schemaName: string) => schemaExists(baseDb, schemaName),
      list: () => listTenantSchemas(baseDb),
      warmCache: () => warmSchemaCache(baseDb),
    },
  } satisfies Copilotz;
  logInit("createCopilotzTotal", initStartedAt);
  return copilotz;
}
