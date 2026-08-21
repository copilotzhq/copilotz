import type { CollectionRecord } from "@copilotz/copilotz/collections";
import type { Agent } from "@copilotz/copilotz/resources";
import type { CopilotzProcessorContext } from "@copilotz/copilotz/engine";
import { textWorkflowAttemptEventMetadata } from "@copilotz/copilotz/events";
import { defineProcessor, type Processor } from "@copilotz/copilotz/plugins";
import { llmAttemptFeature } from "../features/llm-attempt.ts";
import {
  agentSessionBaseConfig,
  agentTextBaseConfig,
  agentUsesSessionRuntime,
  buildAgentTextPrompt,
  requireAgent,
  staticAgentSessionConfig,
  staticAgentTextConfig,
} from "@copilotz/copilotz/agents";
import {
  type AgentTextPrompt,
  type ChatMessage,
  type ChatRequest,
  type CreateTextWorkflowPluginOptions,
  generateChainFromResources,
  type LlmFrame,
  materializeAssetRefsForProvider,
  type ProviderConfig,
  recordProviderAttemptLifecycle,
  runGenerateChain,
  runSessionChain,
  sessionChainFromResources,
} from "@copilotz/copilotz/llm";
import {
  asRecord,
  collectionEventRecord,
  errorText,
  loadParticipant,
  mapLlmAttempt,
  optionalText,
  policyOptions,
  recordThreadId,
  requiredText,
  safeError,
  stringArray,
  toolCatalogFor,
} from "./helpers.ts";

const utf8 = new TextEncoder();

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
  attempt: CollectionRecord,
  event: Parameters<Processor<CopilotzProcessorContext>["handle"]>[0],
  context: CopilotzProcessorContext,
  prompt: AgentTextPrompt,
  mode: "generate" | "session" = "generate",
): Promise<ProviderConfig> {
  const baseConfig = mode === "session"
    ? agentSessionBaseConfig(agent)
    : agentTextBaseConfig(agent);
  const config = options.resolveAgentTextConfig
    ? await options.resolveAgentTextConfig({
      agent,
      attempt: mapLlmAttempt(attempt),
      sourceEvent: event,
      context,
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

export const executeTextAttemptProcessor: Processor<CopilotzProcessorContext> =
  defineProcessor<CopilotzProcessorContext>({
    id: "copilotz.core.execute-text-attempt",
    on: [{ eventType: "llm_attempt.created" }],
    requires: {
      features: { llmAttempt: llmAttemptFeature },
    },
    async handle(event, context) {
      if (!event.durable) return;
      const record = collectionEventRecord(event);
      const attempt = record;
      if (!textWorkflowAttemptEventMetadata(asRecord(attempt.metadata))) return;
      if (String(attempt.status) !== "running") return;
      const agent = requireAgent(
        context,
        requiredText(optionalText(attempt.agentId), "LLM attempt agent id"),
      );
      const toolCatalog = toolCatalogFor(context, agent);
      const options = policyOptions(agent);
      const participant = optionalText(attempt.participantId)
        ? await loadParticipant(context, optionalText(attempt.participantId)!)
        : null;
      if (!participant || participant.participantType !== "agent") {
        throw new Error(
          `LLM attempt '${attempt.id}' has no agent participant.`,
        );
      }
      const granted = new Set(stringArray(attempt.availableToolIds));
      const tools = (await toolCatalog.forAgent(context, agent))
        .filter((tool) => granted.has(tool.key));
      const prompt = await buildAgentTextPrompt(context, {
        options,
        agent,
        participant,
        attempt,
        sourceEvent: event,
        tools,
      });
      const useSession = agentUsesSessionRuntime(agent);
      const config = await resolveAgentConfig(
        options,
        agent,
        attempt,
        event,
        context,
        prompt,
        useSession ? "session" : "generate",
      );
      if (
        attempt.provider !== config.provider || attempt.model !== config.model
      ) {
        await context.collections.llm_attempt.update({
          id: attempt.id,
          set: {
            provider: String(config.provider),
            model: config.model,
          },
        }, {
          operationKey: "logical:runtime-config",
          threadId: String(attempt.threadId),
        });
      }

      const publicAgent = Object.freeze({
        id: agent.id,
        name: agent.name,
        participantId: participant.id,
      });
      const encoder = new TextEncoder();
      const streamRuntime = context.content.stream;
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
          threadId: recordThreadId(attempt),
          role: lane,
          mediaType,
          participantId: participant.id,
          metadata: {
            lane,
            llmAttemptId: attempt.id,
            agent: publicAgent,
          },
          routing: {
            senderId: participant.id,
            recipientIds: [],
          },
          visibility: { kind: "public" },
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
          idempotencyKey: context.idempotencyKey,
          strictAttemptLifecycle: true,
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
          onAttemptLifecycle: (lifecycle) =>
            recordProviderAttemptLifecycle(attempt, lifecycle, context),
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
            sessionChainFromResources(context, config),
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
            generateChainFromResources(context, config),
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
          ? await context.content.prepare({
            type: "text",
            text: response.answer,
            role: "body",
          }, { operationKey: "logical:answer" })
          : undefined;
        const reasoning = response.reasoning
          ? await context.content.prepare({
            type: "text",
            text: response.reasoning,
            role: "reasoning",
          }, { operationKey: "logical:reasoning" })
          : undefined;
        const toolCalls = response.toolCalls?.length
          ? await context.content.prepare({
            type: "json",
            value: response.toolCalls,
            role: "llm.tool_calls",
          }, { operationKey: "logical:tool-calls" })
          : undefined;
        await context.features.llmAttempt.complete({
          id: attempt.id,
          ...(answer ? { answer } : {}),
          ...(reasoning ? { reasoning } : {}),
          ...(toolCalls ? { toolCalls } : {}),
          ...(response.finishReason
            ? { finishReason: response.finishReason }
            : {}),
          ...(usage ? { usage } : {}),
          ...(cost ? { cost } : {}),
          ...(metricsFinalizedAt ? { metricsFinalizedAt } : {}),
          metadataPatch: {
            provider: response.provider ?? config.provider,
            model: response.model ?? config.model,
          },
        }, { operationKey: "logical:complete" });
      } catch (error) {
        await liveWrites;
        const failure = liveWriteError ?? error;
        await Promise.all([...writers.values()].map(async (opened) => {
          const writer = await opened.catch(() => undefined);
          if (!writer) return;
          if (context.signal.aborted) {
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
        if (context.signal.aborted) {
          await context.collections.llm_attempt.commands.cancel({
            id: attempt.id,
            reason: errorText(context.signal.reason ?? failure),
            finishedAt: new Date().toISOString(),
          }, {
            operationKey: "logical:cancel",
            threadId: recordThreadId(attempt),
          });
          return;
        }
        const detail = await context.content.prepare({
          type: "text",
          text: errorText(failure),
          role: "provider.error_detail",
        }, { operationKey: "logical:error" });
        await context.features.llmAttempt.fail({
          id: attempt.id,
          safeError: safeError(
            "provider_error",
            "The agent's text runtime failed.",
            failure,
          ),
          errorDetail: detail,
        }, { operationKey: "logical:fail" });
      }
    },
  });
