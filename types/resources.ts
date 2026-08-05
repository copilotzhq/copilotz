import type { CollectionDefinition } from "@/database/collections/types.ts";
import type { ScopedCollectionsManager } from "@/database/collections/types.ts";
import type {
  DurableEvent,
  DurableEventDraft,
  EphemeralEvent,
} from "@/events/types.ts";
import type {
  ChatMessage,
  LLMConfig,
  LLMRuntimeConfig,
  ProviderFactory,
  ToolDefinition,
} from "@/runtime/llm/types.ts";
import type { AssetConfig, AssetOperations } from "@/assets/index.ts";

export interface TextAgentRuntime {
  type: "llm";
  provider: string;
  model?: string;
  options?: Omit<LLMRuntimeConfig, "provider" | "model">;
}

export interface RealtimeAgentRuntime {
  type: "realtime";
  provider: string;
  model?: string;
  voice?: string;
  options?: Record<string, unknown>;
}

export interface AgentRuntimes {
  text?: TextAgentRuntime;
  realtime?: RealtimeAgentRuntime;
}

export interface AgentRuntimeResolverContext {
  event: DurableEvent;
  messages: ChatMessage[];
  tools: ToolDefinition[];
}

export type AgentLlmOptionsResolver = (
  context: AgentRuntimeResolverContext,
) => LLMRuntimeConfig | Promise<LLMRuntimeConfig>;

export interface Agent {
  readonly resourceType?: "agents";
  id: string;
  name: string;
  role: string;
  externalId?: string | null;
  personality?: string | null;
  instructions?: string | null;
  description?: string | null;
  allowedAgents?: string[] | null;
  allowedTools?: string[] | null;
  allowedSkills?: string[] | null;
  metadata?: Record<string, unknown> | null;
  runtimes?: AgentRuntimes;
  /** Shorthand for `runtimes.text`; runtime fields win when both are present. */
  llmOptions?: LLMRuntimeConfig | AgentLlmOptionsResolver;
  ragOptions?: Record<string, unknown>;
  assetOptions?: {
    resolveInLLM?: boolean;
    produce?: Record<string, unknown>;
  };
}

export type NewAgent = Partial<Agent> & Pick<Agent, "name" | "role">;

export type ToolHistoryVisibility =
  | "requester_only"
  | "public_status"
  | "public";

export interface ToolHistoryPolicy {
  visibility?: ToolHistoryVisibility;
}

export interface Tool {
  readonly resourceType?: "tools";
  id: string;
  key: string;
  name: string;
  description: string;
  externalId?: string | null;
  inputSchema?: Record<string, unknown> | null;
  outputSchema?: Record<string, unknown> | null;
  metadata?: Record<string, unknown> | null;
  historyPolicy?: ToolHistoryPolicy;
  execute?: (
    args: unknown,
    context: ToolExecutionContext,
  ) => unknown | Promise<unknown>;
}

export type NewTool =
  & Partial<Tool>
  & Pick<Tool, "key" | "name" | "description">;

export interface ThreadRecord {
  id: string;
  threadId: string;
  externalId?: string | null;
  name?: string | null;
  status: string;
  parentThreadId?: string | null;
  rootThreadId?: string | null;
  lastEventId?: string | null;
  lastEventPosition?: string | null;
  lastEventAt?: string | null;
  metadata?: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

export interface ParticipantRecord {
  id: string;
  externalId: string;
  participantType: "human" | "agent" | "job";
  name?: string | null;
  agentId?: string | null;
  metadata?: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

export interface MessageSender {
  id?: string;
  externalId?: string;
  type?: "user" | "agent" | "system" | "tool" | "job";
  name?: string;
  metadata?: Record<string, unknown>;
}

export interface MessagePayload {
  content?: string | readonly Record<string, unknown>[] | null;
  sender?: MessageSender;
  target?: string | null;
  toolCalls?: readonly ToolInvocationInput[] | null;
  reasoning?: string | null;
  metadata?: Record<string, unknown> | null;
  externalId?: string | null;
}

export interface ToolInvocationInput {
  id?: string | null;
  tool: { id: string; name?: string | null };
  args?: unknown;
  output?: unknown;
  status?: string;
}

export interface MessageRecord extends MessagePayload {
  id: string;
  messageId: string;
  threadId: string;
  senderId: string;
  senderType: "user" | "agent" | "system" | "tool" | "job";
  targetId?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface LlmAttemptRecord extends Record<string, unknown> {
  id: string;
  threadId: string;
  messageId?: string | null;
  agentId: string;
  agentName: string;
  status: string;
  metadata?: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

export interface ToolExecutionRecord extends Record<string, unknown> {
  id: string;
  threadId: string;
  messageId: string;
  agentId: string;
  agentName: string;
  toolCallId: string;
  tool: { id: string; name?: string | null };
  args: unknown;
  status: string;
  batchId: string;
  batchSize: number;
  batchIndex: number;
  metadata?: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

export interface BackgroundThreadInput {
  name: string;
  participants: readonly string[];
  initialMessage?: string;
  description?: string;
  metadata?: Record<string, unknown>;
}

export interface BackgroundThreadResult {
  threadId: string;
  parentThreadId: string;
  correlationId: string;
  participantIds: readonly string[];
  initialEventId?: string;
  status: "started";
}

export interface ToolExecutionContext {
  idempotencyKey: string;
  deliveryId: string;
  event: DurableEvent;
  threadId: string;
  namespace: string;
  agent?: Agent;
  agents: readonly Agent[];
  tools: readonly Tool[];
  collections: unknown;
  /** Event-aware asset persistence scoped to this execution. */
  assets: AssetOperations;
  /** Starts an explicitly separate child-thread workflow. */
  createThread(input: BackgroundThreadInput): Promise<BackgroundThreadResult>;
  signal: AbortSignal;
  cancelled: boolean;
  cancelReason?: string;
}

export interface TextProviderResource {
  readonly resourceType: "providers";
  readonly kind: "text";
  readonly id: string;
  readonly create: ProviderFactory;
}

export interface RealtimeProviderInput {
  readonly streamId: string;
  readonly type: string;
  readonly mediaType: string;
  readonly payload: ReadableStream<Uint8Array>;
  readonly namespace: string;
  readonly threadId: string;
  readonly participant: ParticipantRecord;
  readonly agent?: Agent;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly correlationId: string;
  /**
   * Durable semantic events committed after this stream was opened, scoped to
   * the same correlation. Providers can use this feed to continue after tools
   * or public agent asks settle. Raw media frames are never included.
   */
  readonly events: ReadableStream<DurableEvent>;
  readonly signal: AbortSignal;
}

export type RealtimeProviderOutput =
  | { kind: "event"; event: EphemeralEvent | DurableEventDraft }
  | {
    kind: "message";
    participant?: ParticipantRecord;
    input: MessagePayload;
  }
  | {
    kind: "stream";
    participant: { id: string; name?: string; type: string };
    mediaType: string;
    streamId?: string;
    causationId?: string;
    correlationId?: string;
    payload: ReadableStream<Uint8Array>;
  };

export interface RealtimeProviderResource {
  readonly resourceType: "providers";
  readonly kind: "realtime";
  readonly id: string;
  run(
    input: RealtimeProviderInput,
  ):
    | AsyncIterable<RealtimeProviderOutput>
    | Promise<AsyncIterable<RealtimeProviderOutput>>;
}

export type ProviderResource = TextProviderResource | RealtimeProviderResource;

export interface SkillResource {
  readonly resourceType?: "skills";
  name: string;
  description: string;
  content: string;
  allowedTools?: string[];
  tags?: string[];
  source?: string;
  sourcePath?: string;
  hasReferences?: boolean;
}

export interface ChannelResource {
  readonly resourceType?: "channels";
  id: string;
  [key: string]: unknown;
}

export interface MemoryResource {
  readonly resourceType?: "memory";
  id: string;
  name: string;
  kind: string;
  description?: string | null;
  enabled?: boolean;
  metadata?: Record<string, unknown> | null;
  config?: Record<string, unknown> | null;
  /**
   * Add provider-facing context immediately before an LLM attempt. The
   * resource executes inside the Oxian delivery worker and can read event-native
   * collections without becoming a second orchestration path.
   */
  prepare?: (
    context: MemoryPreparationContext,
  ) =>
    | readonly ChatMessage[]
    | Promise<readonly ChatMessage[]>;
}

export interface MemoryPreparationContext {
  readonly event: DurableEvent;
  readonly agent: Agent;
  readonly thread: ThreadRecord;
  readonly messages: readonly MessageRecord[];
  readonly history: readonly ChatMessage[];
  readonly collections: ScopedCollectionsManager;
  readonly signal: AbortSignal;
}

export interface API {
  readonly resourceType?: "apis";
  id?: string;
  name: string;
  description?: string;
  openApiSchema: Record<string, unknown> | string;
  baseUrl?: string;
  [key: string]: unknown;
}

export type NewAPI = API;

export interface MCPServer {
  readonly resourceType?: "mcpServers";
  id?: string;
  name: string;
  [key: string]: unknown;
}

export type NewMCPServer = MCPServer;

export interface EngineResourceContext {
  agents: readonly Agent[];
  tools: readonly Tool[];
  collections: readonly CollectionDefinition[];
  providers: readonly ProviderResource[];
  assetConfig?: AssetConfig;
  llmConfig?: LLMConfig;
}
