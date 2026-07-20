import {
  chat,
  classifyLLMError,
  LLMProviderError,
} from "@/runtime/llm/index.ts";
import type {
  ChatMessage,
  ChatRequest,
  ChatResponse,
  CostBreakdown,
  LLMConfig,
  LLMRuntimeConfig,
  LLMUsageAttempt,
  ProviderConfig,
  TokenUsage,
  ToolInvocation,
} from "@/runtime/llm/types.ts";
import {
  mergeLLMRuntimeConfig,
  readRuntimeEnvironment,
  toLLMConfig,
} from "@/runtime/llm/config.ts";
import type {
  AgentLlmOptionsResolverArgs,
  Event,
  EventProcessor,
  LlmCallEventPayload,
  LlmResultEventPayload,
  NewEvent,
  ProcessorDeps,
  TokenEventPayload,
} from "@/types/index.ts";
import { ulid } from "ulid";
import { materializeAssetRefsForProvider } from "@/runtime/llm/asset-materialization.ts";
import { createLlmUsageService } from "@/runtime/collections/native.ts";
import { EVENT_PRIORITIES } from "@/runtime/event-priority.ts";
import {
  getRuntimeThreadMetadata,
  getSerializableThreadMetadata,
  setRuntimeThreadMetadata,
} from "@/runtime/thread-metadata.ts";
import {
  resolveInThreadRoutingTargets,
  type RoutingControlIntent,
  type RoutingControlSelection,
  selectRoutingControl,
} from "@/runtime/routing/index.ts";

export const processorId = "llm_call";
export const eventTypes = ["llm_attempt.created"] as const;

export type { ChatMessage };

export type LLMCallPayload = LlmCallEventPayload;
export type LLMResultPayload = LlmResultEventPayload;

const escapeRegex = (string: string): string =>
  string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const LLM_PARTIAL_PERSIST_INTERVAL_MS = 10_000;

function envFlagEnabled(name: string): boolean {
  try {
    return Deno.env.get(name) === "1";
  } catch {
    return false;
  }
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

function getProviderFailureMessage(error: LLMProviderError): string {
  if (error.reason === "invalid_transcript") {
    return "The conversation history could not be prepared for the model.";
  }
  if (error.reason === "rate_limit") {
    return "Model is temporarily unavailable. Please try again in a few moments.";
  }
  if (error.reason === "timeout") {
    return "The response took longer than expected. Please try again in a few moments.";
  }
  return "Model is temporarily unavailable. Please try again in a few moments.";
}

function isRetryableLLMReason(reason: string | null): boolean {
  return reason === "rate_limit" ||
    reason === "timeout" ||
    reason === "network" ||
    reason === "auth_error" ||
    reason === "server_error" ||
    reason === "provider_error" ||
    reason === "unknown";
}

export const llmCallProcessor: EventProcessor<LLMCallPayload, ProcessorDeps> = {
  shouldProcess: () => true,
  process: async (event: Event, deps: ProcessorDeps) => {
    const eventType = (event as unknown as { type?: string }).type;
    const isLifecycleAttemptCreated = eventType === "llm_attempt.created";
    const payload = event.payload as LlmCallEventPayload;

    const threadId = typeof event.threadId === "string"
      ? event.threadId
      : (() => {
        throw new Error("Invalid thread id for LLM call event");
      })();

    // Get context from dependencies
    const context = deps.context;
    let markedVisibleOutputStarted = false;
    const markVisibleOutputStarted = () => {
      if (markedVisibleOutputStarted || typeof event.id !== "string") return;
      markedVisibleOutputStarted = true;
      void deps.db?.ops?.mergeQueueItemMetadata?.(event.id, {
        visibleOutputStarted: true,
        visibleOutputStartedAt: new Date().toISOString(),
      }).catch((error: unknown) => {
        console.warn(
          "[LLM_CALL] Failed to mark visible output progress:",
          error,
        );
      });
    };

    let llmAttemptId: string | null = null;
    let terminalLlmAttemptId: string | null = null;
    let partialAnswer = "";
    let partialReasoning = "";
    let lastPartialPersistedAt = 0;
    let lastPartialPersistPromise: Promise<void> = Promise.resolve();
    let partialPersistRequested = false;
    let partialPersistRunning = false;
    const isSuperseded = () => deps.cancellation?.isAborted() === true;
    const cancellationReason = () => deps.cancellation?.reason?.() ?? null;

    const persistPartialAttempt = (force = false): Promise<void> => {
      if (!llmAttemptId || !deps.db?.ops?.mutate?.llmAttempts) {
        return Promise.resolve();
      }
      const now = Date.now();
      if (
        !force &&
        now - lastPartialPersistedAt < LLM_PARTIAL_PERSIST_INTERVAL_MS
      ) return lastPartialPersistPromise;
      lastPartialPersistedAt = now;
      partialPersistRequested = true;
      if (partialPersistRunning) return lastPartialPersistPromise;

      partialPersistRunning = true;
      lastPartialPersistPromise = (async () => {
        try {
          while (partialPersistRequested) {
            partialPersistRequested = false;
            const snapshot = {
              partialAnswer,
              partialReasoning,
            };
            try {
              await deps.db.ops.mutate.llmAttempts.update(
                llmAttemptId,
                {
                  status: "processing",
                  ...snapshot,
                },
                {
                  threadId,
                  traceId: typeof event.traceId === "string"
                    ? event.traceId
                    : null,
                  causationId: typeof event.id === "string" ? event.id : null,
                  namespace: context.namespace,
                },
              );
            } catch (error) {
              console.warn(
                "[LLM_CALL] Failed to persist llm_attempt partial:",
                error,
              );
            }
          }
        } finally {
          partialPersistRunning = false;
        }
      })();
      return lastPartialPersistPromise;
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

    if (isLifecycleAttemptCreated) {
      llmAttemptId =
        typeof (event as unknown as { subjectId?: unknown }).subjectId ===
            "string"
          ? (event as unknown as { subjectId: string }).subjectId
          : null;
      terminalLlmAttemptId = llmAttemptId;
      if (llmAttemptId) {
        deps.emitToStream({
          ...event,
          type: "LLM_CALL",
          payload,
        } as Event);
      }
    }

    const routingAgent = context.agents?.find((agent) => {
      const agentId = payload.agent.id?.toLowerCase();
      const agentName = payload.agent.name.toLowerCase();
      return (typeof agent.id === "string" &&
        (agent.id.toLowerCase() === agentId ||
          agent.id.toLowerCase() === agentName)) ||
        agent.name.toLowerCase() === agentName ||
        agent.name.toLowerCase() === agentId;
    });
    const routingTargets = context.multiAgent?.enabled === true && routingAgent
      ? resolveInThreadRoutingTargets(
        routingAgent,
        deps.thread,
        context.agents ?? [],
      )
      : { ask: [], handoff: [] };

    const processStreamToken = (context.stream && deps.emitToStream)
      ? (token: string, options?: { isReasoning?: boolean }) => {
        if (
          !options?.isReasoning &&
          token.trim().length > 0
        ) {
          markVisibleOutputStarted();
        }
        if (options?.isReasoning) {
          partialReasoning += token;
        } else if (token) {
          partialAnswer += token;
        }
        if (!isSuperseded() && token) persistPartialAttempt();

        if (isSuperseded()) return;

        deps.emitToStream(
          buildTokenEvent(token, false, options?.isReasoning),
        );
      }
      : undefined;
    const streamCallback = processStreamToken;

    const envVars = readRuntimeEnvironment();

    // Per-agent resolveInLLM takes precedence over the global asset config.
    const agentForAssets = context.agents?.find((a) =>
      a.id === payload.agent.id
    );
    const perAgentResolve = agentForAssets?.assetOptions?.resolveInLLM;
    const shouldResolve = perAgentResolve !== undefined
      ? perAgentResolve
      : context.assetConfig?.resolveInLLM !== false;
    if (shouldResolve && !context.assetStore) {
      try {
        const anyGlobal = globalThis as unknown as {
          Deno?: { env?: { get?: (key: string) => string | undefined } };
          console?: { warn?: (...args: unknown[]) => void };
        };
        const debugFlag = anyGlobal?.Deno?.env?.get?.("COPILOTZ_DEBUG");
        if (debugFlag === "1" && anyGlobal.console?.warn) {
          anyGlobal.console.warn(
            "[llm_call] resolveInLLM is true but assetStore is undefined - asset refs will be omitted from provider media parts",
          );
        }
      } catch {
        // ignore logging failures
      }
    }

    const baseMessages = shouldResolve
      ? payload.messages as ChatMessage[]
      : (payload.messages as ChatMessage[]).map((m) => {
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

    const materializeMessages = shouldResolve
      ? async (messages: ChatMessage[], providerConfig: ProviderConfig) => {
        try {
          return await materializeAssetRefsForProvider(
            messages,
            providerConfig,
            context.assetStore,
          );
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
                "[llm_call] materializeAssetRefsForProvider failed:",
                err,
              );
            }
          } catch {
            // ignore logging failures
          }
          return messages;
        }
      }
      : undefined;

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
    const configuredProvider = configForCall.provider!;

    if (envFlagEnabled("COPILOTZ_DEBUG")) {
      console.log("shouldResolve", shouldResolve);
      console.log("hasAssetStore", !!context.assetStore);
      console.log("configForCall", toLLMConfig(configForCall));
      console.log("baseMessages", baseMessages);
    }

    const eventMetadata = event.metadata &&
        typeof event.metadata === "object" &&
        !Array.isArray(event.metadata)
      ? event.metadata as Record<string, unknown>
      : {};
    const baseResultMetadata: Record<string, unknown> = {
      ...(typeof eventMetadata.targetId === "string"
        ? { targetId: eventMetadata.targetId }
        : {}),
      ...(Array.isArray(eventMetadata.targetQueue)
        ? {
          targetQueue: eventMetadata.targetQueue.filter((
            target,
          ): target is string => typeof target === "string"),
        }
        : {}),
      ...(typeof eventMetadata.sourceMessageSenderId === "string"
        ? { sourceMessageSenderId: eventMetadata.sourceMessageSenderId }
        : {}),
      ...(typeof eventMetadata.sourceMessageSenderType === "string"
        ? { sourceMessageSenderType: eventMetadata.sourceMessageSenderType }
        : {}),
      ...(eventMetadata.runSender &&
          typeof eventMetadata.runSender === "object" &&
          !Array.isArray(eventMetadata.runSender)
        ? { runSender: eventMetadata.runSender }
        : {}),
    };

    const sourceMessageId = typeof eventMetadata.sourceMessageId === "string"
      ? eventMetadata.sourceMessageId
      : null;
    const runSender = eventMetadata.runSender &&
        typeof eventMetadata.runSender === "object" &&
        !Array.isArray(eventMetadata.runSender)
      ? eventMetadata.runSender as Record<string, unknown>
      : null;
    if (!isLifecycleAttemptCreated && deps.db?.ops?.mutate?.llmAttempts) {
      try {
        const attempt = await deps.db.ops.mutate.llmAttempts.create({
          threadId,
          messageId: sourceMessageId,
          eventId: typeof event.id === "string" ? event.id : null,
          agentId: payload.agent.id ?? payload.agent.name ?? null,
          agentName: payload.agent.name,
          provider: configForCall.provider ?? null,
          model: configForCall.model ?? null,
          config: toLLMConfig(configForCall) as Record<string, unknown>,
          messages: baseMessages,
          tools: payload.tools,
          status: "processing",
          runSender,
          namespace: context.namespace,
          metadata: {
            sourceEventType: event.type,
          },
        });
        llmAttemptId = String(attempt.id);
        terminalLlmAttemptId = llmAttemptId;
        baseResultMetadata.llmAttemptId = terminalLlmAttemptId;
      } catch (error) {
        console.warn("[LLM_CALL] Failed to create llm_attempt node:", error);
      }
    }

    let usageNodeId: string | null = null;
    const usageEnabled = deps.context.usage?.enabled !== false;
    const llmUsageService = deps.db?.ops && usageEnabled
      ? createLlmUsageService({
        collections: deps.context.collections,
        ops: deps.db.ops,
        usageOptions: deps.context.usage,
      })
      : null;
    const persistUsageRecords = async (
      records: LLMUsageAttempt[],
      fallbackFinalized?: ChatResponse["usageFinalized"],
    ): Promise<void> => {
      for (let index = 0; index < records.length; index += 1) {
        const record = records[index];
        let canonicalAttemptId = index === 0 ? llmAttemptId : null;
        if (!canonicalAttemptId && deps.db?.ops?.mutate?.llmAttempts) {
          try {
            const attempt = await deps.db.ops.mutate.llmAttempts.create({
              threadId,
              messageId: sourceMessageId,
              eventId: typeof event.id === "string" ? event.id : null,
              agentId: payload.agent.id ?? payload.agent.name ?? null,
              agentName: payload.agent.name,
              provider: record.provider ?? null,
              model: record.model ?? null,
              messages: record.messages ?? null,
              status: "completed",
              attemptIndex: index,
              parentAttemptId: llmAttemptId,
              runSender,
              namespace: context.namespace,
              debug: record.debug ?? null,
              metadata: {
                sourceEventType: event.type,
                usageOnly: true,
              },
            });
            canonicalAttemptId = String(attempt.id);
          } catch (error) {
            console.warn(
              "[LLM_CALL] Failed to create usage llm_attempt node:",
              error,
            );
          }
        }

        if (canonicalAttemptId && deps.db?.ops?.mutate?.llmAttempts) {
          terminalLlmAttemptId = canonicalAttemptId;
          try {
            const usageStatusReason = record.usage &&
                typeof record.usage === "object"
              ? (record.usage as { statusReason?: unknown }).statusReason
              : undefined;
            const isRecoveredFailure = index < records.length - 1 &&
              typeof usageStatusReason === "string";
            const attemptPatch = {
              provider: record.provider ?? null,
              model: record.model ?? null,
              ...(record.messages !== undefined
                ? { messages: record.messages }
                : {}),
              ...(record.debug !== undefined ? { debug: record.debug } : {}),
              usage: record.usage,
              cost: record.cost ?? null,
              ...(record.partialAnswer !== undefined
                ? { partialAnswer: record.partialAnswer }
                : {}),
              ...(record.partialReasoning !== undefined
                ? { partialReasoning: record.partialReasoning }
                : {}),
            };
            const mutationOptions = {
              threadId,
              traceId: typeof event.traceId === "string" ? event.traceId : null,
              causationId: typeof event.id === "string" ? event.id : null,
              namespace: context.namespace,
            };
            if (isRecoveredFailure) {
              await deps.db.ops.mutate.llmAttempts.fail(
                canonicalAttemptId,
                {
                  ...attemptPatch,
                  finishReason: "error",
                  error: {
                    reason: usageStatusReason,
                    status: record.error?.status ?? null,
                    message: record.error?.message ?? null,
                    recovered: true,
                    visibleOutputStarted: record.visibleOutputStarted ?? false,
                  },
                  finishedAt: new Date().toISOString(),
                },
                mutationOptions,
              );
            } else {
              await deps.db.ops.mutate.llmAttempts.update(
                canonicalAttemptId,
                attemptPatch,
                mutationOptions,
              );
            }
          } catch (error) {
            console.warn(
              "[LLM_CALL] Failed to persist llm_attempt usage:",
              error,
            );
          }
        }

        if (!llmUsageService) continue;
        try {
          const createdUsageNodeId = await llmUsageService.createUsageRecord({
            threadId,
            eventId: typeof event.id === "string" ? event.id : null,
            agentId: (payload.agent.id ?? payload.agent.name) as string | null,
            runSender,
            provider: record.provider ?? null,
            model: record.model ?? null,
            usage: record.usage,
            cost: record.cost ?? null,
          });
          usageNodeId = createdUsageNodeId ?? usageNodeId;
          const finalized = record.usageFinalized ??
            (index === records.length - 1 ? fallbackFinalized : undefined);
          if (createdUsageNodeId && finalized) {
            void finalized.then(async (finalizedMetrics) => {
              if (!finalizedMetrics) return;
              if (canonicalAttemptId && deps.db?.ops?.mutate?.llmAttempts) {
                await deps.db.ops.mutate.llmAttempts.update(
                  canonicalAttemptId,
                  {
                    usage: finalizedMetrics.usage,
                    cost: finalizedMetrics.cost ?? null,
                    metricsFinalizedAt: finalizedMetrics.finalizedAt,
                  },
                  {
                    threadId,
                    traceId: typeof event.traceId === "string"
                      ? event.traceId
                      : null,
                    causationId: typeof event.id === "string" ? event.id : null,
                    namespace: context.namespace,
                  },
                );
              }
              await llmUsageService.updateUsageRecordMetrics({
                usageNodeId: createdUsageNodeId,
                threadId,
                eventId: typeof event.id === "string" ? event.id : null,
                agentId: (payload.agent.id ?? payload.agent.name) as
                  | string
                  | null,
                runSender,
                provider: record.provider ?? null,
                model: record.model ?? null,
                usage: finalizedMetrics.usage,
                cost: finalizedMetrics.cost ?? null,
                finalizedAt: finalizedMetrics.finalizedAt,
              });
            }).catch((error) => {
              console.warn(
                "[LLM_CALL] Failed to finalize llm_usage node:",
                error,
              );
            });
          }
        } catch (error) {
          console.warn("[LLM_CALL] Failed to persist llm_usage node:", error);
        }
      }
    };

    const markAttemptSuperseded = async (
      patch: {
        provider?: string | null;
        model?: string | null;
        finishReason?: string | null;
        answer?: string | null;
        reasoning?: string | null;
        messages?: unknown;
        debug?: unknown;
        toolCalls?: unknown;
        usage?: unknown;
        cost?: unknown;
        error?: unknown;
        finishedAt?: string;
      },
    ): Promise<void> => {
      const supersededAttemptId = terminalLlmAttemptId ?? llmAttemptId;
      if (!supersededAttemptId || !deps.db?.ops?.mutate?.llmAttempts) return;
      try {
        await lastPartialPersistPromise;
        await deps.db.ops.mutate.llmAttempts.update(
          supersededAttemptId,
          {
            ...patch,
            status: "superseded",
            partialAnswer,
            partialReasoning,
            metadata: {
              superseded: true,
              cancellationReason: cancellationReason(),
            },
            finishedAt: patch.finishedAt ?? new Date().toISOString(),
          },
          {
            threadId,
            traceId: typeof event.traceId === "string" ? event.traceId : null,
            causationId: typeof event.id === "string" ? event.id : null,
            namespace: context.namespace,
          },
        );
      } catch (error) {
        console.warn(
          "[LLM_CALL] Failed to mark llm_attempt superseded:",
          error,
        );
      }
    };

    const persistSupersededResponse = async (
      llmResponse: ChatResponse,
    ): Promise<void> => {
      const usage = llmResponse.usage;
      const usageAttempts = llmResponse.usageAttempts;
      const cost = llmResponse.cost;
      const usageRecords =
        Array.isArray(usageAttempts) && usageAttempts.length > 0
          ? usageAttempts
          : usage
          ? [{
            provider: llmResponse.provider,
            model: llmResponse.model,
            usage,
            ...(cost ? { cost } : {}),
          }]
          : [];

      await persistUsageRecords(usageRecords, llmResponse.usageFinalized);
      await markAttemptSuperseded({
        provider: llmResponse.provider ?? null,
        model: llmResponse.model ?? null,
        finishReason: llmResponse.finishReason ?? "stop",
        answer: llmResponse.answer ?? null,
        reasoning: llmResponse.reasoning ?? null,
        messages: llmResponse.prompt,
        debug: llmResponse.debug ?? null,
        toolCalls: llmResponse.toolCalls ?? null,
        usage: usage ?? null,
        cost: cost ?? null,
      });
    };

    const persistSupersededError = async (error: unknown): Promise<void> => {
      const providerError = error instanceof LLMProviderError
        ? error
        : new LLMProviderError(
          error instanceof Error ? error.message : String(error),
          {
            reason: classifyLLMError(error),
            provider: configuredProvider,
            model: configForCall.model,
            status: typeof (error as { status?: unknown })?.status === "number"
              ? (error as { status: number }).status
              : undefined,
            attempts: [{
              provider: configuredProvider,
              model: configForCall.model,
              reason: classifyLLMError(error),
              status:
                typeof (error as { status?: unknown })?.status === "number"
                  ? (error as { status: number }).status
                  : undefined,
              message: error instanceof Error ? error.message : String(error),
            }],
            cause: error,
          },
        );

      if (providerError.usageAttempts.length > 0) {
        await persistUsageRecords(providerError.usageAttempts);
      }
      await markAttemptSuperseded({
        provider: providerError.provider ?? configForCall.provider ?? null,
        model: providerError.model ?? configForCall.model ?? null,
        answer: null,
        finishReason: "error",
        error: {
          message: providerError.message,
          reason: providerError.reason,
          provider: providerError.provider ?? null,
          model: providerError.model ?? null,
          status: providerError.status ?? null,
          retryable: isRetryableLLMReason(providerError.reason),
          fallbackAttempted: providerError.fallbackAttempted,
          fallbackCount: Math.max(0, providerError.attempts.length - 1),
          visibleStreamStarted: providerError.visibleStreamStarted,
          attempts: providerError.attempts.map((attempt) => ({
            provider: attempt.provider,
            model: attempt.model ?? null,
            reason: attempt.reason ?? null,
            status: attempt.status ?? null,
            message: attempt.message ?? null,
          })),
        },
      });
    };

    const detachSupersededDrain = (
      chatPromise: Promise<ChatResponse>,
    ): void => {
      void chatPromise.then(persistSupersededResponse)
        .catch(persistSupersededError)
        .catch((error) => {
          console.warn(
            "[LLM_CALL] Failed to drain superseded LLM call:",
            error,
          );
        });
    };

    const awaitChatOrSupersession = async (
      chatPromise: Promise<ChatResponse>,
    ): Promise<ChatResponse | "superseded"> => {
      if (!deps.cancellation) return await chatPromise;
      if (isSuperseded()) return "superseded";
      let unsubscribe = () => {};
      const superseded = new Promise<"superseded">((resolve) => {
        unsubscribe = deps.cancellation!.onCancel(() => resolve("superseded"));
      });
      try {
        return await Promise.race([chatPromise, superseded]);
      } finally {
        unsubscribe();
      }
    };

    let response: ChatResponse;
    let routingSelection: RoutingControlSelection = {
      kind: "none",
      executableCalls: [],
    };
    let routingCorrectionAttempted = false;
    const discardedRoutingResponses: ChatResponse[] = [];
    const runtimeMetadata = getRuntimeThreadMetadata(deps.thread?.metadata);
    const historyCutoffs = runtimeMetadata.promptHistoryCutoffs &&
        typeof runtimeMetadata.promptHistoryCutoffs === "object" &&
        !Array.isArray(runtimeMetadata.promptHistoryCutoffs)
      ? runtimeMetadata.promptHistoryCutoffs as Record<string, string>
      : {};
    const onHistoryCutoff = async (
      profileKey: string,
      sourceEndMessageId: string | null,
    ) => {
      const latestThread = await deps.db.ops.getThreadById(threadId);
      const latestRuntime = getRuntimeThreadMetadata(latestThread?.metadata);
      const current = latestRuntime.promptHistoryCutoffs &&
          typeof latestRuntime.promptHistoryCutoffs === "object" &&
          !Array.isArray(latestRuntime.promptHistoryCutoffs)
        ? latestRuntime.promptHistoryCutoffs as Record<string, string>
        : {};
      const next = { ...current };
      if (sourceEndMessageId) next[profileKey] = sourceEndMessageId;
      else delete next[profileKey];
      await deps.db.ops.updateThread(threadId, {
        metadata: getSerializableThreadMetadata(
          setRuntimeThreadMetadata(latestThread?.metadata, {
            promptHistoryCutoffs: Object.keys(next).length > 0
              ? next
              : undefined,
          }),
        ),
      });
    };
    const startChat = (
      messages: ChatMessage[],
      callback = streamCallback,
    ) =>
      chat(
        {
          messages,
          tools: payload.tools,
          extractTags: ["think"],
          reasoningHistory: context.reasoningHistory,
          historyCutoffs,
          historyCutoffNamespace: String(
            payload.agent.id ?? payload.agent.name,
          ),
          onHistoryCutoff,
          ...(materializeMessages ? { materializeMessages } : {}),
        } as ChatRequest,
        configForCall,
        envVars,
        callback,
        context.llmProviders,
      );
    let chatPromise = startChat(baseMessages);
    try {
      let settled = await awaitChatOrSupersession(chatPromise);
      if (settled === "superseded") {
        detachSupersededDrain(chatPromise);
        return { producedEvents: [] };
      }
      response = settled;
      routingSelection = selectRoutingControl(
        response.toolCalls,
        routingTargets,
      );

      if (routingSelection.kind === "invalid") {
        routingCorrectionAttempted = true;
        discardedRoutingResponses.push(response);
        const askTargets = routingTargets.ask.map((target) => target.id);
        const handoffTargets = routingTargets.handoff.map((target) =>
          target.id
        );
        const correctionPrompt: ChatMessage = {
          role: "user",
          content: [
            "[Private Copilotz routing correction]",
            routingSelection.message,
            "Respond again using exactly one valid routing control by itself, or reply normally without a routing control.",
            "Never combine ask_in_thread or handoff_in_thread with another tool call or a second routing control.",
            `ask_in_thread targets: ${askTargets.join(", ") || "none"}.`,
            `handoff_in_thread targets: ${
              handoffTargets.join(", ") || "none"
            }.`,
          ].join("\n"),
        };
        let correctionVisibleStarted = false;
        const correctionStreamCallback = processStreamToken
          ? (token: string, options?: { isReasoning?: boolean }) => {
            if (
              !options?.isReasoning &&
              token.length > 0 &&
              !correctionVisibleStarted
            ) {
              correctionVisibleStarted = true;
              if (partialAnswer.length > 0) processStreamToken("\n\n");
            }
            processStreamToken(token, options);
          }
          : undefined;
        chatPromise = startChat(
          [...baseMessages, correctionPrompt],
          correctionStreamCallback,
        );
        settled = await awaitChatOrSupersession(chatPromise);
        if (settled === "superseded") {
          detachSupersededDrain(chatPromise);
          return { producedEvents: [] };
        }
        response = settled;
        routingSelection = selectRoutingControl(
          response.toolCalls,
          routingTargets,
        );
      }
    } catch (error) {
      if (isSuperseded()) {
        void persistSupersededError(error).catch((persistError) => {
          console.warn(
            "[LLM_CALL] Failed to persist superseded LLM error:",
            persistError,
          );
        });
        return { producedEvents: [] };
      }

      if (!isSuperseded() && streamCallback && deps.emitToStream) {
        deps.emitToStream(buildTokenEvent("", true));
      }

      const providerError = error instanceof LLMProviderError
        ? error
        : new LLMProviderError(
          error instanceof Error ? error.message : String(error),
          {
            reason: classifyLLMError(error),
            provider: configuredProvider,
            model: configForCall.model,
            status: typeof (error as { status?: unknown })?.status === "number"
              ? (error as { status: number }).status
              : undefined,
            attempts: [{
              provider: configuredProvider,
              model: configForCall.model,
              reason: classifyLLMError(error),
              status:
                typeof (error as { status?: unknown })?.status === "number"
                  ? (error as { status: number }).status
                  : undefined,
              message: error instanceof Error ? error.message : String(error),
            }],
            cause: error,
          },
        );

      const friendlyAnswer = getProviderFailureMessage(providerError);
      const failedPayload: LlmResultEventPayload = {
        llmCallId: typeof event.id === "string" ? event.id : ulid(),
        agent: {
          id: payload.agent.id ?? undefined,
          name: payload.agent.name,
        },
        provider: providerError.provider ?? configForCall.provider ?? null,
        model: providerError.model ?? configForCall.model ?? null,
        status: "failed",
        finishReason: "error",
        answer: friendlyAnswer,
        reasoning: null,
        toolCalls: null,
        extractedTags: null,
        error: {
          message: providerError.message,
          reason: providerError.reason,
          provider: providerError.provider ?? null,
          model: providerError.model ?? null,
          status: providerError.status ?? null,
          retryable: isRetryableLLMReason(providerError.reason),
          fallbackAttempted: providerError.fallbackAttempted,
          fallbackCount: Math.max(0, providerError.attempts.length - 1),
          visibleStreamStarted: providerError.visibleStreamStarted,
          attempts: providerError.attempts.map((attempt) => ({
            provider: attempt.provider,
            model: attempt.model ?? null,
            reason: attempt.reason ?? null,
            status: attempt.status ?? null,
            message: attempt.message ?? null,
          })),
        },
        finishedAt: new Date().toISOString(),
      };

      if (providerError.usageAttempts.length > 0) {
        await persistUsageRecords(providerError.usageAttempts);
      }
      if (terminalLlmAttemptId) {
        baseResultMetadata.llmAttemptId = terminalLlmAttemptId;
      }
      if (isSuperseded()) {
        await markAttemptSuperseded({
          provider: providerError.provider ?? configForCall.provider ?? null,
          model: providerError.model ?? configForCall.model ?? null,
          answer: null,
          finishReason: "error",
          error: failedPayload.error,
          finishedAt: failedPayload.finishedAt,
        });
        return { producedEvents: [] };
      }

      const failedAttemptId = terminalLlmAttemptId ?? llmAttemptId;
      if (failedAttemptId && deps.db?.ops?.mutate?.llmAttempts) {
        try {
          await lastPartialPersistPromise;
          await deps.db.ops.mutate.llmAttempts.fail(
            failedAttemptId,
            {
              provider: providerError.provider ?? configForCall.provider ??
                null,
              model: providerError.model ?? configForCall.model ?? null,
              answer: friendlyAnswer,
              partialAnswer,
              partialReasoning,
              finishReason: "error",
              error: failedPayload.error,
              finishedAt: failedPayload.finishedAt,
            },
            {
              threadId,
              traceId: typeof event.traceId === "string" ? event.traceId : null,
              causationId: typeof event.id === "string" ? event.id : null,
              namespace: context.namespace,
              status: isLifecycleAttemptCreated ? "pending" : undefined,
              priority: isLifecycleAttemptCreated
                ? EVENT_PRIORITIES.SETTLEMENT
                : undefined,
              metadata: isLifecycleAttemptCreated ? baseResultMetadata : null,
              eventPayload: isLifecycleAttemptCreated
                ? failedPayload as unknown as Record<string, unknown>
                : null,
            },
          );
        } catch (attemptError) {
          console.warn(
            "[LLM_CALL] Failed to mark llm_attempt failed:",
            attemptError,
          );
        }
      }

      if (isLifecycleAttemptCreated) {
        deps.emitToStream({
          ...event,
          type: "LLM_RESULT",
          payload: failedPayload,
          parentEventId: typeof event.id === "string" ? event.id : null,
          priority: EVENT_PRIORITIES.SETTLEMENT,
          metadata: {
            ...baseResultMetadata,
            llmError: failedPayload.error,
          },
          status: "completed",
        } as Event);
        return { producedEvents: [] };
      }

      return {
        producedEvents: [{
          threadId,
          type: "LLM_RESULT",
          payload: failedPayload,
          parentEventId: typeof event.id === "string" ? event.id : undefined,
          traceId: typeof event.traceId === "string"
            ? event.traceId
            : undefined,
          priority: EVENT_PRIORITIES.SETTLEMENT,
          metadata: {
            ...baseResultMetadata,
            llmError: failedPayload.error,
          },
        }],
      };
    }

    const llmResponse = response as unknown as ChatResponse;

    // finalize stream
    if (!isSuperseded() && streamCallback && deps.emitToStream) {
      deps.emitToStream(buildTokenEvent("", true));
    }

    // Clean response
    let answer: string | undefined = ("answer" in llmResponse)
      ? (llmResponse as unknown as { answer?: string }).answer
      : undefined;
    const visibleAnswerParts = [
      ...discardedRoutingResponses,
      llmResponse,
    ].flatMap((candidate) =>
      typeof candidate.answer === "string" && candidate.answer.length > 0
        ? [candidate.answer]
        : []
    );
    if (visibleAnswerParts.length > 0) {
      answer = visibleAnswerParts.join("\n\n");
    }
    const reasoning: string | undefined = ("reasoning" in llmResponse)
      ? (llmResponse as unknown as { reasoning?: string }).reasoning
      : undefined;
    const responseToolCalls: ToolInvocation[] | undefined =
      ("toolCalls" in llmResponse)
        ? (llmResponse as unknown as { toolCalls?: ToolInvocation[] }).toolCalls
        : undefined;
    const routingIntent: RoutingControlIntent | null =
      routingSelection.kind === "routing" ? routingSelection.intent : null;
    const routingFailure = routingSelection.kind === "invalid"
      ? {
        code: routingSelection.code,
        message: routingSelection.message,
        correctionAttempted: routingCorrectionAttempted,
      }
      : null;
    const toolCalls: ToolInvocation[] | undefined =
      routingSelection.kind === "none"
        ? routingSelection.executableCalls
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
    const usageAttempts = ("usageAttempts" in llmResponse)
      ? (llmResponse as unknown as ChatResponse).usageAttempts
      : undefined;
    const usageFinalized = ("usageFinalized" in llmResponse)
      ? (llmResponse as unknown as ChatResponse).usageFinalized
      : undefined;
    const cost: CostBreakdown | undefined = ("cost" in llmResponse)
      ? (llmResponse as unknown as { cost?: CostBreakdown }).cost
      : undefined;

    const usageRecordsForResponse = (
      candidate: ChatResponse,
    ): LLMUsageAttempt[] => {
      if (
        Array.isArray(candidate.usageAttempts) &&
        candidate.usageAttempts.length > 0
      ) {
        return candidate.usageAttempts.map((record, index, records) =>
          index === records.length - 1
            ? {
              ...record,
              usage: {
                ...record.usage,
                statusReason: "malformed_tool_call" as const,
              },
              error: {
                reason: "provider_error" as const,
                message:
                  "The model response violated the routing-control contract and was corrected internally.",
              },
            }
            : record
        );
      }
      return candidate.usage
        ? [{
          provider: candidate.provider,
          model: candidate.model,
          usage: {
            ...candidate.usage,
            statusReason: "malformed_tool_call" as const,
          },
          error: {
            reason: "provider_error" as const,
            message:
              "The model response violated the routing-control contract and was corrected internally.",
          },
          ...(candidate.cost ? { cost: candidate.cost } : {}),
          ...(candidate.usageFinalized
            ? { usageFinalized: candidate.usageFinalized }
            : {}),
        }]
        : [];
    };
    const usageRecords = [
      ...discardedRoutingResponses.flatMap(usageRecordsForResponse),
      ...(Array.isArray(usageAttempts) && usageAttempts.length > 0
        ? usageAttempts
        : usage
        ? [{
          provider: llmResponse.provider,
          model: llmResponse.model,
          usage,
          ...(cost ? { cost } : {}),
        }]
        : []),
    ];

    await persistUsageRecords(usageRecords, usageFinalized);
    if (terminalLlmAttemptId) {
      baseResultMetadata.llmAttemptId = terminalLlmAttemptId;
    }

    if (envFlagEnabled("COPILOTZ_DEBUG")) {
      console.log("answer", answer);
      console.log("reasoning", reasoning);
      console.log("toolCalls", responseToolCalls);
      console.log("extractedTags", extractedTags);
      console.log("routingSelection", routingSelection);
    }

    if (routingFailure && !answer?.trim()) {
      answer = "The model could not produce a valid in-thread routing control.";
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
          ...(call?.pipeline ? { pipeline: call.pipeline } : {}),
          // Include batch info for tool call aggregation
          batchId,
          batchSize,
          batchIndex: batchId ? index : null,
        };
      })
      : undefined;

    if (isSuperseded()) {
      await markAttemptSuperseded({
        provider: llmResponse.provider ?? null,
        model: llmResponse.model ?? null,
        finishReason: routingFailure ? "error" : routingIntent ||
            (Array.isArray(normalizedToolCalls) &&
              normalizedToolCalls.length > 0)
          ? "tool_calls"
          : llmResponse.finishReason ?? "stop",
        answer: answer ?? null,
        reasoning: reasoning ?? null,
        messages: llmResponse.prompt,
        debug: llmResponse.debug ?? null,
        toolCalls: normalizedToolCalls ?? null,
        usage: usage ?? null,
        cost: cost ?? null,
      });
      return { producedEvents: [] };
    }

    const llmResultPayload: LlmResultEventPayload = {
      llmCallId: typeof event.id === "string" ? event.id : ulid(),
      agent: {
        id: payload.agent.id ?? undefined,
        name: payload.agent.name,
      },
      provider: llmResponse.provider ?? null,
      model: llmResponse.model ?? null,
      status: routingFailure ? "failed" : "completed",
      finishReason: routingFailure ? "error" : routingIntent ||
          (Array.isArray(normalizedToolCalls) &&
            normalizedToolCalls.length > 0)
        ? "tool_calls"
        : llmResponse.finishReason ?? "stop",
      answer: answer ?? null,
      reasoning: reasoning ?? null,
      toolCalls: normalizedToolCalls ?? null,
      extractedTags: extractedTags ?? null,
      ...(routingFailure
        ? {
          error: {
            message: routingFailure.message,
            reason: "invalid_routing_control",
            provider: llmResponse.provider ?? null,
            model: llmResponse.model ?? null,
            status: null,
            retryable: false,
            fallbackAttempted: false,
            fallbackCount: 0,
            visibleStreamStarted: false,
            attempts: [{
              provider: llmResponse.provider ?? configuredProvider,
              model: llmResponse.model ?? configForCall.model ?? null,
              reason: "invalid_routing_control",
              status: null,
              message: routingFailure.message,
            }],
          },
        }
        : {}),
      ...(usage ? { usage } : {}),
      ...(cost ? { cost } : {}),
      ...(usageNodeId ? { usageNodeId } : {}),
      finishedAt: new Date().toISOString(),
    };

    const resultMetadata: Record<string, unknown> = {
      ...baseResultMetadata,
      ...(routingIntent
        ? {
          routing: {
            action: routingIntent.action,
            targetId: routingIntent.targetId,
            source: routingIntent.source,
            message: routingIntent.message,
            ...(routingIntent.controlCallId
              ? { controlCallId: routingIntent.controlCallId }
              : {}),
          },
        }
        : {}),
      ...(routingFailure ? { routingError: routingFailure } : {}),
    };

    const completionAttemptId = terminalLlmAttemptId ?? llmAttemptId;
    if (completionAttemptId && deps.db?.ops?.mutate?.llmAttempts) {
      try {
        if (completionAttemptId === llmAttemptId) {
          await persistPartialAttempt(true);
        }
        const attemptPatch = {
          provider: llmResponse.provider ?? null,
          model: llmResponse.model ?? null,
          finishReason: llmResultPayload.finishReason,
          answer: answer ?? null,
          reasoning: reasoning ?? null,
          messages: llmResponse.prompt,
          debug: llmResponse.debug ?? null,
          partialAnswer,
          partialReasoning,
          toolCalls: normalizedToolCalls ?? null,
          usage: usage ?? null,
          cost: cost ?? null,
          ...(routingFailure ? { error: llmResultPayload.error } : {}),
          finishedAt: llmResultPayload.finishedAt,
        };
        const mutationOptions = {
          threadId,
          traceId: typeof event.traceId === "string" ? event.traceId : null,
          causationId: typeof event.id === "string" ? event.id : null,
          namespace: context.namespace,
          status: isLifecycleAttemptCreated ? "pending" as const : undefined,
          priority: isLifecycleAttemptCreated
            ? EVENT_PRIORITIES.SETTLEMENT
            : undefined,
          metadata: isLifecycleAttemptCreated ? resultMetadata : null,
          eventPayload: isLifecycleAttemptCreated
            ? llmResultPayload as unknown as Record<string, unknown>
            : null,
        };
        if (routingFailure) {
          await deps.db.ops.mutate.llmAttempts.fail(
            completionAttemptId,
            attemptPatch,
            mutationOptions,
          );
        } else {
          await deps.db.ops.mutate.llmAttempts.complete(
            completionAttemptId,
            attemptPatch,
            mutationOptions,
          );
        }
      } catch (attemptError) {
        console.warn(
          "[LLM_CALL] Failed to mark llm_attempt completed:",
          attemptError,
        );
      }
    }

    const producedEvents: NewEvent[] = [{
      threadId,
      type: "LLM_RESULT",
      payload: llmResultPayload,
      parentEventId: typeof event.id === "string" ? event.id : undefined,
      traceId: typeof event.traceId === "string" ? event.traceId : undefined,
      priority: EVENT_PRIORITIES.SETTLEMENT,
      metadata: resultMetadata,
    }];

    if (isLifecycleAttemptCreated) {
      deps.emitToStream({
        ...event,
        type: "LLM_RESULT",
        payload: llmResultPayload,
        parentEventId: typeof event.id === "string" ? event.id : null,
        priority: EVENT_PRIORITIES.SETTLEMENT,
        metadata: resultMetadata,
        status: "completed",
      } as Event);
      return { producedEvents: [] };
    }

    return { producedEvents };
  },
};

export const { shouldProcess, process } = llmCallProcessor;
