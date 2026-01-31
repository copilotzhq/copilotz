
import { 
    createDatabase, 
    schema, 
    migrations, 
    createCollectionsManager, 
    createCollectionIndexes,
    withSchema,
    provisionTenantSchema,
    dropTenantSchema,
    schemaExists,
    listTenantSchemas,
    warmSchemaCache,
} from "@/database/index.ts";
import type { OminipgWithCrud } from "omnipg";
import { runThread, type RunHandle, type RunOptions, type UnifiedOnEvent } from "@/runtime/index.ts";
import type { CollectionDefinition, CollectionCrud, ScopedCollectionCrud } from "@/database/collections/types.ts";

import type {
    Agent,
    API,
    ChatCallbacks,
    ChatContext,
    EventProcessor,
    ProcessorDeps,
    CopilotzDb,
    DatabaseConfig,
    MCPServer,
    MessagePayload,
    Tool,
    ToolCallEventPayload,
    LlmCallEventPayload,
    TokenEventPayload,
} from "./interfaces/index.ts";


import defaultBanner from "@/runtime/banner.ts";

export type {
    /** AI Agent configuration with LLM options and capabilities. */
    Agent,
    /** API configuration for connecting to external REST APIs via OpenAPI. */
    API,
    /** MCP (Model Context Protocol) server configuration. */
    MCPServer,
    /** Tool definition with input/output schemas for agent capabilities. */
    Tool,
    /** Conversation thread containing messages between users and agents. */
    Thread,
    /** Individual message within a conversation thread. */
    Message,
    /** Task definition for goal-oriented agent workflows. */
    Task,
    /** User entity representing a conversation participant. */
    User,
    /** Event in the event queue system. */
    Event,
    /** New event to be created in the event queue. */
    NewEvent,
    /** Specific NEW_MESSAGE event type with typed payload. */
    NewMessageEvent,
    /** Specific TOOL_CALL event type with typed payload. */
    ToolCallEvent,
    /** Specific LLM_CALL event type with typed payload. */
    LlmCallEvent,
    /** Input type for creating a new Agent. */
    NewAgent,
    /** Input type for creating a new API configuration. */
    NewAPI,
    /** Input type for creating a new MCP server configuration. */
    NewMCPServer,
    /** Input type for creating a new Tool. */
    NewTool,
    /** Input type for creating a new Thread. */
    NewThread,
    /** Input type for creating a new Message. */
    NewMessage,
    /** Input type for creating a new Task. */
    NewTask,
    /** Input type for creating a new User. */
    NewUser,
    /** Payload structure for incoming messages. */
    MessagePayload,
    /** Payload structure for tool call events. */
    ToolCallEventPayload,
    /** Payload structure for LLM call events. */
    LlmCallEventPayload,
    /** Payload structure for streaming token events. */
    TokenEventPayload,
    /** Configuration options for the database connection. */
    DatabaseConfig,
    /** Database instance with CRUD operations and custom ops. */
    CopilotzDb,
    /** Low-level database instance type from Ominipg. */
    DbInstance,
    /** Interface for custom event processors. */
    EventProcessor,
    /** Dependencies injected into event processors. */
    ProcessorDeps,
    /** Callback functions for handling chat events. */
    ChatCallbacks,
    /** Context object passed through the chat pipeline. */
    ChatContext,
    /** Data structure for streaming content tokens. */
    ContentStreamData,
    /** Configuration for RAG (Retrieval-Augmented Generation). */
    RagConfig,
    /** Configuration for embedding generation. */
    EmbeddingConfig,
    /** Configuration for entity extraction. */
    EntityExtractionConfig,
    /** Context for namespace resolution. */
    NamespaceResolutionContext,
    /** Configuration for document chunking strategies. */
    ChunkingConfig,
    /** Configuration for similarity-based retrieval. */
    RetrievalConfig,
    /** RAG options specific to an agent. */
    AgentRagOptions,
    /** Document stored in the RAG knowledge base. */
    Document,
    /** Input type for creating a new Document. */
    NewDocument,
    /** Chunk of a document with embedding vector. */
    DocumentChunk,
    /** Input type for creating a new DocumentChunk. */
    NewDocumentChunk,
} from "@/interfaces/index.ts";

/**
 * Returns a record of all built-in native tools available to agents.
 * Native tools include file operations, HTTP requests, task management, and more.
 * 
 * @returns Record of tool names to tool definitions
 */
export { getNativeTools } from "@/event-processors/tool_call/native-tools-registry/index.ts";

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
    provisionTenantSchema,
    dropTenantSchema,
    schemaExists,
    listTenantSchemas,
    warmSchemaCache,
    clearSchemaCache,
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
export { defineCollection, relation, index } from "@/database/collections/index.ts";

/** Type definitions for collections API. */
export type {
    CollectionDefinition,
    CollectionCrud,
    ScopedCollectionCrud,
    CollectionsConfig,
    WhereFilter,
    WhereOperators,
    QueryOptions,
    SearchOptions,
    IndexDefinition,
    RelationDefinition,
} from "@/database/collections/types.ts";

/**
 * Registers a custom event processor for handling specific event types.
 * Use this to extend Copilotz with custom event handling logic.
 * 
 * @param type - The event type to handle (e.g., "NEW_MESSAGE", "TOOL_CALL")
 * @param processor - The processor implementation
 */
export { registerEventProcessor } from "@/event-processors/index.ts";

/**
 * Resolves a namespace based on scope and optional prefix.
 * Use for multi-tenancy and entity scope resolution.
 */
export { resolveNamespace } from "@/interfaces/index.ts";

/** Event emitted from the streaming event queue. */
export type { StreamEvent } from "@/runtime/index.ts";

import type { AssetStore, AssetConfig } from "@/utils/assets.ts";
import { createMemoryAssetStore, createAssetStore, bytesToBase64 } from "@/utils/assets.ts";

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
export { default as loadResources } from "@/utils/loaders/resources.ts";

/**
 * Union type representing all possible events in the Copilotz event system.
 * Used for type-safe event handling in callbacks and processors.
 */
export type CopilotzEvent =
    | { type: "NEW_MESSAGE"; payload: MessagePayload }
    | { type: "TOOL_CALL"; payload: ToolCallEventPayload }
    | { type: "LLM_CALL"; payload: LlmCallEventPayload }
    | { type: "TOKEN"; payload: TokenEventPayload };

/** Alias for Agent type, used in configuration. */
export type AgentConfig = Agent; 

/** Alias for Tool type, used in configuration. */
export type ToolConfig = Tool;

/** Alias for API type, used in configuration. */
export type APIConfig = API;

/** Alias for MCPServer type, used in configuration. */
export type MCPServerConfig = MCPServer;

type NormalizedCopilotzConfig = Omit<CopilotzConfig, "agents" | "tools" | "apis" | "mcpServers"> & {
    agents: Agent[];
    tools?: Tool[];
    apis?: API[];
    mcpServers?: MCPServer[];
    customProcessorsByType?: ChatContext["customProcessors"];
};

function normalizeAgent(agent: AgentConfig): Agent {
    const now = new Date().toISOString();
    return {
        ...agent,
        createdAt: ("createdAt" in agent && agent.createdAt ? agent.createdAt : now) as Agent["createdAt"],
        updatedAt: ("updatedAt" in agent && agent.updatedAt ? agent.updatedAt : now) as Agent["updatedAt"],
    };
}

function normalizeTool(tool: ToolConfig): Tool {
    const now = new Date().toISOString();
    return {
        ...tool,
        createdAt: ("createdAt" in tool && tool.createdAt ? tool.createdAt : now) as Tool["createdAt"],
        updatedAt: ("updatedAt" in tool && tool.updatedAt ? tool.updatedAt : now) as Tool["updatedAt"],
    };
}

function normalizeApi(api: APIConfig): API {
    const now = new Date().toISOString();
    return {
        ...api,
        createdAt: ("createdAt" in api && api.createdAt ? api.createdAt : now) as API["createdAt"],
        updatedAt: ("updatedAt" in api && api.updatedAt ? api.updatedAt : now) as API["updatedAt"],
    };
}

function normalizeMcpServer(server: MCPServerConfig): MCPServer {
    const now = new Date().toISOString();
    return {
        ...server,
        createdAt: ("createdAt" in server && server.createdAt ? server.createdAt : now) as MCPServer["createdAt"],
        updatedAt: ("updatedAt" in server && server.updatedAt ? server.updatedAt : now) as MCPServer["updatedAt"],
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
    /** Array of agent configurations. At least one agent is required. */
    agents: AgentConfig[];
    /** Optional array of custom tool definitions. */
    tools?: ToolConfig[];
    /** Optional array of API configurations for external REST APIs. */
    apis?: APIConfig[];
    /** Optional array of MCP server configurations. */
    mcpServers?: MCPServerConfig[];
    /** Optional custom event processors to extend or override default behavior. */
    processors?: Array<(EventProcessor<unknown, ProcessorDeps> & { eventType: string; priority?: number; id?: string })>;
    /** Optional callbacks for handling events during execution. */
    callbacks?: ChatCallbacks;
    /** Optional database configuration. Defaults to in-memory PGlite. */
    dbConfig?: DatabaseConfig;
    /** Optional pre-existing database instance to reuse. */
    dbInstance?: CopilotzDb;
    /** Optional metadata to attach to all threads. */
    threadMetadata?: Record<string, unknown>;
    /** Optional TTL (time-to-live) in milliseconds for queue items. */
    queueTTL?: number;
    /** Whether to enable streaming mode for real-time token output. */
    stream?: boolean;
    /** Optional active task ID for task-oriented workflows. */
    activeTaskId?: string;
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
     * @param onEvent - Optional callback for handling events
     * @param options - Optional run configuration
     * @returns Promise resolving to the run result with event stream
     */
    run(message: MessagePayload, onEvent?: UnifiedOnEvent, options?: RunOptions): Promise<CopilotzRunResult>;
    /**
     * Starts an interactive CLI session.
     * @param initialMessage - Optional initial message or configuration
     * @param onEvent - Optional callback for handling events
     * @returns Controller for managing the session
     */
    start(initialMessage?: (MessagePayload & { banner?: string | null; quitCommand?: string; threadExternalId?: string }) | string, onEvent?: UnifiedOnEvent): CopilotzCliController;
    /** Shuts down the instance and releases resources. */
    shutdown(): Promise<void>;
    /** Asset utilities for working with stored files and media. */
    assets: {
        /** 
         * Gets an asset as base64-encoded string.
         * @param refOrId - Asset reference (asset://id) or ID
         * @returns Base64 data and MIME type
         */
        getBase64: (refOrId: string) => Promise<{ base64: string; mime: string }>;
        /** 
         * Gets an asset as a data URL.
         * @param refOrId - Asset reference (asset://id) or ID
         * @returns Data URL string
         */
        getDataUrl: (refOrId: string) => Promise<string>;
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
     * await copilotz.run(message, onEvent, { schema: 'tenant_abc' });
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
export async function createCopilotz(config: CopilotzConfig): Promise<Copilotz> {

    const normalizedAgents = config.agents.map(normalizeAgent);
    const normalizedTools = config.tools?.map(normalizeTool);
    const normalizedApis = config.apis?.map(normalizeApi);
    const normalizedMcpServers = config.mcpServers?.map(normalizeMcpServer);

    const baseConfig: NormalizedCopilotzConfig = {
        ...config,
        agents: normalizedAgents,
        tools: normalizedTools,
        apis: normalizedApis,
        mcpServers: normalizedMcpServers,
    };

    const managedDb = config.dbInstance ? undefined : await createDatabase(config.dbConfig);
    const baseDb = config.dbInstance ?? managedDb;
    if (!baseDb) {
        throw new Error("Failed to initialize Copilotz database instance.");
    }
    const baseOps = baseDb.ops;

    // Prepare custom processors map (order preserved; highest priority first in provided array)
    if (Array.isArray(config.processors) && config.processors.length > 0) {
        const byType: Record<string, Array<EventProcessor<unknown, ProcessorDeps>>> = {};
        for (const p of config.processors) {
            if (!p || typeof p !== "object") continue;
            const eventType = (p as { eventType?: string }).eventType;
            if (!eventType || typeof (p as EventProcessor<unknown, ProcessorDeps>).shouldProcess !== "function" || typeof (p as EventProcessor<unknown, ProcessorDeps>).process !== "function") continue;
            const key = String(eventType).toUpperCase();
            if (!byType[key]) byType[key] = [];
            byType[key].push(p as EventProcessor<unknown, ProcessorDeps>);
        }
        baseConfig.customProcessorsByType = byType;
    }

    // Normalize asset config: passthrough backend implies resolveInLLM: false
    let normalizedAssetConfig: AssetConfig | undefined = undefined;
    if (config.assets?.config) {
        const srcConfig = config.assets.config;
        normalizedAssetConfig = {
            inlineThresholdBytes: srcConfig.inlineThresholdBytes,
            resolveInLLM: srcConfig.backend === "passthrough" ? false : srcConfig.resolveInLLM,
            backend: srcConfig.backend,
            fs: srcConfig.fs,
            s3: srcConfig.s3,
        };
    }

    // Single asset store instance per Copilotz
    const assetStoreInstance = (config.assets && config.assets.store)
        ? config.assets.store
        : (normalizedAssetConfig ? createAssetStore(normalizedAssetConfig) : createMemoryAssetStore());

    // Initialize collections if defined
    let collectionsManager: CollectionsManager | undefined = undefined;
    if (config.collections && config.collections.length > 0) {
        // Create embedding function for collections search
        const collectionEmbeddingFn = config.rag?.embedding
            ? async (text: string): Promise<number[]> => {
                // Import embedding connector dynamically to avoid circular deps
                const { embed } = await import("@/connectors/embeddings/index.ts");
                const result = await embed([text], config.rag!.embedding);
                return result.embeddings[0] ?? [];
            }
            : undefined;

        // Create collections manager
        collectionsManager = createCollectionsManager(
            baseDb,
            config.collections,
            {
                embeddingFn: collectionEmbeddingFn,
                autoIndex: config.collectionsConfig?.autoIndex ?? true,
                validateOnWrite: config.collectionsConfig?.validateOnWrite ?? false,
            },
        ) as unknown as CollectionsManager;

        // Auto-create indexes if enabled
        if (config.collectionsConfig?.autoIndex !== false) {
            createCollectionIndexes(baseDb, config.collections).catch((error: unknown) => {
                console.warn("[collections] Failed to create indexes:", error);
            });
        }
    }

    const performRun = async (
        message: MessagePayload,
        onEvent?: UnifiedOnEvent,
        options?: RunOptions,
    ): Promise<CopilotzRunResult> => {
        if (!message?.content && !message?.toolCalls?.length) {
            throw new Error("message with content or toolCalls is required.");
        }

        // Resolve schema: RunOptions > DbConfig > undefined
        // When set, all queries will execute in the specified schema
        const resolvedSchema = options?.schema ?? config.dbConfig?.defaultSchema;

        // Resolve namespace: RunOptions > CopilotzConfig > undefined
        const resolvedNamespace = options?.namespace ?? config.namespace;

        // Resolve collections: scoped if namespace is set, otherwise raw manager
        const resolvedCollections = (resolvedNamespace && collectionsManager)
            ? collectionsManager.withNamespace(resolvedNamespace)
            : collectionsManager;

        // Resolve agents: RunOptions > CopilotzConfig
        // If RunOptions provides agents, they completely override config agents
        const resolvedAgents = options?.agents ?? baseConfig.agents;

        // Resolve tools: RunOptions > CopilotzConfig
        // If RunOptions provides tools, they completely override config tools
        const resolvedTools = options?.tools ?? baseConfig.tools;

        const ctx: ChatContext = {
            agents: resolvedAgents,
            tools: resolvedTools,
            apis: baseConfig.apis,
            mcpServers: baseConfig.mcpServers,
            callbacks: baseConfig.callbacks,
            dbConfig: baseConfig.dbConfig,
            dbInstance: baseDb,
            threadMetadata: baseConfig.threadMetadata,
            queueTTL: baseConfig.queueTTL,
            stream: options?.stream ?? baseConfig.stream ?? false,
            activeTaskId: baseConfig.activeTaskId,
            customProcessors: baseConfig.customProcessorsByType,
            assetStore: assetStoreInstance,
            assetConfig: normalizedAssetConfig,
            resolveAsset: async (ref: string) => {
                const id = ref.startsWith("asset://") ? ref.slice("asset://".length) : ref;
                return await assetStoreInstance.get(id);
            },
            // RAG configuration
            ragConfig: config.rag ? {
                enabled: config.rag.enabled ?? true,
                embedding: config.rag.embedding,
                chunking: config.rag.chunking,
                retrieval: config.rag.retrieval,
                defaultNamespace: config.rag.defaultNamespace,
            } : undefined,
            embeddingConfig: config.rag?.embedding,
            // Resolved namespace for this run
            namespace: resolvedNamespace,
            // Collections: scoped if namespace is set, otherwise raw manager
            collections: resolvedCollections,
            // Sender of the current message (available to processors and tools)
            sender: message.sender ? {
                id: message.sender.id ?? null,
                externalId: message.sender.externalId ?? null,
                type: message.sender.type ?? "user",
                name: message.sender.name ?? null,
                metadata: message.sender.metadata ?? null,
            } : undefined,
        };

        // If schema is specified, wrap execution in schema context
        // This sets the search_path for all queries within this run
        if (resolvedSchema && resolvedSchema !== 'public') {
            return withSchema(resolvedSchema, async () => {
                return await runThread(baseDb, ctx, message, onEvent, options);
            });
        }

        return await runThread(baseDb, ctx, message, onEvent, options);
    };

    return {
        config: Object.freeze({ ...baseConfig }),
        get ops() {
            return baseOps;
        },
        run: performRun,
        start: (initialMessage?: (MessagePayload & { banner?: string | null; quitCommand?: string; threadExternalId?: string }) | string, onEvent?: UnifiedOnEvent) => {
            let quitCommand = "quit";
            let banner: string | null = typeof defaultBanner === "string" ? defaultBanner : null;
            let threadExternalId = crypto.randomUUID().slice(0, 24);
            let sessionSender: MessagePayload["sender"] | undefined = { type: "user", name: "user" };
            let sessionParticipants: string[] | undefined = undefined;

            if (initialMessage && typeof initialMessage === "object") {
                if (typeof (initialMessage as { quitCommand?: string }).quitCommand === "string") {
                    quitCommand = (initialMessage as { quitCommand?: string }).quitCommand as string;
                }
                const maybeBanner = (initialMessage as { banner?: string | null }).banner;
                if (typeof maybeBanner === "string" || maybeBanner === null) {
                    banner = maybeBanner;
                }
                const maybeThreadExternalId = (initialMessage as { threadExternalId?: string }).threadExternalId;
                if (typeof maybeThreadExternalId === "string" && maybeThreadExternalId.trim().length > 0) {
                    threadExternalId = maybeThreadExternalId;
                } else {
                    // Fallback to the thread.externalId inside the initial MessagePayload if present
                    const maybeMsg = initialMessage as unknown as MessagePayload;
                    const fromThread = (maybeMsg && typeof maybeMsg === "object") ? (maybeMsg.thread as { externalId?: string } | undefined) : undefined;
                    if (fromThread && typeof fromThread.externalId === "string" && fromThread.externalId.trim().length > 0) {
                        threadExternalId = fromThread.externalId;
                    }
                }
                // Capture sender and participants for subsequent messages
                const maybeMsg = initialMessage as unknown as MessagePayload;
                if (maybeMsg?.sender && typeof maybeMsg.sender === "object") {
                    sessionSender = {
                        id: maybeMsg.sender.id ?? undefined,
                        externalId: maybeMsg.sender.externalId ?? null,
                        type: maybeMsg.sender.type ?? "user",
                        name: maybeMsg.sender.name ?? null,
                        identifierType: maybeMsg.sender.identifierType ?? undefined,
                        metadata: (maybeMsg.sender.metadata && typeof maybeMsg.sender.metadata === "object")
                            ? maybeMsg.sender.metadata as Record<string, unknown>
                            : null,
                    };
                }
                const fromParticipants = (initialMessage as { thread?: { participants?: string[] } }).thread?.participants;
                if (Array.isArray(fromParticipants) && fromParticipants.length > 0) {
                    sessionParticipants = fromParticipants.slice();
                }
            }

            let stopped = false;

            const closed = (async () => {
                if (banner) console.log(banner);

                const unifiedOnEvent: UnifiedOnEvent = async (ev) => {
                    const e = ev as unknown as { type?: string; payload?: { token?: string; isComplete?: boolean } };
                    if (e?.type === "TOKEN" && e?.payload) {
                        const token = e.payload.token ?? "";
                        const done = Boolean(e.payload.isComplete);
                        if (!done) {
                            const anyGlobal = globalThis as unknown as {
                                Deno?: { stdout?: { writeSync?: (data: Uint8Array) => unknown } };
                                process?: { stdout?: { write?: (chunk: string) => unknown } };
                            };
                            const bytes = new TextEncoder().encode(token);
                            if (anyGlobal?.Deno?.stdout?.writeSync) {
                                anyGlobal.Deno.stdout.writeSync(bytes);
                            } else if (anyGlobal?.process?.stdout?.write) {
                                anyGlobal.process.stdout.write(token);
                            } else {
                                console.log(token);
                            }
                        } else {
                            console.log("");
                        }
                    }
                    if (typeof onEvent === "function" && ev.type !== "TOKEN") {
                        return await onEvent(ev);
                    } else if (typeof onEvent === "function") {
                        // TOKEN returns ignored (read-only)
                        await Promise.resolve(onEvent(ev)).catch(() => undefined);
                    }
                    return undefined;
                };

                const send = async (content: string) => {
                    const handle = await performRun({
                        content,
                        sender: sessionSender ?? { type: "user", name: "user" },
                        thread: sessionParticipants
                            ? { externalId: threadExternalId, participants: sessionParticipants }
                            : { externalId: threadExternalId },
                    }, unifiedOnEvent, { stream: true, ackMode: "onComplete" });
                    for await (const _ of handle.events) { /* drain */ }
                    await handle.done;
                };

                if (typeof initialMessage === "string" && initialMessage.trim().length > 0) {
                    await send(initialMessage);
                } else if (initialMessage && typeof initialMessage === "object") {
                    const { banner: _b, quitCommand: _q, threadExternalId: _t, ...rest } = initialMessage as Record<string, unknown>;
                    const msg = {
                        ...(rest as MessagePayload),
                        thread: (rest as MessagePayload).thread ?? { externalId: threadExternalId },
                    } as MessagePayload;
                    const handle = await performRun(msg, unifiedOnEvent, { stream: true, ackMode: "onComplete" });
                    for await (const _ of handle.events) { /* drain */ }
                    await handle.done;
                }

                while (!stopped) {
                    const anyGlobal = globalThis as unknown as { prompt?: (msg?: string) => string | null | undefined };
                    const q = ((typeof anyGlobal.prompt === "function" ? anyGlobal.prompt("Message: ") : "") ?? "").trim();
                    if (!q || q.toLowerCase() === quitCommand) {
                        console.log("👋 Ending session. Goodbye!");
                        break;
                    }
                    console.log("\n🔬 Thinking...\n");
                    await send(q);
                    console.log("\n------------------------------------------------------------\n");
                }
            })();

            return {
                stop: () => { stopped = true; },
                closed,
            };
        },
        shutdown: async () => {
            if (managedDb) {
                const resource = managedDb as unknown as { close?: () => Promise<void> | void; end?: () => Promise<void> | void };
                if (typeof resource.close === "function") {
                    await resource.close.call(resource);
                } else if (typeof resource.end === "function") {
                    await resource.end.call(resource);
                }
            }
        },
        assets: {
            getBase64: async (refOrId: string) => {
                const id = refOrId.startsWith("asset://") ? refOrId.slice("asset://".length) : refOrId;
                const { bytes, mime } = await assetStoreInstance.get(id);
                const base64 = bytesToBase64(bytes);
                return { base64, mime };
            },
            getDataUrl: async (refOrId: string) => {
                const id = refOrId.startsWith("asset://") ? refOrId.slice("asset://".length) : refOrId;
                const { bytes, mime } = await assetStoreInstance.get(id);
                const base64 = bytesToBase64(bytes);
                return `data:${mime};base64,${base64}`;
            },
        },
        collections: collectionsManager,
        schema: {
            provision: (schemaName: string) => provisionTenantSchema(baseDb, schemaName),
            drop: (schemaName: string) => dropTenantSchema(baseDb, schemaName),
            exists: (schemaName: string) => schemaExists(baseDb, schemaName),
            list: () => listTenantSchemas(baseDb),
            warmCache: () => warmSchemaCache(baseDb),
        },
    } satisfies Copilotz;
}
