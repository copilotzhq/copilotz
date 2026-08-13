import type {
  Agent,
  API,
  MCPServer,
  ReasoningHistoryOptions,
  Tool,
} from "../resources/index.ts";
import type {
  ChatMessage,
  ChatRequest,
  ChatResponse,
  ProviderConfig,
  ProviderFactory,
  ProviderRegistry,
  StreamCallback,
  ToolDefinition,
  ToolPipelineStage,
  ToolPipelineToolStage,
} from "../llm/types.ts";
import type {
  ConversationMessage,
  ConversationThread,
  LlmAttempt,
  Participant,
  ScopedEventCollection,
  ToolExecution,
} from "../domain/index.ts";
import type { CopilotzEvent } from "../events/index.ts";
import type { CopilotzProcessorContext } from "../engine/index.ts";
import type { ScopedPluginResources } from "../engine/index.ts";

/** Plugin resource that exposes one existing low-level LLM provider adapter. */
export type LlmProviderResource = Readonly<{
  id: string;
  type: "llm";
  factory: ProviderFactory;
}>;

/** Existing custom/native tool shape required by the event-native executor. */
export type WorkflowTool =
  & Omit<Tool, "execute">
  & Readonly<{
    execute(
      args: unknown,
      context?: WorkflowToolExecutionContext,
    ): unknown | Promise<unknown>;
  }>;

/** Injectable seam around the mature provider fallback/recovery orchestrator. */
export type LlmChat = (
  request: ChatRequest,
  config: ProviderConfig,
  env?: Record<string, string>,
  stream?: StreamCallback,
  providers?: ProviderRegistry,
) => Promise<ChatResponse>;

export type ResolveAgentTextConfig = (
  input: Readonly<{
    agent: Agent;
    attempt: LlmAttempt;
    sourceEvent: CopilotzEvent;
    context: CopilotzProcessorContext;
    baseConfig: ProviderConfig;
    thread: ConversationThread;
    messages: readonly ChatMessage[];
    tools: readonly ToolDefinition[];
  }>,
) => ProviderConfig | Promise<ProviderConfig>;

export type ResolveWorkflowAgentInstructions = (
  input: Readonly<{
    agent: Agent;
    baseInstructions: string | null;
    thread: ConversationThread;
    userMetadata?: Readonly<Record<string, unknown>>;
    sourceEvent: CopilotzEvent;
    context: CopilotzProcessorContext;
  }>,
) => string | null | undefined | Promise<string | null | undefined>;

export type WorkflowHistoryTransform = (
  input: Readonly<{
    messages: readonly ChatMessage[];
    rawMessages: readonly ConversationMessage[];
    thread: ConversationThread;
    agent: Agent;
    sourceEvent: CopilotzEvent;
    context: CopilotzProcessorContext;
  }>,
) => readonly ChatMessage[] | Promise<readonly ChatMessage[]>;

export type WorkflowAgentsFileInstructions = Readonly<{
  fileName: string;
  content: string;
}>;

export type AgentTextPrompt = Readonly<{
  thread: ConversationThread;
  participant: Participant;
  rawMessages: readonly ConversationMessage[];
  messages: readonly ChatMessage[];
  tools: readonly ToolDefinition[];
  memory: readonly WorkflowPromptMemoryContribution[];
  userMetadata?: Readonly<Record<string, unknown>>;
}>;

export type WorkflowPromptMemoryContribution = Readonly<{
  resourceId: string;
  section?: string;
  /** Exclude persisted transcript entries up to and including this message. */
  historyAfterMessageId?: string;
}>;

export type WorkflowPromptMemoryResource = Readonly<{
  id?: string;
  name: string;
  kind: string;
  enabled?: boolean;
  contribute(
    input: Readonly<{
      agent: Agent;
      participant: Participant;
      thread: ConversationThread;
      history: readonly ConversationMessage[];
      sourceEvent: CopilotzEvent;
      context: CopilotzProcessorContext;
    }>,
  ):
    | WorkflowPromptMemoryContribution
    | null
    | Promise<WorkflowPromptMemoryContribution | null>;
}>;

/** Application policy applied before a text attempt records its tool grants. */
export type ResolveWorkflowAgentTools = (
  input: Readonly<{
    agent: Agent;
    tools: readonly WorkflowTool[];
    sourceEvent: CopilotzEvent;
    context: CopilotzProcessorContext;
  }>,
) => readonly WorkflowTool[] | Promise<readonly WorkflowTool[]>;

export type CreateTextWorkflowPluginOptions = Readonly<{
  id?: string;
  version?: string;
  chat?: LlmChat;
  env?: Readonly<Record<string, string>>;
  resolveAgentTextConfig?: ResolveAgentTextConfig;
  resolveAgentTools?: ResolveWorkflowAgentTools;
  resolveAgentInstructions?: ResolveWorkflowAgentInstructions;
  historyTransform?: WorkflowHistoryTransform;
  reasoningHistory?: ReasoningHistoryOptions;
  toolResultHistoryMaxEstimatedTokens?: number;
  agentsFileInstructions?: WorkflowAgentsFileInstructions;
  userMetadata?: Readonly<Record<string, unknown>>;
  toolCatalog?: WorkflowToolCatalog;
  evaluateJq?: WorkflowJqEvaluator;
  toolExecutionTimeoutMs?: number;
  toolExecutionTimeoutsMs?: Readonly<Record<string, number | undefined>>;
}>;

export type GenerateApiWorkflowTools = (
  apis: readonly API[],
) => readonly WorkflowTool[] | Promise<readonly WorkflowTool[]>;

export type GenerateMcpWorkflowTools = (
  servers: readonly MCPServer[],
) => readonly WorkflowTool[] | Promise<readonly WorkflowTool[]>;

export type CreateWorkflowToolCatalogOptions = Readonly<{
  generateApiTools?: GenerateApiWorkflowTools;
  generateMcpTools?: GenerateMcpWorkflowTools;
}>;

export type WorkflowToolCatalog = Readonly<{
  all(resources: ScopedPluginResources): Promise<readonly WorkflowTool[]>;
  forAgent(
    resources: ScopedPluginResources,
    agent: Agent,
  ): Promise<readonly WorkflowTool[]>;
  get(
    resources: ScopedPluginResources,
    key: string,
  ): Promise<WorkflowTool | undefined>;
  clear(): void;
}>;

export type WorkflowJqEvaluator = (
  input: unknown,
  filter: string,
) => unknown | Promise<unknown>;

export type WorkflowPipelineMetadata = Readonly<{
  id: string;
  stages: readonly ToolPipelineStage[];
  stageIndex: number;
  rootToolCallId: string;
  upstreamToolExecutionId?: string;
  appliedJqStageIndexes?: readonly number[];
}>;

export type WorkflowPipelineAdvance =
  | Readonly<{
    kind: "next_tool";
    stage: ToolPipelineToolStage;
    stageIndex: number;
    arguments: Readonly<Record<string, unknown>>;
    pipeline: WorkflowPipelineMetadata;
  }>
  | Readonly<{
    kind: "settled";
    output: unknown;
    projected?: boolean;
  }>
  | Readonly<{
    kind: "failed";
    stageIndex: number;
    message: string;
  }>;

export type WorkflowToolExecutionContext = {
  namespace: string;
  correlationId: string;
  idempotencyKey: string;
  execution: ToolExecution;
  processor: CopilotzProcessorContext;
  threadId: string;
  toolExecutionId: string;
  toolCallId: string;
  senderId?: string;
  senderType?: "human" | "agent" | "tool" | "system" | "job";
  userExternalId?: string;
  agent?: Agent | null;
  agents: readonly Agent[];
  tools: readonly WorkflowTool[];
  collections: Readonly<Record<string, ScopedEventCollection>>;
  userMetadata?: Readonly<Record<string, unknown>>;
  threadMetadata?: Readonly<Record<string, unknown>>;
  resolveAsset?: (
    assetId: string,
  ) => Promise<{ bytes: Uint8Array; mime: string }>;
  /**
   * Emits non-durable output while this tool is executing. Calls are ordered
   * even when a tool does not await each returned promise. The final returned
   * tool value is emitted automatically on the `result` channel when it fits
   * the bounded live-event frame, unless the tool already emitted that channel
   * itself. Large results remain asset-backed durable content; tools can stream
   * bounded pieces explicitly instead.
   */
  emitOutput(
    delta: unknown,
    options?: WorkflowToolOutputOptions,
  ): Promise<void>;
  onCancel?: (callback: () => void) => () => void;
  cancelled: boolean;
  cancelReason?: string;
};

export type WorkflowToolOutputOptions = Readonly<{
  /** Logical output lane such as result, stdout, stderr, or progress. */
  channel?: string;
  /** Append is useful for text chunks; replace is useful for snapshots. */
  mode?: "append" | "replace";
  mediaType?: string;
}>;

/**
 * Returned by an event-producing tool whose durable result will be settled by
 * a later semantic event. The worker that accepted the tool call may finish;
 * the tool execution itself intentionally remains running.
 */
export type DeferredWorkflowToolResult = Readonly<{
  kind: "copilotz.workflow-tool.deferred.v1";
  metadata: Readonly<Record<string, unknown>>;
}>;

export type DeferWorkflowToolOptions = Readonly<{
  metadata?: Record<string, unknown>;
}>;

export type AgentAskPhase = "question" | "progress" | "answer";

/** Public causal metadata shared by every message in one agent ask. */
export type AgentAskMetadata = Readonly<{
  schema: "copilotz.ask.v1";
  askId: string;
  phase: AgentAskPhase;
  toolExecutionId: string;
  questionMessageId: string;
  askingParticipantId: string;
  askingAgentId: string;
  askedParticipantId: string;
  askedAgentId: string;
  callingAttemptId?: string;
  answerAttemptId?: string;
  parentAskId?: string;
  depth: number;
}>;

export type CreateAgentAskPluginOptions = Readonly<{
  id?: string;
  version?: string;
  toolId?: string;
  /** Maximum nested ask depth, including the first ask. Defaults to eight. */
  maxDepth?: number;
}>;

export type WorkflowMetadata = Readonly<{
  kind:
    | "agent_output"
    | "tool_execution"
    | "tool_result"
    | "provider_attempt"
    | "memory_consolidation"
    | "realtime_message";
  /** Selects who owns continuation after this semantic output. */
  continuation?: "text" | "realtime" | "none";
  realtimeStreamId?: string;
  llmAttemptId?: string;
  parentLlmAttemptId?: string;
  toolExecutionId?: string;
  toolCallId?: string;
  batchId?: string;
  batchSize?: number;
  batchIndex?: number;
  sourceMessageId?: string;
  agentParticipantId?: string;
  pipeline?: WorkflowPipelineMetadata;
  pipelineFailure?: Readonly<{ stageIndex: number; message: string }>;
}>;
