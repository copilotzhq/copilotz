import type { CollectionRecord } from "@copilotz/copilotz/collections";
import type { Agent } from "@copilotz/copilotz/resources";
import type { CopilotzEvent } from "@copilotz/copilotz/events";
import {
  type ActionDefinition,
  defineAction,
} from "@copilotz/copilotz/actions";
import {
  agentSessionBaseConfig,
  agentTextBaseConfig,
  agentUsesSessionRuntime,
  buildAgentTextPrompt,
  staticAgentSessionConfig,
  staticAgentTextConfig,
} from "@copilotz/copilotz/agents";
import {
  type AgentTextActionInput,
  type AgentTextPrompt,
  type ChatMessage,
  type ChatRequest,
  type CreateTextWorkflowPluginOptions,
  generateChainFromResources,
  type LlmFrame,
  materializeAssetRefsForProvider,
  type ProviderConfig,
  runGenerateChain,
  runSessionChain,
  sessionChainFromResources,
} from "@copilotz/copilotz/llm";
import {
  type CoreActionContext,
  coreWorkflowContext,
  requireCoreAgent,
} from "../../context.ts";
import {
  asRecord,
  errorText,
  loadParticipant,
  optionalText,
  policyOptions,
  recordThreadId,
  requiredText,
  stringArray,
  toolCatalogFor,
} from "../processors/helpers.ts";

export const GENERATE_LLM_ACTION_ID = "copilotz.core.llm.generate";
export const RUN_LLM_SESSION_ACTION_ID = "copilotz.core.llm.session";

const utf8 = new TextEncoder();
const activeSessions = new WeakMap<object, Set<string>>();

function acquireSession(
  context: CoreActionContext,
  providerId: string,
  key: string,
): (() => void) | undefined {
  const provider = context.adapters.llm[providerId];
  if (!provider || typeof provider !== "object") {
    throw new Error(`LLM provider '${providerId}' is unavailable.`);
  }
  const active = activeSessions.get(provider) ?? new Set<string>();
  activeSessions.set(provider, active);
  if (active.has(key)) return undefined;
  active.add(key);
  return () => {
    active.delete(key);
    if (active.size === 0) activeSessions.delete(provider);
  };
}

function frameBytes(frame: LlmFrame):
  | Readonly<{
    lane: string;
    mediaType: string;
    bytes: Uint8Array;
  }>
  | undefined {
  if (frame.type === "reasoning") {
    const text = typeof frame.payload === "string"
      ? frame.payload
      : typeof asRecord(frame.payload).text === "string"
      ? String(asRecord(frame.payload).text)
      : "";
    if (!text) return undefined;
    return {
      lane: "reasoning",
      mediaType: "text/plain",
      bytes: utf8.encode(text),
    };
  }
  if (frame.type === "tool_call") {
    return {
      lane: "tool_call",
      mediaType: "application/x-ndjson",
      bytes: utf8.encode(`${JSON.stringify(frame.payload ?? {})}\n`),
    };
  }
  if (frame.type === "audio") {
    const payload = frame.payload;
    const record = asRecord(payload);
    const mediaType = optionalText(record.mediaType) ?? "audio/pcm";
    const raw = payload instanceof Uint8Array
      ? payload
      : record.bytes instanceof Uint8Array
      ? record.bytes
      : undefined;
    if (!raw?.byteLength) return undefined;
    return { lane: "content", mediaType, bytes: raw };
  }
  if (frame.type === "text" || frame.type === "content") {
    const text = typeof frame.payload === "string"
      ? frame.payload
      : typeof asRecord(frame.payload).text === "string"
      ? String(asRecord(frame.payload).text)
      : "";
    if (!text) return undefined;
    return {
      lane: "content",
      mediaType: "text/plain",
      bytes: utf8.encode(text),
    };
  }
  return undefined;
}

function textOnlyMessages(messages: readonly ChatMessage[]): ChatMessage[] {
  return messages.map((message) => {
    if (!Array.isArray(message.content)) return structuredClone(message);
    return {
      ...structuredClone(message),
      content: message.content.flatMap((part) =>
        part.type === "text" ? [part.text] : []
      ).join(""),
    };
  });
}

async function resolveAgentConfig(
  options: CreateTextWorkflowPluginOptions,
  agent: Agent,
  operation: AgentTextActionInput,
  event: CopilotzEvent,
  context: CoreActionContext,
  prompt: AgentTextPrompt,
  mode: "generate" | "session" = "generate",
): Promise<ProviderConfig> {
  const baseConfig = mode === "session"
    ? agentSessionBaseConfig(agent)
    : agentTextBaseConfig(agent);
  const config = options.resolveAgentTextConfig
    ? await options.resolveAgentTextConfig({
      agent,
      operation,
      sourceEvent: event,
      context: coreWorkflowContext(context),
      baseConfig,
      thread: prompt.thread,
      messages: prompt.messages,
      tools: prompt.tools,
    })
    : mode === "session"
    ? staticAgentSessionConfig(agent)
    : staticAgentTextConfig(agent);
  if (!config.provider) {
    throw new Error(
      mode === "session"
        ? `Agent '${agent.id}' has no session runtime provider.`
        : `Agent '${agent.id}' has no generate runtime provider.`,
    );
  }
  return config;
}

async function executeGenerate(
  input: unknown,
  context: CoreActionContext,
): Promise<Readonly<Record<string, unknown>>> {
  const attempt = asRecord(input) as CollectionRecord;
  const event = asRecord(attempt.sourceEvent) as unknown as CopilotzEvent;
  if (!event.type || !event.namespace || !event.correlationId) {
    throw new TypeError("LLM generation requires a source Event.");
  }
  const workflowContext = coreWorkflowContext(context);
  const agent = requireCoreAgent(
    context.resources,
    requiredText(optionalText(attempt.agentId), "LLM attempt agent id"),
  );
  const toolCatalog = toolCatalogFor(agent);
  const options = policyOptions(agent);
  const participant = optionalText(attempt.participantId)
    ? await loadParticipant(
      workflowContext,
      optionalText(attempt.participantId)!,
    )
    : null;
  if (!participant || participant.participantType !== "agent") {
    throw new Error(
      `LLM attempt '${attempt.id}' has no agent participant.`,
    );
  }
  const granted = new Set(stringArray(attempt.availableToolIds));
  const tools = (await toolCatalog.forAgent(
    workflowContext,
    agent,
  ))
    .filter((tool) => granted.has(tool.key));
  const prompt = await buildAgentTextPrompt(
    workflowContext,
    {
      options,
      agent,
      participant,
      operation: attempt as unknown as AgentTextActionInput,
      sourceEvent: event,
      tools,
    },
  );
  const useSession = agentUsesSessionRuntime(agent);
  const config = await resolveAgentConfig(
    options,
    agent,
    attempt as unknown as AgentTextActionInput,
    event,
    context,
    prompt,
    useSession ? "session" : "generate",
  );
  const releaseSession = useSession
    ? acquireSession(
      context,
      String(config.provider),
      `${context.namespace}:${recordThreadId(attempt)}:${agent.id}`,
    )
    : undefined;
  if (useSession && !releaseSession) {
    return Object.freeze({
      id: String(attempt.id),
      status: "coalesced" as const,
    });
  }
  const publicAgent = Object.freeze({
    id: agent.id,
    name: agent.name,
    participantId: participant.id,
  });
  const encoder = new TextEncoder();
  const streamRuntime = context.streams;
  if (!streamRuntime) {
    throw new Error("Runtime content stream is not configured.");
  }
  const writers = new Map<
    string,
    ReturnType<typeof streamRuntime.open>
  >();
  let liveWrites = Promise.resolve();
  let liveWriteError: unknown;
  let streamAppendSequence = 0;
  const enqueueLive = (work: () => Promise<void>): void => {
    liveWrites = liveWrites.then(async () => {
      if (liveWriteError !== undefined) return;
      try {
        await work();
      } catch (error) {
        liveWriteError = error;
      }
    });
  };
  const writerFor = (lane: string, mediaType: string) => {
    const key = `${lane}:${mediaType}`;
    const existing = writers.get(key);
    if (existing) return existing;
    const created = streamRuntime.open({
      id: `${attempt.id}:${key}`,
      role: lane,
      mediaType,
      metadata: {
        lane,
        llmAttemptId: attempt.id,
        agent: publicAgent,
        core: {
          threadId: recordThreadId(attempt),
          participantId: participant.id,
          routing: {
            senderId: participant.id,
            recipientIds: [],
          },
          visibility: { kind: "public" },
        },
      },
      correlationId: event.correlationId,
    });
    writers.set(key, created);
    return created;
  };
  const appendLiveChunk = async (
    writer: Awaited<
      ReturnType<typeof streamRuntime.open>
    >,
    bytes: Uint8Array,
  ): Promise<void> => {
    await writer.append({
      bytes,
      appendId: `llm-live:${streamAppendSequence++}`,
    });
  };
  const sealWriters = async (
    action: "closed" | "abandoned" | "failed",
    reason?: string,
  ): Promise<void> => {
    await liveWrites;
    const mode = action === "closed" && liveWriteError !== undefined
      ? "failed"
      : action;
    const pending = [...writers.values()];
    writers.clear();
    await Promise.all(pending.map(async (opened) => {
      const writer = await opened;
      if (mode === "closed") {
        await writer.close({ assetId: `stream:${writer.id}` });
        return;
      }
      if (mode === "failed") {
        await writer.abort({ reason: reason ?? "Stream failed" });
        return;
      }
      await writer.abort({ reason });
    }));
    if (liveWriteError !== undefined) throw liveWriteError;
  };

  try {
    const request: ChatRequest = {
      messages: [...prompt.messages],
      tools: [...prompt.tools],
      signal: context.signal,
      idempotencyKey: context.operationKey ?? String(attempt.id),
      reasoningHistory: options.reasoningHistory,
      materializeMessages: agent.assetOptions?.resolveInLLM === false
        ? (messages) => textOnlyMessages(messages)
        : (messages, providerConfig) =>
          materializeAssetRefsForProvider(messages, providerConfig),
      onToolCallDelta: (delta) =>
        enqueueLive(async () => {
          const writer = await writerFor(
            "tool_call",
            "application/x-ndjson",
          );
          await appendLiveChunk(
            writer,
            encoder.encode(
              `${JSON.stringify(structuredClone(delta))}\n`,
            ),
          );
        }),
    };
    const stream = (
      chunk: string,
      streamOptions?: { isReasoning?: boolean },
    ) =>
      enqueueLive(async () => {
        const lane = streamOptions?.isReasoning ? "reasoning" : "content";
        const writer = await writerFor(lane, "text/plain");
        await appendLiveChunk(writer, encoder.encode(chunk));
      });
    const env = { ...(options.env ?? {}) };
    let response;
    if (useSession) {
      const invocation = runSessionChain(
        sessionChainFromResources({ llm: context.adapters.llm }, config),
        {
          request,
          env,
          stream,
        },
      );
      const reader = invocation.frames.getReader();
      const pumping = (async () => {
        while (true) {
          const next = await reader.read();
          if (next.done) break;
          const mapped = frameBytes(next.value);
          if (!mapped) continue;
          enqueueLive(async () => {
            const writer = await writerFor(mapped.lane, mapped.mediaType);
            await appendLiveChunk(writer, mapped.bytes);
          });
        }
      })();
      try {
        response = await invocation.result;
        await pumping;
      } catch (error) {
        await reader.cancel().catch(() => undefined);
        throw error;
      }
    } else {
      response = await runGenerateChain(
        generateChainFromResources({ llm: context.adapters.llm }, config),
        { request, env, stream },
      ).result;
    }
    await sealWriters("closed");

    let usage = response.usage as unknown as
      | Record<string, unknown>
      | undefined;
    let cost = response.cost as unknown as
      | Record<string, unknown>
      | undefined;
    let metricsFinalizedAt: string | undefined;
    if (response.usageFinalized) {
      const finalized = await response.usageFinalized;
      if (finalized) {
        usage = finalized.usage as unknown as Record<string, unknown>;
        cost = finalized.cost as unknown as
          | Record<string, unknown>
          | undefined;
        metricsFinalizedAt = finalized.finalizedAt;
      }
    }
    const answer = response.answer
      ? await context.content.materialize(
        await context.content.prepare({
          type: "text",
          text: response.answer,
          role: "body",
        }, { operationKey: "logical:answer" }),
      )
      : undefined;
    const reasoning = response.reasoning
      ? await context.content.materialize(
        await context.content.prepare({
          type: "text",
          text: response.reasoning,
          role: "reasoning",
        }, { operationKey: "logical:reasoning" }),
      )
      : undefined;
    const toolCalls = response.toolCalls?.length
      ? await context.content.materialize(
        await context.content.prepare({
          type: "json",
          value: response.toolCalls,
          role: "llm.tool_calls",
        }, { operationKey: "logical:tool-calls" }),
      )
      : undefined;
    const usageAttempts = new Map<string, unknown>();
    for (const [index, value] of (response.usageAttempts ?? []).entries()) {
      const fields = asRecord(value);
      usageAttempts.set(
        optionalText(fields.attemptId) ?? `response:${index}`,
        structuredClone(value),
      );
    }
    return Object.freeze({
      id: attempt.id,
      ...(answer ? { answer } : {}),
      ...(reasoning ? { reasoning } : {}),
      ...(toolCalls ? { toolCalls } : {}),
      ...(response.finishReason ? { finishReason: response.finishReason } : {}),
      ...(usage ? { usage } : {}),
      ...(usageAttempts.size
        ? { usageAttempts: [...usageAttempts.values()] }
        : {}),
      ...(cost ? { cost } : {}),
      ...(metricsFinalizedAt ? { metricsFinalizedAt } : {}),
      provider: response.provider ?? config.provider,
      model: response.model ?? config.model,
    });
  } catch (error) {
    await liveWrites;
    const failure = liveWriteError ?? error;
    await Promise.all([...writers.values()].map(async (opened) => {
      const writer = await opened.catch(() => undefined);
      if (!writer) return;
      if (context.signal?.aborted) {
        await writer.abort({
          reason: errorText(context.signal.reason ?? failure),
        }).catch(() => undefined);
        return;
      }
      await writer.abort({
        reason: errorText(failure),
      }).catch(() => undefined);
    }));
    writers.clear();
    throw failure;
  } finally {
    releaseSession?.();
  }
}

export const generateLlmAction: ActionDefinition<
  unknown,
  Readonly<Record<string, unknown>>,
  CoreActionContext,
  undefined,
  undefined
> = defineAction({
  id: GENERATE_LLM_ACTION_ID,
  execute: executeGenerate,
});

export const runLlmSessionAction: ActionDefinition<
  unknown,
  Readonly<Record<string, unknown>>,
  CoreActionContext,
  undefined,
  undefined
> = defineAction({
  id: RUN_LLM_SESSION_ACTION_ID,
  execute: executeGenerate,
});
