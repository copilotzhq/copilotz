import { chat } from "@/runtime/llm/index.ts";
import type {
  ChatMessage,
  ChatRequest,
  ChatResponse,
  CostBreakdown,
  LLMConfig,
  LLMRuntimeConfig,
  ProviderConfig,
  TokenUsage,
  ToolInvocation,
} from "@/runtime/llm/types.ts";
import { mergeLLMRuntimeConfig, toLLMConfig } from "@/runtime/llm/config.ts";
import type {
  AgentLlmOptionsResolverArgs,
  Event,
  EventProcessor,
  LlmCallEventPayload,
  LlmResultEventPayload,
  MessagePayload,
  NewEvent,
  ProcessorDeps,
  TokenEventPayload,
} from "@/types/index.ts";
import { ulid } from "ulid";
import { resolveAssetRefsInMessages } from "@/runtime/storage/assets.ts";
import { filterToolCallTokensStreaming } from "@/runtime/llm/utils.ts";
import { buildMentionTargetRoute } from "@/utils/mentions.ts";
import type { Agent, Thread } from "@/types/index.ts";
import { createLlmUsageService } from "@/runtime/collections/native.ts";

export type { ChatMessage };

export type LLMCallPayload = LlmCallEventPayload;
export type LLMResultPayload = LlmResultEventPayload;

const escapeRegex = (string: string): string =>
  string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function resolveAgentResponseTarget(
  routeTargets: string[],
  agent: { id?: string | null; name?: string | null },
  sourceEvent: Event,
  multiAgentEnabled: boolean,
): { targetId: string | null; targetQueue: string[] } {
  // Get source event metadata for target queue
  const eventMetadata = sourceEvent.metadata as Record<string, unknown> | null;
  const sourceTargetQueue = (eventMetadata?.targetQueue as string[] | null) ??
    [];
  const sourceSenderId =
    (eventMetadata?.sourceMessageSenderId as string | null) ?? null;

  if (!multiAgentEnabled) {
    return {
      targetId: sourceSenderId,
      targetQueue: [],
    };
  }

  const selfIdentifiers = new Set(
    [agent.id, agent.name]
      .filter((value): value is string =>
        typeof value === "string" && value.trim().length > 0
      )
      .map((value) => value.toLowerCase()),
  );

  const normalizedRouteTargets = routeTargets.filter((target) =>
    typeof target === "string" && target.trim().length > 0 &&
    !selfIdentifiers.has(target.trim().toLowerCase())
  );

  const mentionRoute = buildMentionTargetRoute(normalizedRouteTargets, {
    returnTarget: sourceSenderId,
    fallbackQueue: sourceTargetQueue,
  });
  if (mentionRoute) return mentionRoute;

  if (sourceTargetQueue.length > 0) {
    const nextTarget = sourceTargetQueue[0];
    const remainingQueue = sourceTargetQueue.slice(1);
    return { targetId: nextTarget, targetQueue: remainingQueue };
  }

  // Default: respond to whoever sent the message (via source metadata)
  return {
    targetId: sourceSenderId,
    targetQueue: [],
  };
}

export function shouldEmitAgentMessage(
  answer: string | undefined,
  toolCalls: ToolInvocation[] | undefined,
  routeTargets: string[],
  askTargets: string[],
): boolean {
  return Boolean(
    (typeof answer === "string" && answer.length > 0) ||
      (Array.isArray(toolCalls) && toolCalls.length > 0) ||
      routeTargets.length > 0 ||
      askTargets.length > 0,
  );
}

export function assertAgentLLMConfig(
  agent: { id?: string | null; name?: string | null },
  config: Partial<LLMRuntimeConfig> | undefined,
): void {
  const missing: string[] = [];
  if (!config?.provider) missing.push("provider");
  if (!config?.model) missing.push("model");
  if (missing.length === 0) return;

  const agentLabel = agent.name ?? agent.id ?? "unknown";
  throw new Error(
    `Agent "${agentLabel}" is missing required llmOptions (${
      missing.join(", ")
    }). ` +
      `Configure llmOptions on that agent, or provide shared defaults with ` +
      `createCopilotz({ agent: { llmOptions: { provider, model, ... } } }).`,
  );
}

function resolveAgentIdentity(
  agent: { id?: string | null; name?: string | null },
): string | null {
  const value = agent.id ?? agent.name;
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function resolveAgentRouteTargets(
  extractedTags: Record<string, string[]> | undefined,
  currentAgent: { id?: string | null; name?: string | null },
  senderAgent: Agent | undefined,
  thread: Thread,
  availableAgents: Agent[],
): string[] {
  const rawTargets = Array.isArray(extractedTags?.route_to)
    ? extractedTags.route_to
    : [];
  if (rawTargets.length === 0) return [];

  const participants = Array.isArray(thread.participants)
    ? thread.participants.filter((value): value is string =>
      typeof value === "string" && value.trim().length > 0
    )
    : [];
  const selfIdentifiers = new Set(
    [currentAgent.id, currentAgent.name]
      .filter((value): value is string =>
        typeof value === "string" && value.trim().length > 0
      )
      .map((value) => value.toLowerCase()),
  );
  const allowedAgents = Array.isArray(senderAgent?.allowedAgents) &&
      senderAgent.allowedAgents.length > 0
    ? new Set(senderAgent.allowedAgents.map((value) => value.toLowerCase()))
    : null;
  const resolved: string[] = [];
  const seen = new Set<string>();

  for (const rawTarget of rawTargets) {
    const candidate = rawTarget.trim();
    if (candidate.length === 0) continue;

    const matchedAgent = availableAgents.find((availableAgent) =>
      (typeof availableAgent.id === "string" &&
        availableAgent.id.toLowerCase() === candidate.toLowerCase()) ||
      (typeof availableAgent.name === "string" &&
        availableAgent.name.toLowerCase() === candidate.toLowerCase())
    );
    if (!matchedAgent) continue;

    const canonicalId = (matchedAgent.id ?? matchedAgent.name) as string;
    const canonicalLower = canonicalId.toLowerCase();
    if (selfIdentifiers.has(canonicalLower)) continue;

    const isParticipant = participants.some((participant) => {
      const participantLower = participant.toLowerCase();
      return participantLower === canonicalLower ||
        (typeof matchedAgent.id === "string" &&
          participantLower === matchedAgent.id.toLowerCase()) ||
        (typeof matchedAgent.name === "string" &&
          participantLower === matchedAgent.name.toLowerCase());
    });
    if (!isParticipant) continue;

    if (
      allowedAgents &&
      !allowedAgents.has(canonicalLower) &&
      !(typeof matchedAgent.id === "string" &&
        allowedAgents.has(matchedAgent.id.toLowerCase())) &&
      !(typeof matchedAgent.name === "string" &&
        allowedAgents.has(matchedAgent.name.toLowerCase()))
    ) {
      continue;
    }

    if (seen.has(canonicalLower)) continue;
    resolved.push(canonicalId);
    seen.add(canonicalLower);
  }

  return resolved;
}

function resolveAgentAskTargets(
  extractedTags: Record<string, string[]> | undefined,
  currentAgent: { id?: string | null; name?: string | null },
  senderAgent: Agent | undefined,
  thread: Thread,
  availableAgents: Agent[],
): string[] {
  const rawTargets = Array.isArray(extractedTags?.ask_to)
    ? extractedTags.ask_to
    : [];
  if (rawTargets.length === 0) return [];

  return resolveAgentRouteTargets(
    { route_to: rawTargets },
    currentAgent,
    senderAgent,
    thread,
    availableAgents,
  );
}

function buildAskTargetRoute(
  askTargetId: string,
  currentAgent: { id?: string | null; name?: string | null },
  sourceEvent: Event,
): { targetId: string; targetQueue: string[] } {
  const eventMetadata = sourceEvent.metadata as Record<string, unknown> | null;
  const sourceTargetQueue = (eventMetadata?.targetQueue as string[] | null) ??
    [];
  const sourceSenderId =
    (eventMetadata?.sourceMessageSenderId as string | null) ?? null;
  const currentAgentId = resolveAgentIdentity(currentAgent);

  return buildMentionTargetRoute([askTargetId], {
    returnTarget: currentAgentId,
    fallbackQueue: [
      ...(typeof sourceSenderId === "string" ? [sourceSenderId] : []),
      ...sourceTargetQueue,
    ],
  }) ?? { targetId: askTargetId, targetQueue: [] };
}

export const llmCallProcessor: EventProcessor<LLMCallPayload, ProcessorDeps> = {
  shouldProcess: () => true,
  process: async (event: Event, deps: ProcessorDeps) => {
    const payload = event.payload as LlmCallEventPayload;

    const threadId = typeof event.threadId === "string"
      ? event.threadId
      : (() => {
        throw new Error("Invalid thread id for LLM call event");
      })();

    // Get context from dependencies
    const context = deps.context;

    // Defense-in-depth: the shared processStream already filters
    // <function_calls> blocks, but we keep a second pass here in case
    // any slip through (e.g. non-standard provider integration).
    const toolCallFilterState: {
      inside: boolean;
      pending: string;
      controlPending: string;
    } = {
      inside: false,
      pending: "",
      controlPending: "",
    };

    const buildTokenEvent = (
      token: string,
      isComplete: boolean,
      isReasoning?: boolean,
    ): Event => {
      const tokenPayload: TokenEventPayload = {
        threadId,
        agent: {
          id: payload.agent.id ?? undefined,
          name: payload.agent.name,
        },
        token,
        isComplete,
        isReasoning,
      };
      return {
        id: ulid(),
        threadId,
        type: "TOKEN",
        payload: tokenPayload,
        parentEventId: null,
        traceId: null,
        priority: null,
        metadata: null,
        ttlMs: null,
        expiresAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        status: isComplete ? "completed" : "processing",
      };
    };

    const streamCallback = (context.stream && deps.emitToStream)
      ? (token: string, options?: { isReasoning?: boolean }) => {
        const filtered = options?.isReasoning
          ? token
          : filterToolCallTokensStreaming(token, toolCallFilterState);

        deps.emitToStream(
          buildTokenEvent(filtered, false, options?.isReasoning),
        );
      }
      : undefined;

    const envVars: Record<string, string> = (() => {
      try {
        const anyGlobal = globalThis as unknown as {
          Deno?: { env?: { toObject?: () => Record<string, string> } };
          process?: { env?: Record<string, string | undefined> };
        };
        const fromDeno = anyGlobal?.Deno?.env?.toObject?.();
        if (fromDeno && typeof fromDeno === "object") return fromDeno;
        const fromNode = anyGlobal?.process?.env;
        if (fromNode && typeof fromNode === "object") {
          const out: Record<string, string> = {};
          for (const [k, v] of Object.entries(fromNode)) {
            if (typeof v === "string") out[k] = v;
          }
          return out;
        }
      } catch {
        // ignore
      }
      return {};
    })();

    // Per-agent resolveInLLM takes precedence over the global asset config.
    const agentForAssets = context.agents?.find((a) =>
      a.id === payload.agent.id
    );
    const perAgentResolve = agentForAssets?.assetOptions?.resolveInLLM;
    const shouldResolve = perAgentResolve !== undefined
      ? perAgentResolve
      : context.assetConfig?.resolveInLLM !== false;
    const resolvedMessages = await (async () => {
      try {
        if (shouldResolve) {
          // Warn if resolution is expected but store is missing
          if (!context.assetStore) {
            try {
              const anyGlobal = globalThis as unknown as {
                Deno?: { env?: { get?: (key: string) => string | undefined } };
                console?: { warn?: (...args: unknown[]) => void };
              };
              const debugFlag = anyGlobal?.Deno?.env?.get?.("COPILOTZ_DEBUG");
              if (debugFlag === "1" && anyGlobal.console?.warn) {
                anyGlobal.console.warn(
                  "[llm_call] resolveInLLM is true but assetStore is undefined - asset refs will not be resolved",
                );
              }
            } catch {
              // ignore logging failures
            }
          }
          const res = await resolveAssetRefsInMessages(
            payload.messages as ChatMessage[],
            context.assetStore,
          );
          return res.messages;
        }
        const msgs = (payload.messages as ChatMessage[]).map((m) => {
          if (Array.isArray(m.content)) {
            const textOnly = m.content
              .map((p) =>
                (p && typeof p === "object" &&
                    (p as { type?: string }).type === "text")
                  ? (p as { text?: string }).text ?? ""
                  : ""
              )
              .join("");
            return { ...m, content: textOnly };
          }
          return m;
        });
        return msgs;
      } catch (err) {
        // In debug mode, surface the underlying error so asset resolution issues are visible.
        try {
          const anyGlobal = globalThis as unknown as {
            Deno?: {
              env?: { get?: (key: string) => string | undefined };
              stderr?: { writeSync?: (data: Uint8Array) => unknown };
            };
            console?: { warn?: (...args: unknown[]) => void };
          };
          const debugFlag = anyGlobal?.Deno?.env?.get?.("COPILOTZ_DEBUG");
          if (debugFlag === "1" && anyGlobal.console?.warn) {
            anyGlobal.console.warn(
              "[llm_call] resolveAssetRefsInMessages failed:",
              err,
            );
          }
        } catch {
          // ignore logging failures
        }
        return payload.messages as ChatMessage[];
      }
    })();

    const agentForCall = context.agents?.find((a) => a.id === payload.agent.id);
    const persistedConfig = (payload.config ?? {}) as LLMConfig;

    let agentRuntimeConfig: LLMRuntimeConfig | undefined;
    if (agentForCall?.llmOptions) {
      if (typeof agentForCall.llmOptions === "function") {
        const runtimePayload = {
          agent: {
            id: payload.agent.id ?? undefined,
            name: payload.agent.name,
          },
          messages: payload.messages as ChatMessage[],
          tools: payload.tools,
          config: persistedConfig,
        } as AgentLlmOptionsResolverArgs["payload"];
        const resolved = await agentForCall.llmOptions({
          payload: runtimePayload,
          sourceEvent: event,
          deps,
        });
        if (resolved && typeof resolved === "object") {
          agentRuntimeConfig = resolved;
        }
      } else {
        agentRuntimeConfig = agentForCall.llmOptions;
      }
    }

    const securityRuntimeConfig = await context.security
      ?.resolveLLMRuntimeConfig?.({
        provider: persistedConfig.provider,
        model: persistedConfig.model,
        agent: { id: payload.agent.id ?? undefined, name: payload.agent.name },
        config: persistedConfig,
        sourceEvent: event,
        deps,
      });

    const configForCall: ProviderConfig = mergeLLMRuntimeConfig(
      persistedConfig,
      agentRuntimeConfig,
      securityRuntimeConfig,
    );

    assertAgentLLMConfig(
      { id: payload.agent.id ?? null, name: payload.agent.name },
      configForCall,
    );

    if (Deno.env.get("COPILOTZ_DEBUG") === "1") {
      console.log("shouldResolve", shouldResolve);
      console.log("hasAssetStore", !!context.assetStore);
      console.log("configForCall", toLLMConfig(configForCall));
      console.log("resolvedMessages", resolvedMessages);
    }

    const response = await chat(
      {
        messages: resolvedMessages,
        tools: payload.tools,
        extractTags: ["route_to", "ask_to"],
      } as ChatRequest,
      configForCall,
      envVars,
      streamCallback,
      context.llmProviders,
    );

    const llmResponse = response as unknown as ChatResponse;
    let usageNodeId: string | null = null;
    const llmUsageService = createLlmUsageService({
      collections: deps.context.collections,
      ops: deps.db.ops,
    });

    // finalize stream
    if (streamCallback && deps.emitToStream) {
      deps.emitToStream(buildTokenEvent("", true));
    }

    // Clean response
    let answer: string | undefined = ("answer" in llmResponse)
      ? (llmResponse as unknown as { answer?: string }).answer
      : undefined;
    const reasoning: string | undefined = ("reasoning" in llmResponse)
      ? (llmResponse as unknown as { reasoning?: string }).reasoning
      : undefined;
    const toolCalls: ToolInvocation[] | undefined = ("toolCalls" in llmResponse)
      ? (llmResponse as unknown as { toolCalls?: ToolInvocation[] }).toolCalls
      : undefined;
    const extractedTags: Record<string, string[]> | undefined =
      ("extractedTags" in llmResponse)
        ? (llmResponse as unknown as {
          extractedTags?: Record<string, string[]>;
        }).extractedTags
        : undefined;
    const usage: TokenUsage | undefined = ("usage" in llmResponse)
      ? (llmResponse as unknown as { usage?: TokenUsage }).usage
      : undefined;
    const cost: CostBreakdown | undefined = ("cost" in llmResponse)
      ? (llmResponse as unknown as { cost?: CostBreakdown }).cost
      : undefined;

    if (usage) {
      try {
        usageNodeId = await llmUsageService.createUsageRecord({
          threadId,
          eventId: typeof event.id === "string" ? event.id : null,
          agentId: (payload.agent.id ?? payload.agent.name) as string | null,
          provider: llmResponse.provider ?? null,
          model: llmResponse.model ?? null,
          usage,
          cost: {
            inputCostUsd: cost?.inputCostUsd ?? null,
            outputCostUsd: cost?.outputCostUsd ?? null,
            totalCostUsd: cost?.totalCostUsd ?? null,
          },
        });
      } catch (error) {
        console.warn("[LLM_CALL] Failed to persist llm_usage node:", error);
      }
    }

    if (Deno.env.get("COPILOTZ_DEBUG") === "1") {
      console.log("answer", answer);
      console.log("reasoning", reasoning);
      console.log("toolCalls", toolCalls);
      console.log("extractedTags", extractedTags);
    }

    if (answer) {
      const selfPrefixPattern = new RegExp(
        `^(\\[${escapeRegex(payload.agent.name)}\\]:\\s*|@${
          escapeRegex(payload.agent.name)
        }\\b(:\\s*|\\s+))`,
        "i",
      );
      answer = answer.replace(selfPrefixPattern, "");
    }

    // Generate batch metadata for multiple tool calls
    const batchId = Array.isArray(toolCalls) && toolCalls.length > 1
      ? crypto.randomUUID()
      : null;
    const batchSize = Array.isArray(toolCalls) && toolCalls.length > 1
      ? toolCalls.length
      : null;

    const normalizedToolCalls = Array.isArray(toolCalls)
      ? toolCalls.map((call, index) => {
        let parsedArgs: Record<string, unknown> = {};
        try {
          parsedArgs = typeof call?.args === "string"
            ? JSON.parse(call.args)
            : (call?.args || {});
        } catch (_err) {
          parsedArgs = {};
        }
        return {
          id: call?.id ?? null,
          tool: { id: call?.tool?.id ?? "", name: call?.tool?.name },
          args: parsedArgs,
          // Include batch info for tool call aggregation
          batchId,
          batchSize,
          batchIndex: batchId ? index : null,
        };
      })
      : undefined;

    // Resolve target for agent's response (based on explicit route tags or queue)
    const routeTargets = resolveAgentRouteTargets(
      extractedTags,
      {
        id: payload.agent.id ?? null,
        name: payload.agent.name,
      },
      agentForCall,
      deps.thread,
      context.agents ?? [],
    );
    const askTargets = resolveAgentAskTargets(
      extractedTags,
      {
        id: payload.agent.id ?? null,
        name: payload.agent.name,
      },
      agentForCall,
      deps.thread,
      context.agents ?? [],
    );
    if (!shouldEmitAgentMessage(answer, toolCalls, routeTargets, askTargets)) {
      return { producedEvents: [] };
    }
    const responseTarget = askTargets.length > 0
      ? buildAskTargetRoute(
        askTargets[0],
        {
          id: payload.agent.id ?? null,
          name: payload.agent.name,
        },
        event,
      )
      : resolveAgentResponseTarget(
        routeTargets,
        {
          id: payload.agent.id ?? null,
          name: payload.agent.name,
        },
        event,
        context.multiAgent?.enabled === true,
      );

    const llmResultPayload: LlmResultEventPayload = {
      llmCallId: typeof event.id === "string" ? event.id : ulid(),
      agent: {
        id: payload.agent.id ?? undefined,
        name: payload.agent.name,
      },
      provider: llmResponse.provider ?? null,
      model: llmResponse.model ?? null,
      status: "completed",
      finishReason:
        Array.isArray(normalizedToolCalls) && normalizedToolCalls.length > 0
          ? "tool_calls"
          : "stop",
      answer: answer ?? null,
      reasoning: reasoning ?? null,
      toolCalls: normalizedToolCalls ?? null,
      extractedTags: extractedTags ?? null,
      ...(usage ? { usage } : {}),
      ...(cost ? { cost } : {}),
      ...(usageNodeId ? { usageNodeId } : {}),
      finishedAt: new Date().toISOString(),
    };

    const resultMetadata: Record<string, unknown> = {
      targetId: responseTarget.targetId,
      targetQueue: responseTarget.targetQueue,
      ...(routeTargets.length > 0
        ? {
          routing: {
            routeTo: routeTargets,
          },
        }
        : {}),
      ...(askTargets.length > 0
        ? {
          routing: {
            ...(routeTargets.length > 0 ? { routeTo: routeTargets } : {}),
            askTo: askTargets,
          },
        }
        : {}),
    };

    const producedEvents: NewEvent[] = [{
      threadId,
      type: "LLM_RESULT",
      payload: llmResultPayload,
      parentEventId: typeof event.id === "string" ? event.id : undefined,
      traceId: typeof event.traceId === "string" ? event.traceId : undefined,
      priority: typeof event.priority === "number" ? event.priority : undefined,
      metadata: resultMetadata,
    }];

    return { producedEvents };
  },
};

export const { shouldProcess, process } = llmCallProcessor;
