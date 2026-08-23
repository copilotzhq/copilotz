import type { Agent, ReasoningHistoryOptions } from "../resources/index.ts";
import type {
  ChatMessage,
  ChatRequest,
  ChatResponse,
  ProviderConfig,
  ProviderRegistry,
  StreamCallback,
  ToolDefinition,
} from "./types.ts";
import type {
  ConversationMessage,
  ConversationThread,
  Participant,
} from "../domain/index.ts";
import type { CopilotzEvent } from "../events/index.ts";
import type { ProcessorContext } from "../plugins/index.ts";
import type { MemorySourceRef } from "../memory/ontology.ts";
import type {
  ResolveWorkflowAgentTools,
  WorkflowJqEvaluator,
  WorkflowToolCatalog,
} from "../tools/types.ts";

/** Injectable seam around the mature provider fallback/recovery orchestrator. */
export type LlmChat = (
  request: ChatRequest,
  config: ProviderConfig,
  env?: Record<string, string>,
  stream?: StreamCallback,
  providers?: ProviderRegistry,
) => Promise<ChatResponse>;

/** Stable, Event-Body-safe input describing one agent text Action. */
export type AgentTextActionInput = Readonly<{
  id: string;
  namespace: string;
  threadId: string;
  messageId?: string;
  participantId?: string;
  initiatorParticipantId?: string;
  agentId?: string;
  parentActionRunId?: string;
  inputMessageIds: readonly string[];
  availableToolIds: readonly string[];
  metadata: Readonly<Record<string, unknown>>;
}>;

export type ResolveAgentTextConfig = (
  input: Readonly<{
    agent: Agent;
    operation: AgentTextActionInput;
    sourceEvent: CopilotzEvent;
    context: ProcessorContext;
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
    context: ProcessorContext;
  }>,
) => string | null | undefined | Promise<string | null | undefined>;

export type WorkflowHistoryTransform = (
  input: Readonly<{
    messages: readonly ChatMessage[];
    rawMessages: readonly ConversationMessage[];
    thread: ConversationThread;
    agent: Agent;
    sourceEvent: CopilotzEvent;
    context: ProcessorContext;
  }>,
) => readonly ChatMessage[] | Promise<readonly ChatMessage[]>;

export type WorkflowAgentsFileInstructions = Readonly<{
  fileName: string;
  content: string;
}>;

export type WorkflowPromptContextContribution = Readonly<{
  id: string;
  resourceId: string;
  title: string;
  role: "context" | "evidence";
  text: string;
  source?: MemorySourceRef;
  capturedAt?: string;
  historyAfterMessageId?: string;
}>;

export type AgentTextPrompt = Readonly<{
  thread: ConversationThread;
  participant: Participant;
  rawMessages: readonly ConversationMessage[];
  messages: readonly ChatMessage[];
  tools: readonly ToolDefinition[];
  context: readonly WorkflowPromptContextContribution[];
  userMetadata?: Readonly<Record<string, unknown>>;
}>;

/** Former text-plugin options. Deleted in Phase 7 Step B, not renamed onto llm. */
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

export type CreateAgentAskPluginOptions = Readonly<{
  id?: string;
  version?: string;
  toolId?: string;
  maxDepth?: number;
}>;
