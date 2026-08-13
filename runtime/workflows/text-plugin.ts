import type { Agent } from "../resources/index.ts";
import type {
  ContentInput,
  ContentRef,
  ContentSequence,
  PreparedContent,
  ResolvedContent,
} from "../content/index.ts";
import {
  type LlmAttempt,
  llmAttemptContent,
  type Participant,
  type SafeWorkflowError,
  type ToolExecution,
  toolExecutionContent,
} from "../domain/index.ts";
import type { CopilotzEvent, EventVisibility } from "../events/index.ts";
import type { CopilotzProcessorContext } from "../engine/index.ts";
import { chat as defaultChat } from "../llm/index.ts";
import type {
  ChatMessage,
  ProviderConfig,
  ToolInvocation,
} from "../llm/types.ts";
import { materializeAssetRefsForProvider } from "../llm/asset-materialization.ts";
import {
  type CopilotzPlugin,
  definePlugin,
  defineProcessor,
  type Processor,
} from "../plugins/index.ts";
import {
  agentAskMetadata,
  agentTextBaseConfig,
  providerRegistry,
  requireAgent,
  staticAgentTextConfig,
  textWorkflowAttemptEventMetadata,
  withAgentAskMetadata,
  withWorkflowMetadata,
  workflowMetadata,
} from "./resources.ts";
import { recordProviderAttemptLifecycle } from "./llm-lifecycle.ts";
import { createWorkflowToolExecutor } from "./tool-executor.ts";
import { createWorkflowToolCatalog } from "./tool-catalog.ts";
import {
  advanceWorkflowPipeline,
  createWorkflowPipelineMetadata,
} from "./pipeline.ts";
import { buildAgentTextPrompt } from "./prompt.ts";
import type {
  AgentTextPrompt,
  CreateTextWorkflowPluginOptions,
  WorkflowJqEvaluator,
  WorkflowMetadata,
  WorkflowToolCatalog,
} from "./types.ts";

const DEFAULT_PLUGIN_ID = "@copilotz/core-text";
const DEFAULT_PLUGIN_VERSION = "3.0.0";
const DEFAULT_TOOL_TIMEOUT_MS = 300_000;

const defaultWorkflowJq: WorkflowJqEvaluator = async (input, filter) => {
  const { evaluateJq } = await import("../tools/jq.ts");
  return await evaluateJq(input, filter);
};

function requiredText(value: string | undefined, name: string): string {
  const normalized = value?.trim();
  if (!normalized) throw new TypeError(`${name} must be non-empty.`);
  return normalized;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function safeError(
  code: string,
  message: string,
  error?: unknown,
): SafeWorkflowError {
  return Object.freeze({
    name: error instanceof Error ? error.name : undefined,
    message,
    code,
    retryable: false,
  });
}

function participantAgentId(participant: Participant): string {
  return participant.agentId ?? participant.externalId;
}

function participantInput(participant: Participant) {
  return {
    id: participant.id,
    externalId: participant.externalId,
    participantType: participant.participantType,
    ...(participant.name ? { name: participant.name } : {}),
    ...(participant.email ? { email: participant.email } : {}),
    ...(participant.agentId ? { agentId: participant.agentId } : {}),
    metadata: structuredClone(participant.metadata),
  } as const;
}

function parseJsonText(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function resolvedValue(resolved: ResolvedContent): unknown {
  if (resolved.value !== undefined) return resolved.value;
  const text = resolved.text ?? new TextDecoder().decode(resolved.bytes);
  return resolved.ref.kind === "json" ? parseJsonText(text) : text;
}

function valueContent(value: unknown, role: string): ContentInput {
  if (typeof value === "string") return { type: "text", text: value, role };
  if (value instanceof Uint8Array) {
    return {
      type: "file",
      bytes: value,
      mediaType: "application/octet-stream",
      role,
      disposition: "attachment",
    };
  }
  return { type: "json", value, role };
}

async function resolveAgentConfig(
  options: CreateTextWorkflowPluginOptions,
  agent: Agent,
  attempt: LlmAttempt,
  event: CopilotzEvent,
  context: CopilotzProcessorContext,
  prompt: AgentTextPrompt,
): Promise<ProviderConfig> {
  const baseConfig = agentTextBaseConfig(agent);
  const config = options.resolveAgentTextConfig
    ? await options.resolveAgentTextConfig({
      agent,
      attempt,
      sourceEvent: event,
      context,
      baseConfig,
      thread: prompt.thread,
      messages: prompt.messages,
      tools: prompt.tools,
    })
    : staticAgentTextConfig(agent);
  if (!config.provider) {
    throw new Error(`Agent '${agent.id}' has no text runtime provider.`);
  }
  return config;
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

async function inputMessageIds(
  context: CopilotzProcessorContext,
  threadId: string,
  triggerMessageId: string,
): Promise<readonly string[]> {
  const history = await context.conversation.listMessages(threadId, {
    limit: 1_000,
  });
  const triggerIndex = history.findIndex((message) =>
    message.id === triggerMessageId
  );
  if (triggerIndex < 0) {
    throw new Error(`Trigger message '${triggerMessageId}' was not found.`);
  }
  return Object.freeze(
    history.slice(0, triggerIndex + 1).map((message) => message.id),
  );
}

async function isLastSettledToolResult(
  context: CopilotzProcessorContext,
  messageId: string,
  threadId: string,
  metadata: WorkflowMetadata,
): Promise<boolean> {
  const batchSize = metadata.batchSize ?? 1;
  if (batchSize <= 1) return true;
  const batchId = requiredText(metadata.batchId, "Tool batch id");
  const messages = await context.conversation.listMessages(threadId, {
    limit: 1_000,
  });
  const batch = messages.filter((message) => {
    const candidate = workflowMetadata(message.metadata);
    return candidate?.kind === "tool_result" &&
      candidate.batchId === batchId;
  });
  if (
    new Set(
      batch.map((message) =>
        workflowMetadata(message.metadata)?.toolExecutionId
      ),
    ).size < batchSize
  ) return false;
  return batch.at(-1)?.id === messageId;
}

function messageRouterProcessor(
  options: CreateTextWorkflowPluginOptions,
  toolCatalog: WorkflowToolCatalog,
): Processor<CopilotzProcessorContext> {
  return defineProcessor<CopilotzProcessorContext>({
    id: "copilotz.core.message-to-text-attempt",
    on: ["message.created", "message.revised"],
    delivery: "durable",
    filter: (event) => Boolean(event.routing?.recipientIds?.length),
    async handle(event, context) {
      if (!event.durable || !event.threadId || !event.subject) return;
      const message = await context.conversation.getMessage(event.subject.id);
      if (!message) throw new Error(`Message '${event.subject.id}' vanished.`);
      const metadata = workflowMetadata(message.metadata);
      const ask = agentAskMetadata(message.metadata);
      if (
        metadata?.continuation === "realtime" ||
        metadata?.continuation === "none"
      ) return;
      if (
        metadata?.kind === "tool_result" &&
        !await isLastSettledToolResult(
          context,
          message.id,
          message.threadId,
          metadata,
        )
      ) return;

      const historyIds = await inputMessageIds(
        context,
        message.threadId,
        message.id,
      );
      for (const recipientId of new Set(message.recipientIds)) {
        const participant = await context.conversation.getParticipant(
          recipientId,
        );
        if (!participant || participant.participantType !== "agent") continue;
        const agentId = participantAgentId(participant);
        const agent = requireAgent(context.resources, agentId);
        const available = await toolCatalog.forAgent(context.resources, agent);
        const tools = options.resolveAgentTools
          ? await options.resolveAgentTools({
            agent,
            tools: available,
            sourceEvent: event,
            context,
          })
          : available;
        const availableIds = new Set(available.map((tool) => tool.key));
        const grantedIds = new Set<string>();
        for (const tool of tools) {
          if (!availableIds.has(tool.key)) {
            throw new Error(
              `Agent tool resolver granted unavailable tool '${tool.key}'.`,
            );
          }
          if (grantedIds.has(tool.key)) {
            throw new Error(
              `Agent tool resolver returned duplicate tool '${tool.key}'.`,
            );
          }
          grantedIds.add(tool.key);
        }
        const continuationKey = metadata?.kind === "tool_result"
          ? `${requiredText(metadata.batchId, "Tool batch id")}:${recipientId}`
          : `${message.id}:${recipientId}`;
        const attemptMetadata = {
          triggerMessageId: message.id,
          ...(metadata?.batchId ? { batchId: metadata.batchId } : {}),
        };
        await context.llmAttempts.create({
          id: `llm:${continuationKey}`,
          threadId: message.threadId,
          messageId: message.id,
          participantId: participant.id,
          initiatorParticipantId: message.sender.id,
          agentId,
          parentAttemptId: metadata?.parentLlmAttemptId ??
            ask?.callingAttemptId,
          inputMessageIds: historyIds,
          availableToolIds: tools.map((tool) => tool.key),
          status: "running",
          metadata: ask
            ? withAgentAskMetadata(attemptMetadata, ask)
            : attemptMetadata,
        }, {
          operationKey: `route:${continuationKey}`,
        });
      }
    },
  });
}

function executeTextAttemptProcessor(
  options: CreateTextWorkflowPluginOptions,
  toolCatalog: WorkflowToolCatalog,
): Processor<CopilotzProcessorContext> {
  const runChat = options.chat ?? defaultChat;
  return defineProcessor<CopilotzProcessorContext>({
    id: "copilotz.core.execute-text-attempt",
    on: ["llm_attempt.created"],
    delivery: "durable",
    filter: (event) => textWorkflowAttemptEventMetadata(event.metadata),
    async handle(event, context) {
      if (!event.durable || !event.subject) return;
      const attempt = await context.llmAttempts.get(event.subject.id);
      if (!attempt || attempt.status !== "running") return;
      const agent = requireAgent(
        context.resources,
        requiredText(attempt.agentId, "LLM attempt agent id"),
      );
      const participant = attempt.participantId
        ? await context.conversation.getParticipant(attempt.participantId)
        : null;
      if (!participant || participant.participantType !== "agent") {
        throw new Error(
          `LLM attempt '${attempt.id}' has no agent participant.`,
        );
      }
      const granted = new Set(attempt.availableToolIds);
      const tools = (await toolCatalog.forAgent(context.resources, agent))
        .filter((tool) => granted.has(tool.key));
      const prompt = await buildAgentTextPrompt(context, {
        options,
        agent,
        participant,
        attempt,
        sourceEvent: event,
        tools,
      });
      const config = await resolveAgentConfig(
        options,
        agent,
        attempt,
        event,
        context,
        prompt,
      );
      const providers = providerRegistry(context.resources);
      if (!providers[String(config.provider)]) {
        throw new Error(
          `LLM provider resource '${
            String(config.provider)
          }' is not registered.`,
        );
      }
      if (
        attempt.provider !== config.provider || attempt.model !== config.model
      ) {
        await context.llmAttempts.update({
          id: attempt.id,
          provider: String(config.provider),
          model: config.model,
        }, { operationKey: "logical:runtime-config" });
      }

      const publicAgent = Object.freeze({
        id: agent.id,
        name: agent.name,
        participantId: participant.id,
      });
      let liveSequence = 0;
      let liveEmission = Promise.resolve();
      let liveEmissionError: unknown;
      const emitLive = (type: string, payload: unknown): void => {
        const sequence = liveSequence++;
        liveEmission = liveEmission.then(async () => {
          if (liveEmissionError !== undefined) return;
          try {
            await context.events.emit({
              type,
              threadId: attempt.threadId,
              payload,
              routing: {
                senderId: participant.id,
                recipientIds: [],
              },
              visibility: { kind: "public" },
              metadata: { llmAttemptId: attempt.id },
              correlationId: event.correlationId,
              causationId: event.id,
              streamId: attempt.id,
              sequence,
            });
          } catch (error) {
            liveEmissionError = error;
          }
        });
      };
      const settleLiveEmissions = async (): Promise<void> => {
        await liveEmission;
        if (liveEmissionError !== undefined) throw liveEmissionError;
      };

      try {
        const response = await runChat(
          {
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
              emitLive("tool_call.delta", {
                ...structuredClone(delta),
                agent: publicAgent,
                llmAttemptId: attempt.id,
              }),
            onAttemptLifecycle: (lifecycle) =>
              recordProviderAttemptLifecycle(attempt, lifecycle, context),
          },
          config,
          { ...(options.env ?? {}) },
          (chunk, streamOptions) =>
            emitLive(
              streamOptions?.isReasoning ? "reasoning.delta" : "text.delta",
              {
                text: chunk,
                agent: publicAgent,
                llmAttemptId: attempt.id,
              },
            ),
          providers,
        );
        await settleLiveEmissions();

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
        await context.llmAttempts.complete({
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
        await liveEmission;
        const failure = liveEmissionError ?? error;
        if (context.signal.aborted) {
          await context.llmAttempts.cancel({
            id: attempt.id,
            reason: errorText(context.signal.reason ?? failure),
          }, { operationKey: "logical:cancel" });
          return;
        }
        const detail = await context.content.prepare({
          type: "text",
          text: errorText(failure),
          role: "provider.error_detail",
        }, { operationKey: "logical:error" });
        await context.llmAttempts.fail({
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
}

async function toolCallsFromAttempt(
  context: CopilotzProcessorContext,
  attempt: LlmAttempt,
): Promise<readonly ToolInvocation[]> {
  const ref = llmAttemptContent(attempt).toolCalls;
  if (!ref) return Object.freeze([]);
  const resolved = await context.content.resolve(ref);
  const value = resolvedValue(resolved);
  return Object.freeze(Array.isArray(value) ? value as ToolInvocation[] : []);
}

function projectTextResultProcessor(
  toolCatalog: WorkflowToolCatalog,
): Processor<CopilotzProcessorContext> {
  return defineProcessor<CopilotzProcessorContext>({
    id: "copilotz.core.project-text-result",
    on: ["llm_attempt.completed", "llm_attempt.failed"],
    delivery: "durable",
    filter: (event) => textWorkflowAttemptEventMetadata(event.metadata),
    async handle(event, context) {
      if (
        !event.durable || !event.subject ||
        event.type !== "llm_attempt.completed"
      ) {
        return;
      }
      const attempt = await context.llmAttempts.get(event.subject.id);
      if (!attempt || attempt.status !== "completed") return;
      const participant = attempt.participantId
        ? await context.conversation.getParticipant(attempt.participantId)
        : null;
      if (!participant || participant.participantType !== "agent") {
        throw new Error(
          `LLM attempt '${attempt.id}' has no agent participant.`,
        );
      }
      const content = llmAttemptContent(attempt);
      const toolCalls = await toolCallsFromAttempt(context, attempt);
      const activeAsk = agentAskMetadata(attempt.metadata);
      const outputAsk = activeAsk
        ? Object.freeze({
          ...activeAsk,
          phase: toolCalls.length ? "progress" as const : "answer" as const,
          answerAttemptId: attempt.id,
        })
        : null;
      const messageMetadata = withWorkflowMetadata(
        outputAsk ? withAgentAskMetadata(undefined, outputAsk) : undefined,
        {
          kind: "agent_output",
          llmAttemptId: attempt.id,
          agentParticipantId: participant.id,
        },
      );
      const outputMessage = await context.conversation.createMessage({
        id: `message:${attempt.id}:output`,
        threadId: attempt.threadId,
        sender: participantInput(participant),
        recipientIds: [],
        content: content.answer ? [content.answer] : [],
        visibility: { kind: "public" },
        metadata: messageMetadata,
      }, {
        operationKey: "project:agent-message",
        metadata: messageMetadata,
      });
      const outputMessageId = outputMessage.value?.id;
      if (!outputMessageId) {
        throw new Error(`LLM attempt '${attempt.id}' produced no message.`);
      }
      if (!toolCalls.length) return;

      const agent = requireAgent(
        context.resources,
        requiredText(attempt.agentId, "LLM attempt agent id"),
      );
      const granted = new Set(attempt.availableToolIds);
      const availableTools = (await toolCatalog.forAgent(
        context.resources,
        agent,
      )).filter((tool) => granted.has(tool.key));
      const toolsByKey = new Map(
        availableTools.map((tool) => [tool.key, tool]),
      );

      const batchId = attempt.id;
      for (const [index, call] of toolCalls.entries()) {
        const toolId = requiredText(call.tool?.id, "Tool call tool id");
        const tool = toolsByKey.get(toolId);
        const parsedArguments = typeof call.args === "string"
          ? parseJsonText(call.args)
          : call.args;
        const preparedArguments = await context.content.prepare(
          valueContent(parsedArguments, "tool.arguments"),
          { operationKey: `project:tool:${call.id}:arguments` },
        );
        const executionMetadata = withWorkflowMetadata(
          activeAsk ? withAgentAskMetadata(undefined, activeAsk) : undefined,
          {
            kind: "tool_execution",
            llmAttemptId: attempt.id,
            parentLlmAttemptId: attempt.id,
            toolCallId: call.id,
            batchId,
            batchSize: toolCalls.length,
            batchIndex: index,
            ...(outputMessageId ? { sourceMessageId: outputMessageId } : {}),
            agentParticipantId: participant.id,
            ...(call.pipeline
              ? { pipeline: createWorkflowPipelineMetadata(call.pipeline) }
              : {}),
          },
        );
        await context.toolExecutions.create({
          id: `tool:${attempt.id}:${call.id}`,
          threadId: attempt.threadId,
          ...(outputMessageId ? { messageId: outputMessageId } : {}),
          participantId: participant.id,
          agentId: attempt.agentId,
          toolCallId: call.id,
          tool: { id: toolId, name: tool?.name ?? call.tool?.name ?? toolId },
          arguments: preparedArguments,
          status: "running",
          historyVisibility: tool?.historyPolicy?.visibility ?? "public_status",
          metadata: executionMetadata,
        }, {
          operationKey: `project:tool:${call.id}:create`,
          metadata: executionMetadata,
        });
      }
    },
  });
}

function executeToolProcessor(
  options: CreateTextWorkflowPluginOptions,
  toolCatalog: WorkflowToolCatalog,
): Processor<CopilotzProcessorContext> {
  const execute = createWorkflowToolExecutor({
    defaultTimeoutMs: options.toolExecutionTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS,
    timeoutsMs: options.toolExecutionTimeoutsMs,
  });
  return defineProcessor<CopilotzProcessorContext>({
    id: "copilotz.core.execute-tool",
    on: ["tool_execution.created"],
    delivery: "durable",
    async handle(event, context) {
      if (!event.durable || !event.subject) return;
      const execution = await context.toolExecutions.get(event.subject.id);
      if (!execution || execution.status !== "running") return;
      const toolId = requiredText(
        typeof execution.tool.id === "string" ? execution.tool.id : undefined,
        "Tool execution tool id",
      );
      const agent = execution.agentId
        ? context.resources.get<Agent>("agents", execution.agentId)
        : undefined;
      let availableTools = agent
        ? await toolCatalog.forAgent(context.resources, agent)
        : await toolCatalog.all(context.resources);
      const workflow = workflowMetadata(execution.metadata);
      const attemptId = workflow?.parentLlmAttemptId ?? workflow?.llmAttemptId;
      if (attemptId) {
        const attempt = await context.llmAttempts.get(attemptId);
        if (attempt) {
          const granted = new Set(attempt.availableToolIds);
          availableTools = availableTools.filter((tool) =>
            granted.has(tool.key)
          );
        }
      }
      const tool = availableTools.find((candidate) => candidate.key === toolId);
      const argumentRef = toolExecutionContent(execution).arguments;
      const args = resolvedValue(await context.content.resolve(argumentRef));
      const outcome = await execute({
        execution,
        tool,
        availableTools,
        arguments: args,
        context,
      });
      if (outcome.status === "completed") {
        const prepared = await context.content.prepare(
          valueContent(outcome.output, "tool.output"),
          { operationKey: "tool:output" },
        );
        const attachments = outcome.attachments
          ? await context.content.prepare(outcome.attachments, {
            operationKey: "tool:attachments",
          })
          : undefined;
        await context.toolExecutions.complete({
          id: execution.id,
          output: prepared,
          projectedOutput: prepared,
          ...(attachments ? { attachments } : {}),
          historyVisibility: execution.historyVisibility ?? "public_status",
          durationMs: outcome.durationMs,
        }, { operationKey: "tool:complete" });
        return;
      }
      if (outcome.status === "deferred") return;

      const message = outcome.status === "cancelled"
        ? outcome.reason
        : outcome.message;
      const detail = await context.content.prepare({
        type: "text",
        text: message,
        role: "tool.error_detail",
      }, { operationKey: "tool:error-detail" });
      const projection = await context.content.prepare({
        type: "json",
        value: {
          ok: false,
          status: outcome.status,
          code: outcome.code,
          error: message,
        },
        role: "tool.projected_output",
      }, { operationKey: "tool:error-projection" });
      if (outcome.status === "cancelled") {
        await context.toolExecutions.cancel({
          id: execution.id,
          reason: outcome.reason,
          errorDetail: detail,
          projectedOutput: projection,
          historyVisibility: execution.historyVisibility ?? "public_status",
          durationMs: outcome.durationMs,
        }, { operationKey: "tool:cancel" });
        return;
      }
      await context.toolExecutions.fail({
        id: execution.id,
        safeError: safeError(
          outcome.code,
          "Tool execution failed.",
          outcome.error,
        ),
        errorDetail: detail,
        projectedOutput: projection,
        historyVisibility: execution.historyVisibility ?? "public_status",
        durationMs: outcome.durationMs,
      }, { operationKey: "tool:fail" });
    },
  });
}

function resultVisibility(execution: ToolExecution): EventVisibility {
  const policy = execution.historyVisibility === "requester_only" ||
      execution.historyVisibility === "public"
    ? execution.historyVisibility
    : "public_status";
  return execution.participantId
    ? { kind: "tool" as const, policy, requesterId: execution.participantId }
    : { kind: "internal" as const };
}

async function resultContent(
  context: CopilotzProcessorContext,
  execution: ToolExecution,
  override?: ContentSequence | PreparedContent,
): Promise<ContentSequence | PreparedContent> {
  if (override) return override;
  const content = toolExecutionContent(execution);
  const selected: ContentRef | undefined = content.projectedOutput ??
    content.output;
  if (selected || content.attachments.length > 0) {
    return Object.freeze([
      ...(selected ? [selected] : []),
      ...content.attachments,
    ]);
  }
  return await context.content.prepare({
    type: "text",
    text: execution.status === "failed"
      ? execution.safeError?.message ?? "Tool execution failed."
      : "No output returned",
    role: "tool.projected_output",
  }, { operationKey: "project:tool-result:fallback" });
}

async function executionOutput(
  context: CopilotzProcessorContext,
  execution: ToolExecution,
): Promise<unknown> {
  const content = toolExecutionContent(execution);
  const selected = content.projectedOutput ?? content.output;
  return selected
    ? resolvedValue(await context.content.resolve(selected))
    : undefined;
}

function projectToolResultProcessor(
  toolCatalog: WorkflowToolCatalog,
  evaluateJq: WorkflowJqEvaluator,
): Processor<CopilotzProcessorContext> {
  return defineProcessor<CopilotzProcessorContext>({
    id: "copilotz.core.project-tool-result",
    on: [
      "tool_execution.completed",
      "tool_execution.failed",
      "tool_execution.cancelled",
    ],
    delivery: "durable",
    async handle(event, context) {
      if (!event.durable || !event.subject) return;
      let execution = await context.toolExecutions.get(event.subject.id);
      if (!execution || execution.status === "running") return;
      let metadata = workflowMetadata(execution.metadata);
      let projectedStatus = execution.status;
      let projectedContent: ContentSequence | PreparedContent | undefined;

      if (
        metadata?.pipeline && execution.status === "completed" &&
        metadata.pipeline.stageIndex < metadata.pipeline.stages.length - 1
      ) {
        const advancement = await advanceWorkflowPipeline({
          pipeline: metadata.pipeline,
          output: await executionOutput(context, execution),
          upstreamToolExecutionId: execution.id,
          evaluateJq,
        });
        if (advancement.kind === "next_tool") {
          const agent = execution.agentId
            ? context.resources.get<Agent>("agents", execution.agentId)
            : undefined;
          let availableTools = agent
            ? await toolCatalog.forAgent(context.resources, agent)
            : await toolCatalog.all(context.resources);
          const attemptId = metadata.parentLlmAttemptId ??
            metadata.llmAttemptId;
          if (attemptId) {
            const attempt = await context.llmAttempts.get(attemptId);
            if (attempt) {
              const granted = new Set(attempt.availableToolIds);
              availableTools = availableTools.filter((tool) =>
                granted.has(tool.key)
              );
            }
          }
          const nextTool = availableTools.find((candidate) =>
            candidate.key === advancement.stage.tool.id
          );
          const preparedArguments = await context.content.prepare(
            valueContent(advancement.arguments, "tool.arguments"),
            {
              operationKey:
                `pipeline:${advancement.pipeline.id}:${advancement.stageIndex}:arguments`,
            },
          );
          const { toolExecutionId: _completedToolExecutionId, ...workflow } =
            metadata;
          const nextWorkflow: WorkflowMetadata = {
            ...workflow,
            kind: "tool_execution",
            toolCallId: advancement.stage.id,
            pipeline: advancement.pipeline,
          };
          const activeAsk = agentAskMetadata(execution.metadata);
          const nextMetadata = withWorkflowMetadata(
            activeAsk ? withAgentAskMetadata(undefined, activeAsk) : undefined,
            nextWorkflow,
          );
          const parentAttemptId = metadata.parentLlmAttemptId ??
            metadata.llmAttemptId ?? "pipeline";
          await context.toolExecutions.create({
            id:
              `tool:${parentAttemptId}:pipeline:${advancement.pipeline.id}:${advancement.stageIndex}`,
            threadId: execution.threadId,
            messageId: execution.messageId,
            participantId: execution.participantId,
            agentId: execution.agentId,
            toolCallId: advancement.stage.id,
            tool: {
              id: advancement.stage.tool.id,
              name: nextTool?.name ?? advancement.stage.tool.name ??
                advancement.stage.tool.id,
            },
            arguments: preparedArguments,
            status: "running",
            historyVisibility: nextTool?.historyPolicy?.visibility ??
              execution.historyVisibility ?? "public_status",
            metadata: nextMetadata,
          }, {
            operationKey:
              `pipeline:${advancement.pipeline.id}:${advancement.stageIndex}:create`,
            metadata: nextMetadata,
          });
          return;
        }

        if (advancement.kind === "settled" && advancement.projected) {
          projectedContent = await context.content.prepare(
            valueContent(advancement.output, "tool.projected_output"),
            {
              operationKey: `pipeline:${metadata.pipeline.id}:final-projection`,
            },
          );
          await context.toolExecutions.update({
            id: execution.id,
            projectedOutput: projectedContent,
          }, {
            operationKey:
              `pipeline:${metadata.pipeline.id}:persist-final-projection`,
          });
          execution = await context.toolExecutions.get(execution.id) ??
            execution;
        }

        if (advancement.kind === "failed") {
          projectedStatus = "failed";
          projectedContent = await context.content.prepare({
            type: "json",
            value: {
              ok: false,
              status: "failed",
              code: "pipeline_error",
              error: advancement.message,
            },
            role: "tool.projected_output",
          }, {
            operationKey: `pipeline:${metadata.pipeline.id}:failure-projection`,
          });
          const failedWorkflow: WorkflowMetadata = {
            ...metadata,
            pipelineFailure: {
              stageIndex: advancement.stageIndex,
              message: advancement.message,
            },
          };
          await context.toolExecutions.update({
            id: execution.id,
            projectedOutput: projectedContent,
            metadataPatch: withWorkflowMetadata(undefined, failedWorkflow),
          }, {
            operationKey: `pipeline:${metadata.pipeline.id}:persist-failure`,
          });
          execution = await context.toolExecutions.get(execution.id) ??
            execution;
          metadata = failedWorkflow;
        }
      }

      const recipientId = execution.participantId ??
        metadata?.agentParticipantId;
      if (!recipientId) {
        throw new Error(`Tool execution '${execution.id}' has no requester.`);
      }
      const toolId = requiredText(
        typeof execution.tool.id === "string" ? execution.tool.id : undefined,
        "Tool execution tool id",
      );
      const activeAsk = agentAskMetadata(execution.metadata);
      const resultBaseMetadata = activeAsk
        ? withAgentAskMetadata({
          historyVisibility: execution.historyVisibility ?? "public_status",
          requesterId: recipientId,
          toolStatus: projectedStatus,
          toolId,
        }, activeAsk)
        : {
          historyVisibility: execution.historyVisibility ?? "public_status",
          requesterId: recipientId,
          toolStatus: projectedStatus,
          toolId,
        };
      const messageMetadata = withWorkflowMetadata(resultBaseMetadata, {
        kind: "tool_result",
        continuation: metadata?.continuation,
        realtimeStreamId: metadata?.realtimeStreamId,
        llmAttemptId: metadata?.llmAttemptId,
        parentLlmAttemptId: metadata?.parentLlmAttemptId ??
          metadata?.llmAttemptId,
        toolExecutionId: execution.id,
        toolCallId: metadata?.pipeline?.rootToolCallId ?? execution.toolCallId,
        batchId: metadata?.batchId ?? execution.id,
        batchSize: metadata?.batchSize ?? 1,
        batchIndex: metadata?.batchIndex ?? 0,
        sourceMessageId: metadata?.sourceMessageId,
        agentParticipantId: recipientId,
        ...(metadata?.pipeline ? { pipeline: metadata.pipeline } : {}),
        ...(metadata?.pipelineFailure
          ? { pipelineFailure: metadata.pipelineFailure }
          : {}),
      });
      await context.conversation.createMessage({
        id: `message:${execution.id}:result`,
        threadId: execution.threadId,
        sender: {
          externalId: `tool:${toolId}`,
          participantType: "tool",
          name: typeof execution.tool.name === "string"
            ? execution.tool.name
            : toolId,
        },
        recipientIds: [recipientId],
        content: await resultContent(context, execution, projectedContent),
        visibility: resultVisibility(execution),
        metadata: messageMetadata,
      }, {
        operationKey: "project:tool-result:message",
        metadata: messageMetadata,
      });
    },
  });
}

/** Creates the built-in event-native text/tool workflow as ordinary resources. */
export function createTextWorkflowPlugin(
  options: CreateTextWorkflowPluginOptions = {},
): CopilotzPlugin {
  const toolCatalog = options.toolCatalog ?? createWorkflowToolCatalog();
  const evaluateJq = options.evaluateJq ?? defaultWorkflowJq;
  const processors = Object.freeze([
    messageRouterProcessor(options, toolCatalog),
    executeTextAttemptProcessor(options, toolCatalog),
    projectTextResultProcessor(toolCatalog),
    executeToolProcessor(options, toolCatalog),
    projectToolResultProcessor(toolCatalog, evaluateJq),
  ]);
  return definePlugin({
    manifest: {
      id: options.id ?? DEFAULT_PLUGIN_ID,
      version: options.version ?? DEFAULT_PLUGIN_VERSION,
      provides: {
        processors: processors.map((processor) => processor.id),
      },
    },
    resources: { processors },
  });
}
