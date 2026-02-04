/**
 * Type definitions and interfaces for the Copilotz framework.
 * 
 * This module exports all the core types needed for working with Copilotz,
 * including entity types, configuration interfaces, and event handling types.
 * 
 * @module
 */

import type { ProviderConfig, ChatMessage, ToolDefinition } from "@/connectors/llm/types.ts";

import type {
    Agent as DbAgent, NewAgent,
    API, NewAPI,
    MCPServer, NewMCPServer,
    Message, NewMessage,
    Event, NewEvent, NewMessageEvent, ToolCallEvent, LlmCallEvent, TokenEvent,
    Task, NewTask,
    Thread, NewThread,
    Tool, NewTool,
    User, NewUser,
    MessagePayload,
    ToolCallEventPayload,
    LlmCallEventPayload,
    TokenEventPayload,
    NewUnknownEvent,
    Document, NewDocument,
    DocumentChunk, NewDocumentChunk,
} from "@/database/schemas/index.ts";

export type {
    /** Input type for creating a new Agent entity. */
    NewAgent,
    /** API configuration for connecting to external REST APIs. */
    API,
    /** Input type for creating a new API configuration. */
    NewAPI,
    /** MCP (Model Context Protocol) server configuration. */
    MCPServer,
    /** Input type for creating a new MCP server configuration. */
    NewMCPServer,
    /** Message entity representing a single message in a thread. */
    Message,
    /** Input type for creating a new Message. */
    NewMessage,
    /** Event entity in the event queue system. */
    Event,
    /** Input type for creating a new Event. */
    NewEvent,
    /** Specific NEW_MESSAGE event with typed payload. */
    NewMessageEvent,
    /** Specific TOOL_CALL event with typed payload. */
    ToolCallEvent,
    /** Specific LLM_CALL event with typed payload. */
    LlmCallEvent,
    /** Specific TOKEN event with typed payload. */
    TokenEvent,
    /** Task entity for goal-oriented workflows. */
    Task,
    /** Input type for creating a new Task. */
    NewTask,
    /** Thread entity representing a conversation. */
    Thread,
    /** Input type for creating a new Thread. */
    NewThread,
    /** Tool entity defining an agent capability. */
    Tool,
    /** Input type for creating a new Tool. */
    NewTool,
    /** User entity representing a conversation participant. */
    User,
    /** Input type for creating a new User. */
    NewUser,
    /** Payload structure for incoming messages. */
    MessagePayload,
    /** Payload for tool call events. */
    ToolCallEventPayload,
    /** Payload for LLM call events. */
    LlmCallEventPayload,
    /** Payload for streaming token events. */
    TokenEventPayload,
    /** Generic event type for custom event processors. */
    NewUnknownEvent,
    /** Document stored in the RAG knowledge base. */
    Document,
    /** Input type for creating a new Document. */
    NewDocument,
    /** Chunk of a document with embedding vector. */
    DocumentChunk,
    /** Input type for creating a new DocumentChunk. */
    NewDocumentChunk,
}
 
import type {
    DatabaseConfig,
    DbInstance,
    CopilotzDb,
} from "@/database/index.ts";

export type {
    /** Configuration options for database connection. */
    DatabaseConfig,
    /** Low-level database instance from Ominipg. */
    DbInstance,
    /** Copilotz database instance with CRUD and custom operations. */
    CopilotzDb
}

import type { EventProcessor, ProcessorDeps } from "@/event-processors/index.ts";

export type {
    /** Interface for custom event processors. */
    EventProcessor,
    /** Dependencies injected into event processors. */
    ProcessorDeps,
    /** Context passed to tool execution. */
    ToolExecutionContext,
} from "@/event-processors/index.ts";

import type { AssetStore, AssetConfig } from "@/utils/assets.ts";

/**
 * Payload passed to the agent LLM options resolver function.
 * Contains all context needed to dynamically configure LLM options per call.
 */
export interface AgentLlmOptionsResolverPayload {
    /** Name of the agent making the LLM call. */
    agentName: string;
    /** ID of the agent making the LLM call. */
    agentId: string;
    /** Array of chat messages to send to the LLM. */
    messages: ChatMessage[];
    /** Array of tool definitions available for the call. */
    tools: ToolDefinition[];
    /** Current provider configuration (may be modified). */
    config?: ProviderConfig;
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
export type AgentLlmOptionsResolver = (args: AgentLlmOptionsResolverArgs) => ProviderConfig | Promise<ProviderConfig>;

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
    thread?: { id?: string; externalId?: string; metadata?: Record<string, unknown> };
    /** Sender context information. */
    sender?: { id?: string; externalId?: string; type?: string; metadata?: Record<string, unknown> };
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
export type NamespaceResolver = (context: NamespaceContext) => Promise<string[]> | string[];

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
 * Agent entity with extended LLM options supporting dynamic resolution.
 * Extends the base agent type with support for RAG and dynamic LLM configuration.
 */
export type Agent = Omit<DbAgent, "llmOptions"> & {
    /** LLM provider configuration or dynamic resolver function. */
    llmOptions?: DbAgent["llmOptions"] | AgentLlmOptionsResolver;
    /** RAG options for this agent. */
    ragOptions?: AgentRagOptions;
};

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
    /** User context. */
    users?: User[];
    /** Whether streaming is enabled. */
    stream?: boolean;
    /** Active task ID for task-oriented workflows. */
    activeTaskId?: string;
    /** Callbacks for handling events. */
    callbacks?: ChatCallbacks;
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
    /** Custom event processors by event type. */
    customProcessors?: Record<string, Array<EventProcessor<unknown, ProcessorDeps>>>;
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
    /** Optional namespace prefix for multi-tenancy isolation. */
    namespacePrefix?: string;
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
    prefix?: string
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
 * Callback functions for handling chat events.
 * These callbacks allow intercepting and modifying the chat pipeline behavior.
 */
export interface ChatCallbacks {
    /** 
     * Called when streaming content tokens.
     * @param data - The token data being streamed
     */
    onContentStream?: (data: ContentStreamData) => void | Promise<void> | ContentStreamData;
    /** 
     * Called for each event in the queue. Return producedEvents to inject new events.
     * @param event - The event being processed
     */
    onEvent?: (event: Event) => Promise<{ producedEvents?: Array<NewEvent | NewUnknownEvent> } | void> | { producedEvents?: Array<NewEvent | NewUnknownEvent> } | void;
    /** 
     * Called after processing to push events to the client stream.
     * Only called if the event was not replaced by a custom processor.
     * @param event - The event to push to the stream
     */
    onStreamPush?: (event: Event) => void;
}

/**
 * Data structure for streaming content tokens during LLM response generation.
 */
export interface ContentStreamData {
    /** The thread ID this token belongs to. */
    threadId: string;
    /** Name of the agent generating the content. */
    agentName: string;
    /** The token string being streamed. */
    token: string;
    /** Whether this is the final token (stream complete). */
    isComplete: boolean;
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
