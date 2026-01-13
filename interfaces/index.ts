import type { ProviderConfig, ChatMessage, ToolDefinition } from "@/connectors/llm/types.ts";

import type {
    Agent as DbAgent, NewAgent,
    API, NewAPI,
    MCPServer, NewMCPServer,
    Message, NewMessage,
    Queue, NewQueue,
    Event, NewEvent,
    Task, NewTask,
    Thread, NewThread,
    Tool, NewTool,
    User, NewUser,
    MessagePayload,
    ToolCallEventPayload,
    LlmCallEventPayload,
    TokenEventPayload,
    NewUnknownEvent,
    EventPayloadMapBase,
    EventOfMap,
    NewEventOfMap,
    // RAG types
    Document, NewDocument,
    DocumentChunk, NewDocumentChunk,
} from "@/database/schemas/index.ts";

export type {
    NewAgent,
    API, NewAPI,
    MCPServer, NewMCPServer,
    Message, NewMessage,
    Queue, NewQueue,
    Event, NewEvent,
    Task, NewTask,
    Thread, NewThread,
    Tool, NewTool,
    User, NewUser,
    MessagePayload,
    ToolCallEventPayload,
    LlmCallEventPayload,
    TokenEventPayload,
    NewUnknownEvent,
    EventPayloadMapBase,
    EventOfMap,
    NewEventOfMap,
    // RAG types
    Document, NewDocument,
    DocumentChunk, NewDocumentChunk,
}
 
import type {
    DatabaseConfig,
    DbInstance,
    CopilotzDb,
} from "@/database/index.ts";

export type {
    DatabaseConfig,
    DbInstance,
    CopilotzDb
}

import type { EventProcessor, ProcessorDeps } from "@/event-processors/index.ts";

export type {
    EventProcessor,
    ProcessorDeps,
    ToolCallPayload,
    ToolResultPayload,
    ToolExecutionContext,
    LLMCallPayload,
    LLMResultPayload,
    ExecutableTool,
    ToolExecutor,
} from "@/event-processors/index.ts";

import type { AssetStore, AssetConfig } from "@/utils/assets.ts";

export interface AgentLlmOptionsResolverPayload {
    agentName: string;
    agentId: string;
    messages: ChatMessage[];
    tools: ToolDefinition[];
    config?: ProviderConfig;
}

export interface AgentLlmOptionsResolverArgs {
    payload: AgentLlmOptionsResolverPayload;
    sourceEvent: Event;
    deps: ProcessorDeps;
}

export type AgentLlmOptionsResolver = (args: AgentLlmOptionsResolverArgs) => ProviderConfig | Promise<ProviderConfig>;

// RAG Configuration Types
export interface EmbeddingConfig {
    provider: "openai" | "ollama" | "cohere";
    model: string;
    apiKey?: string;
    baseUrl?: string;
    dimensions?: number;
    batchSize?: number;
}

export interface ChunkingConfig {
    strategy?: "fixed" | "paragraph" | "sentence";  // Default: "fixed"
    chunkSize?: number;       // Default: 512 tokens
    chunkOverlap?: number;    // Default: 50 tokens
}

export interface RetrievalConfig {
    defaultLimit?: number;          // Default: 5
    similarityThreshold?: number;   // Default: 0.7
}

export interface NamespaceContext {
    thread?: { id?: string; externalId?: string; metadata?: Record<string, unknown> };
    sender?: { id?: string; externalId?: string; type?: string; metadata?: Record<string, unknown> };
    agent?: { id?: string; name?: string };
    message?: { content?: string };
}

export type NamespaceResolver = (context: NamespaceContext) => Promise<string[]> | string[];

export interface RagConfig {
    enabled?: boolean;
    embedding: EmbeddingConfig;
    chunking?: ChunkingConfig;
    retrieval?: RetrievalConfig;
    defaultNamespace?: string;
    namespaceResolver?: NamespaceResolver;
}

export interface AgentRagOptions {
    mode?: "tool" | "auto" | "disabled";
    namespaces?: string[];
    ingestNamespace?: string;
    autoInjectLimit?: number;
}

export type Agent = Omit<DbAgent, "llmOptions"> & {
    llmOptions?: DbAgent["llmOptions"] | AgentLlmOptionsResolver;
    ragOptions?: AgentRagOptions;
};

// Chat context interface
export interface ChatContext {
    agents?: Agent[];
    tools?: Tool[];
    apis?: API[]; // Array of API configurations
    mcpServers?: MCPServer[]; // Array of MCP server configurations
    users?: User[]; // Optional users context
    stream?: boolean;
    activeTaskId?: string;
    callbacks?: ChatCallbacks;
    dbInstance?: CopilotzDb;
    dbConfig?: DatabaseConfig;
    threadMetadata?: Record<string, unknown>;
    queueTTL?: number;
    userMetadata?: Record<string, unknown>;
    customProcessors?: Record<string, Array<EventProcessor<unknown, ProcessorDeps>>>;
    assetStore?: AssetStore;
    assetConfig?: AssetConfig;
    resolveAsset?: (ref: string) => Promise<{ bytes: Uint8Array; mime: string }>;
    // RAG configuration
    ragConfig?: RagConfig;
    embeddingConfig?: EmbeddingConfig;
}

// Callback types that can return values for interception
export interface ChatCallbacks {
    onContentStream?: (data: ContentStreamData) => void | Promise<void> | ContentStreamData;
    onEvent?: (event: Event) => Promise<{ producedEvents?: Array<NewEvent | NewUnknownEvent> } | void> | { producedEvents?: Array<NewEvent | NewUnknownEvent> } | void;
    /** Called after processing to push events to the client stream. Only called if the event was not replaced by a custom processor. */
    onStreamPush?: (event: Event) => void;
}


export interface ContentStreamData {
    threadId: string;
    agentName: string;
    token: string;
    isComplete: boolean;
}

// Narrowing helpers for better DX on Event payloads
type TokenPayload = ContentStreamData & { [x: string]: unknown };
export type TokenEvent = Event & { type: "TOKEN"; payload: TokenPayload };
export function isTokenEvent(event: Event): event is TokenEvent {
    return event?.type === "TOKEN";
}
