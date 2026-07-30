import { generateAllApiTools } from "@/runtime/api/index.ts";
import { generateAllMcpTools } from "@/runtime/mcp/index.ts";
import { createMessageService } from "@/runtime/collections/native.ts";
import {
  getLatestReadyLongTermMemory,
  getLongTermMemoryConfig,
  getUserExternalId,
  isLongTermMemoryAccessible,
  type LongTermMemoryRecord,
  resolveParticipantCollection,
  resolveThreadMemorySpaces,
} from "@/runtime/memory/index.ts";
import { toLLMConfig } from "@/runtime/llm/config.ts";
import { withExplicitPromptCacheBreakpoint } from "@/runtime/llm/prompt-cache.ts";
import type {
  ChatMessage,
  LLMConfig,
  LLMRuntimeConfig,
  ToolDefinition,
} from "@/runtime/llm/types.ts";
import { formatToolsForPrompt } from "@/runtime/tools/format-tools-for-prompt.ts";
import { filterSkillsForAgent } from "@/runtime/loaders/skill-loader.ts";
import { getPublicThreadMetadata } from "@/runtime/thread-metadata.ts";
import type {
  Agent,
  AgentLlmOptionsResolverArgs,
  ChatContext,
  Event,
  NewMessage,
  ProcessorDeps,
  Thread,
} from "@/types/index.ts";
import type { KnowledgeNode } from "@/database/schemas/index.ts";
import {
  contextGenerator,
  isDirectConversationThread,
} from "@/runtime/agent-llm-input/context-generator.ts";
import { historyGenerator } from "@/runtime/agent-llm-input/history-generator.ts";
import type { ExecutableTool, ToolExecutor } from "@/runtime/tools/types.ts";
import {
  assertNoRoutingControlToolCollisions,
  buildRoutingControlToolDefinitions,
  resolveInThreadRoutingTargets,
} from "@/runtime/routing/index.ts";

type Operations = ProcessorDeps["db"]["ops"];

export type AgentHistoryMode =
  | "full"
  | "afterReadyLongTermMemory"
  | {
    type: "range";
    startMessageId: string;
    endMessageId: string;
  };

export type AgentLongTermMemoryMode = "auto" | "include" | "omit";

export interface AgentLlmInput {
  thread: Thread;
  rawHistory: NewMessage[];
  messages: ChatMessage[];
  tools: ToolDefinition[];
  config: LLMConfig;
  runtimeConfig: LLMRuntimeConfig;
  agentNode?: KnowledgeNode;
  userMetadata?: Record<string, unknown>;
}

export interface BuildAgentLlmInputOptions {
  deps: ProcessorDeps;
  event: Event;
  threadId: string;
  agent: Agent;
  historyMode: AgentHistoryMode;
  longTermMemoryMode?: AgentLongTermMemoryMode;
}

function normalizeStringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value
      .filter((item): item is string =>
        typeof item === "string" && item.trim().length > 0
      )
      .map((item) => item.trim())
    : [];
}

export function buildTurnControlMessage(
  agent: Agent,
  event: Event,
  canConsult: boolean,
): ChatMessage {
  const metadata = event.metadata && typeof event.metadata === "object"
    ? event.metadata as Record<string, unknown>
    : {};
  const returnPath = normalizeStringList(metadata.targetQueue);
  const agentId = (agent.id ?? agent.name) as string;
  const lines = [
    "<turn_control>",
    `active_agent: ${agentId}`,
    `returns_to: ${returnPath[0] ?? "requester"}`,
    "You own the current turn.",
    "Calling a normal tool keeps you active after its result.",
    ...(canConsult
      ? [
        "To consult another agent for one bounded turn, call consult_agent. Control returns to you after their reply.",
      ]
      : []),
    "When your work is finished, reply normally without a routing call.",
    "</turn_control>",
  ];
  return { role: "system", content: lines.join("\n") };
}

function matchesCurrentAgent(agent: Agent, senderId: string): boolean {
  const normalizedSender = senderId.trim().toLowerCase();
  return [agent.id, agent.name].some((identity) =>
    typeof identity === "string" &&
    identity.trim().toLowerCase() === normalizedSender
  );
}

function latestExternalRequestMessageId(
  history: NewMessage[],
  agent: Agent,
): string | null {
  for (let index = history.length - 1; index >= 0; index--) {
    const message = history[index];
    const isExternal = message.senderType === "user" ||
      message.senderType === "job" ||
      (message.senderType === "agent" &&
        !matchesCurrentAgent(agent, message.senderId));
    if (isExternal && typeof message.id === "string") return message.id;
  }
  return null;
}

export function markLatestExternalRequest(
  messages: ChatMessage[],
  history: NewMessage[],
  agent: Agent,
): ChatMessage[] {
  const messageId = latestExternalRequestMessageId(history, agent);
  if (!messageId) return messages;

  let marked = false;
  return messages.map((message) => {
    if (marked || message.metadata?.sourceMessageId !== messageId) {
      return message;
    }
    marked = true;
    return {
      ...message,
      content: withExplicitPromptCacheBreakpoint(message.content),
    };
  });
}

function toExecutableTool(tool: unknown): ExecutableTool | null {
  if (!tool || typeof tool !== "object") return null;
  const maybe = tool as Partial<ExecutableTool>;

  const executeSource = maybe.execute;
  if (typeof executeSource !== "function") return null;

  const executor: ToolExecutor = (args, context) =>
    executeSource.call(tool, args, context) as Promise<unknown> | unknown;

  const key = maybe.key;
  const name = maybe.name;
  const description = maybe.description;
  if (
    typeof key !== "string" || typeof name !== "string" ||
    typeof description !== "string"
  ) {
    return null;
  }

  const toDate = (value: unknown): Date => {
    if (value instanceof Date) return value;
    if (typeof value === "string" || typeof value === "number") {
      const parsed = new Date(value);
      if (!Number.isNaN(parsed.getTime())) return parsed;
    }
    return new Date();
  };

  return {
    id: typeof maybe.id === "string" ? maybe.id : crypto.randomUUID(),
    key,
    name,
    description,
    externalId: typeof maybe.externalId === "string" ? maybe.externalId : null,
    metadata: (maybe.metadata && typeof maybe.metadata === "object")
      ? maybe.metadata
      : null,
    createdAt: toDate(maybe.createdAt),
    updatedAt: toDate(maybe.updatedAt),
    inputSchema: maybe.inputSchema ?? null,
    outputSchema: maybe.outputSchema ?? null,
    historyPolicy: maybe.historyPolicy,
    execute: executor,
  };
}

function sliceMessagesInRange(
  messages: NewMessage[],
  startMessageId: string,
  endMessageId: string,
): NewMessage[] {
  const start = messages.findIndex((message) => message.id === startMessageId);
  const end = messages.findIndex((message) => message.id === endMessageId);
  if (start < 0 || end < 0 || start > end) {
    throw new Error(
      `Message range not found in thread history: ${startMessageId}..${endMessageId}`,
    );
  }
  return messages.slice(start, end + 1);
}

function logAgentInputPhase(args: {
  event: Event;
  threadId: string;
  agentId: string;
  phase: "history_loading" | "prompt_construction";
  startedAt: number;
  detail?: Record<string, unknown>;
}): void {
  console.info(JSON.stringify({
    event: "agent_llm_input.phase",
    phase: args.phase,
    durationMs: Number((performance.now() - args.startedAt).toFixed(1)),
    threadId: args.threadId,
    agentId: args.agentId,
    traceId: typeof args.event.traceId === "string" ? args.event.traceId : null,
    ...args.detail,
  }));
}

async function resolveApplicableLongTermMemory(args: {
  deps: ProcessorDeps;
  thread: Thread;
  threadId: string;
  agentId: string;
}): Promise<LongTermMemoryRecord | null> {
  const { deps, thread, threadId, agentId } = args;
  const context = deps.context;
  const longTermMemoryConfig = getLongTermMemoryConfig(context.memory);
  const longTermMemoryNamespace = context.namespace ??
    (typeof thread.namespace === "string" ? thread.namespace : null);
  const candidateLongTermMemory =
    longTermMemoryConfig && longTermMemoryNamespace
      ? await getLatestReadyLongTermMemory(
        deps.db,
        threadId,
        longTermMemoryNamespace,
        agentId,
      )
      : null;
  const longTermMemory = candidateLongTermMemory &&
      longTermMemoryNamespace &&
      isLongTermMemoryAccessible(
        candidateLongTermMemory.data,
        await resolveThreadMemorySpaces(
          deps.db,
          threadId,
          longTermMemoryNamespace,
        ),
      )
    ? candidateLongTermMemory
    : null;
  return longTermMemory;
}

interface ProcessingContext {
  thread: Thread;
  chatHistory: NewMessage[];
  longTermMemory: LongTermMemoryRecord | null;
  availableAgents: Agent[];
  allTools: ExecutableTool[];
  userMetadata?: Record<string, unknown>;
  agentNode?: KnowledgeNode;
}

interface ParticipantLookupRecord extends Record<string, unknown> {
  id: string;
  namespace?: string;
  externalId: string;
  name?: string | null;
  metadata?: Record<string, unknown> | null;
}

type ParticipantResolver = {
  resolveByExternalId?: (
    externalId: string,
  ) => Promise<ParticipantLookupRecord | null>;
};

export async function buildProcessingContext(
  ops: Operations,
  threadId: string,
  context: ChatContext,
  senderIdForHistory: string,
  targetAgentId?: string,
  historyMode: AgentHistoryMode = "full",
  event?: Event,
  longTermMemory: LongTermMemoryRecord | null = null,
  preloadedThread?: Thread,
): Promise<ProcessingContext> {
  const thread: Thread | undefined = preloadedThread ??
    await ops.getThreadById(threadId);
  if (!thread) throw new Error(`Thread not found: ${threadId}`);

  const messageService = createMessageService({
    collections: context.collections,
    ops,
  });
  const participantCollection = resolveParticipantCollection(context) as
    | ParticipantResolver
    | undefined;
  const historyStartedAt = performance.now();
  let chatHistory: NewMessage[] | null;
  if (typeof historyMode === "object" && historyMode.type === "range") {
    chatHistory = await messageService.getHistoryWindow(
      threadId,
      senderIdForHistory,
      {
        start: historyMode.startMessageId,
        end: historyMode.endMessageId,
      },
    );
  } else if (
    historyMode === "afterReadyLongTermMemory" && longTermMemory
  ) {
    chatHistory = await messageService.getHistoryWindow(
      threadId,
      senderIdForHistory,
      { after: longTermMemory.data.sourceEndMessageId },
    );
  } else {
    chatHistory = await messageService.getHistory(
      threadId,
      senderIdForHistory,
    );
  }
  if (chatHistory === null) {
    const fullHistory = await messageService.getHistory(
      threadId,
      senderIdForHistory,
    );
    chatHistory = typeof historyMode === "object"
      ? sliceMessagesInRange(
        fullHistory,
        historyMode.startMessageId,
        historyMode.endMessageId,
      )
      : historyMode === "afterReadyLongTermMemory" && longTermMemory
      ? fullHistory.slice(
        fullHistory.findIndex((message) =>
          message.id === longTermMemory.data.sourceEndMessageId
        ) + 1,
      )
      : fullHistory;
  }
  if (event && targetAgentId) {
    logAgentInputPhase({
      event,
      threadId,
      agentId: targetAgentId,
      phase: "history_loading",
      startedAt: historyStartedAt,
      detail: {
        messageCount: chatHistory.length,
        bounded: historyMode !== "full",
      },
    });
  }

  const availableAgents = context.agents || [];
  if (availableAgents.length === 0) {
    throw new Error("No agents provided in context for this session");
  }

  const loadedTools = (context.tools || [])
    .map(toExecutableTool)
    .filter((tool): tool is ExecutableTool => Boolean(tool));
  const apiTools = context.apis ? generateAllApiTools(context.apis) : [];
  const mcpTools = context.mcpServers
    ? await generateAllMcpTools(context.mcpServers)
    : [];
  const allTools: ExecutableTool[] = [
    ...loadedTools,
    ...apiTools,
    ...mcpTools,
  ];

  let userMetadata = context.userMetadata;
  const publicThreadMetadata = getPublicThreadMetadata(thread.metadata);
  const userExternalId = getUserExternalId(thread.metadata);

  if (!userMetadata && publicThreadMetadata) {
    const stored = publicThreadMetadata.userContext;
    if (stored && typeof stored === "object") {
      userMetadata = stored as Record<string, unknown>;
    }
  }

  if (!userMetadata && userExternalId) {
    const externalId = userExternalId;
    try {
      if (
        participantCollection &&
        typeof participantCollection.resolveByExternalId === "function"
      ) {
        const participant = await participantCollection.resolveByExternalId(
          externalId,
        );
        if (participant?.metadata && typeof participant.metadata === "object") {
          userMetadata = participant.metadata as Record<string, unknown>;
        }
      }
    } catch (error) {
      console.warn(
        `buildProcessingContext: failed to load user metadata for ${externalId}`,
        error,
      );
    }
  }

  if (userMetadata && !context.userMetadata) {
    context.userMetadata = userMetadata;
  }

  let agentNode: KnowledgeNode | undefined = undefined;
  if (targetAgentId) {
    try {
      if (
        participantCollection &&
        typeof participantCollection.resolveByExternalId === "function"
      ) {
        const participant = await participantCollection.resolveByExternalId(
          targetAgentId,
        );
        if (participant) {
          agentNode = {
            id: participant.id,
            namespace: participant.namespace ?? context.namespace,
            type: "participant",
            name: participant.name ?? targetAgentId,
            content: null,
            embedding: null,
            data: {
              ...participant,
              metadata: participant.metadata ?? null,
            },
            sourceType: "participant",
            sourceId: participant.externalId,
            createdAt: participant.createdAt as Date | undefined,
            updatedAt: participant.updatedAt as Date | undefined,
          } as KnowledgeNode;
        }
      }
    } catch {
      // Agent node is optional; continue without persistent participant memory.
    }
  }

  return {
    thread,
    chatHistory,
    longTermMemory,
    availableAgents,
    allTools,
    userMetadata,
    agentNode,
  };
}

export async function buildAgentLlmInput(
  options: BuildAgentLlmInputOptions,
): Promise<AgentLlmInput> {
  const { deps, event, threadId, agent } = options;
  const context = deps.context;
  const agentId = (agent.id ?? agent.name) as string;
  const thread = await deps.db.ops.getThreadById(threadId);
  if (!thread) throw new Error(`Thread not found: ${threadId}`);
  const longTermMemoryMode = options.longTermMemoryMode ?? "auto";
  const shouldResolveLongTermMemory =
    options.historyMode === "afterReadyLongTermMemory" ||
    longTermMemoryMode === "include";
  const longTermMemory = shouldResolveLongTermMemory
    ? await resolveApplicableLongTermMemory({
      deps,
      thread,
      threadId,
      agentId,
    })
    : null;
  const ctx = await buildProcessingContext(
    deps.db.ops,
    threadId,
    context,
    agentId,
    agentId,
    options.historyMode,
    event,
    longTermMemory,
    thread,
  );
  const selectedHistory = ctx.chatHistory;
  const promptStartedAt = performance.now();

  const agentSkills = filterSkillsForAgent(context.skills ?? [], agent);
  const agentSkillIndex = agentSkills.length > 0
    ? agentSkills.map((skill) => ({
      name: skill.name,
      description: skill.description,
      tags: skill.tags,
    }))
    : undefined;
  const routingTargets = context.multiAgent?.enabled === true
    ? resolveInThreadRoutingTargets(
      agent,
      ctx.thread,
      ctx.availableAgents,
    )
    : { consult: [] };
  const llmContext = contextGenerator(
    agent,
    ctx.thread,
    ctx.availableAgents,
    ctx.availableAgents,
    ctx.userMetadata,
    ctx.agentNode,
    agentSkillIndex,
    context.agentsFileInstructions,
    {
      consult: routingTargets.consult.length > 0,
    },
  );

  const directConversation = isDirectConversationThread(
    ctx.thread,
    ctx.availableAgents,
    agent,
  );
  const generatedHistory: ChatMessage[] = historyGenerator(
    selectedHistory,
    agent,
    {
      directConversation,
      maxToolResultEstimatedTokens: context.toolResultHistoryMaxEstimatedTokens,
      reasoningHistory: context.reasoningHistory,
    },
  );
  const transformedHistory: ChatMessage[] = context.historyTransform
    ? await context.historyTransform({
      messages: generatedHistory,
      rawHistory: selectedHistory,
      thread: ctx.thread,
      agent,
      sourceEvent: event,
      deps,
    })
    : generatedHistory;
  const llmHistory = markLatestExternalRequest(
    transformedHistory,
    selectedHistory,
    agent,
  );

  const allowedToolKeys: string[] = Array.isArray(agent.allowedTools)
    ? agent.allowedTools
    : agent.allowedTools === null
    ? []
    : ctx.allTools.map((tool) => tool.key);
  const agentTools: ExecutableTool[] = allowedToolKeys
    .map((key) => ctx.allTools.find((tool) => tool.key === key))
    .filter((tool): tool is ExecutableTool => Boolean(tool))
    .sort((a, b) => a.key.localeCompare(b.key));
  assertNoRoutingControlToolCollisions(ctx.allTools);
  const routingControlTools = buildRoutingControlToolDefinitions(
    routingTargets,
  );
  const llmTools: ToolDefinition[] = [
    ...routingControlTools,
    ...formatToolsForPrompt(agentTools),
  ];

  let stableSystemPrompt = llmContext.stableSystemPrompt;

  const includeLongTermMemory = longTermMemoryMode === "include" ||
    (longTermMemoryMode === "auto" &&
      options.historyMode === "afterReadyLongTermMemory");

  if (includeLongTermMemory) {
    const longTermMemory = ctx.longTermMemory;
    if (longTermMemory?.node.content) {
      stableSystemPrompt =
        `${stableSystemPrompt}\n\n${longTermMemory.node.content}`;
    }
  }

  const stableSystemContent = withExplicitPromptCacheBreakpoint(
    stableSystemPrompt,
  );
  const dynamicSystemMessages: ChatMessage[] = [
    ...(llmContext.dynamicSystemPrompt
      ? [{ role: "system" as const, content: llmContext.dynamicSystemPrompt }]
      : []),
    ...(context.multiAgent?.enabled === true
      ? [
        buildTurnControlMessage(
          agent,
          event,
          routingTargets.consult.length > 0,
        ),
      ]
      : []),
  ];
  const messages: ChatMessage[] = [
    { role: "system", content: stableSystemContent },
    ...dynamicSystemMessages,
    ...llmHistory,
  ];
  logAgentInputPhase({
    event,
    threadId,
    agentId,
    phase: "prompt_construction",
    startedAt: promptStartedAt,
    detail: {
      rawHistoryCount: selectedHistory.length,
      promptMessageCount: messages.length,
      toolCount: llmTools.length,
    },
  });

  const resolverPayload = {
    agent: { id: agent.id ?? undefined, name: agent.name },
    messages,
    tools: llmTools,
  } as AgentLlmOptionsResolverArgs["payload"];

  let providerConfig: LLMRuntimeConfig = {};
  const agentLlmOptions = agent.llmOptions;
  if (agentLlmOptions) {
    if (typeof agentLlmOptions === "function") {
      try {
        const dynamicConfig = await agentLlmOptions({
          payload: resolverPayload,
          sourceEvent: event,
          deps,
        });
        if (dynamicConfig && typeof dynamicConfig === "object") {
          providerConfig = dynamicConfig;
        }
      } catch (error) {
        console.warn(
          `[agent_llm_input] Failed to resolve dynamic llmOptions for agent "${
            agent.name ?? agent.id
          }":`,
          error,
        );
      }
    } else {
      providerConfig = agentLlmOptions;
    }
  }

  const config = toLLMConfig(providerConfig);
  resolverPayload.config = config;

  return {
    thread: ctx.thread,
    rawHistory: selectedHistory,
    messages,
    tools: llmTools,
    config,
    runtimeConfig: providerConfig,
    agentNode: ctx.agentNode,
    userMetadata: ctx.userMetadata,
  };
}
