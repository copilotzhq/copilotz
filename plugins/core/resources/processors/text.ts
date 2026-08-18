import type { CollectionRecord } from "@copilotz/copilotz/collections";
import type { Agent } from "@copilotz/copilotz/resources";
import {
  type ContentInput,
  type ContentRef,
  type ContentSequence,
  llmAttemptContent,
  mergePreparedContent,
  type PreparedContent,
  type ResolvedContent,
  toolExecutionContent,
} from "@copilotz/copilotz/content";
import type { SafeWorkflowError } from "@copilotz/copilotz/domain";
import type { EventVisibility } from "@copilotz/copilotz/events";
import {
  agentAskMetadata,
  deriveWorkflowId,
  textWorkflowAttemptEventMetadata,
  type WorkflowMetadata,
  withAgentAskMetadata,
  withWorkflowMetadata,
  workflowMetadata,
} from "@copilotz/copilotz/events";
import type { CopilotzProcessorContext } from "@copilotz/copilotz/engine";
import { defineProcessor, type Processor } from "@copilotz/copilotz/plugins";
import {
  agentTextBaseConfig,
  buildAgentTextPrompt,
  requireAgent,
  staticAgentTextConfig,
} from "@copilotz/copilotz/agents";
import {
  type AgentTextPrompt,
  type ChatMessage,
  type CreateTextWorkflowPluginOptions,
  materializeAssetRefsForProvider,
  type ProviderConfig,
  recordProviderAttemptLifecycle,
  requireLlmGenerate,
  type ToolInvocation,
} from "@copilotz/copilotz/llm";
import {
  advanceWorkflowPipeline,
  createWorkflowPipelineMetadata,
  createWorkflowToolCatalog,
  evaluateJq as defaultEvaluateJq,
  executeTool,
  type WorkflowJqEvaluator,
  type WorkflowToolCatalog,
} from "@copilotz/copilotz/tools";
import {
  asRecord,
  collectionEventRecord,
  errorText,
  listThreadMessages,
  llmResource,
  mapLlmAttempt,
  optionalText,
  participantAgentId,
  requireCollection,
  requiredText,
  stringArray,
} from "./helpers.ts";
import {
  cancelLlmAttemptRecord,
  cancelToolExecutionRecord,
  completeLlmAttemptRecord,
  completeToolExecutionRecord,
  createThreadMessage,
  createToolExecutionBatch,
  createToolExecutionRecord,
  failLlmAttemptRecord,
  failToolExecutionRecord,
  patchToolExecutionRecord,
} from "./writes.ts";

const DEFAULT_TOOL_TIMEOUT_MS = 300_000;
const defaultToolCatalog = createWorkflowToolCatalog();

function recordThreadId(record: CollectionRecord): string {
  return requiredText(optionalText(record.threadId), "thread id");
}

function toolField(record: CollectionRecord, field: string): unknown {
  return asRecord(record.tool)[field];
}

function historyVisibilityOf(record: CollectionRecord): string {
  return optionalText(record.historyVisibility) ?? "public_status";
}

function toolCatalogFor(
  _context: CopilotzProcessorContext,
  agent?: Agent,
): WorkflowToolCatalog {
  const extra = agent as Agent & Partial<CreateTextWorkflowPluginOptions> | undefined;
  return extra?.toolCatalog ?? defaultToolCatalog;
}

function jqFor(
  _context: CopilotzProcessorContext,
  agent?: Agent,
): WorkflowJqEvaluator {
  const extra = agent as Agent & Partial<CreateTextWorkflowPluginOptions> | undefined;
  return extra?.evaluateJq ?? defaultEvaluateJq;
}

function policyFromAgent(agent: Agent): CreateTextWorkflowPluginOptions {
  return agent as Agent & CreateTextWorkflowPluginOptions;
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

function policyOptions(
  agent: Agent,
): CreateTextWorkflowPluginOptions {
  return policyFromAgent(agent);
}

async function resolveAgentConfig(
  options: CreateTextWorkflowPluginOptions,
  agent: Agent,
  attempt: CollectionRecord,
  event: Parameters<Processor<CopilotzProcessorContext>["handle"]>[0],
  context: CopilotzProcessorContext,
  prompt: AgentTextPrompt,
): Promise<ProviderConfig> {
  const baseConfig = agentTextBaseConfig(agent);
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
    : staticAgentTextConfig(agent);
  if (!config.provider) {
    throw new Error(`Agent '${agent.id}' has no text runtime provider.`);
  }
  return config;
}

const TERMINAL_TOOL_STATUSES = new Set(["completed", "failed", "cancelled"]);

async function isLastSettledToolResult(
  context: CopilotzProcessorContext,
  threadId: string,
  metadata: WorkflowMetadata,
): Promise<boolean> {
  const batchSize = metadata.batchSize ?? 1;
  if (batchSize <= 1) return true;
  const batchId = requiredText(metadata.batchId, "Tool batch id");
  const executionId = requiredText(
    metadata.toolExecutionId,
    "Tool execution id",
  );
  const executions = requireCollection(context, "tool_execution");
  const history = await executions.list(context.namespace, {
    where: { threadId },
    order: { field: "createdAt", direction: "asc" },
    limit: 1_000,
  });
  const batch = history.filter((record) =>
    workflowMetadata(asRecord(record.metadata))?.batchId === batchId
  );
  const terminal = batch.filter((record) =>
    TERMINAL_TOOL_STATUSES.has(String(record.status))
  );
  if (terminal.length < batchSize) return false;
  const last = [...terminal].sort((left, right) => {
    const finished = String(left.finishedAt ?? left.updatedAt).localeCompare(
      String(right.finishedAt ?? right.updatedAt),
    );
    return finished !== 0
      ? finished
      : String(left.id).localeCompare(String(right.id));
  }).at(-1);
  return last?.id === executionId;
}

async function loadParticipant(
  context: CopilotzProcessorContext,
  id: string,
): Promise<CollectionRecord | null> {
  return await requireCollection(context, "participant").get(
    id,
    context.namespace,
  );
}

export const messageRouterProcessor: Processor<CopilotzProcessorContext> =
  defineProcessor<CopilotzProcessorContext>({
    id: "copilotz.core.message-to-text-attempt",
    on: [{ eventType: "message.created" }],
    async handle(event, context) {
      if (!event.routing?.recipientIds?.length) return;
      if (!event.durable || !event.threadId) return;
      const record = collectionEventRecord(event);
      const sender = await loadParticipant(context, String(record.senderId));
      if (!sender) {
        throw new Error(`Message '${record.id}' sender was not found.`);
      }
      const metadata = workflowMetadata(asRecord(record.metadata));
      const ask = agentAskMetadata(asRecord(record.metadata));
      if (
        metadata?.continuation === "realtime" ||
        metadata?.continuation === "none"
      ) return;
      if (
        metadata?.kind === "tool_result" &&
        !await isLastSettledToolResult(
          context,
          String(record.threadId),
          metadata,
        )
      ) return;

      const history = await listThreadMessages(context, String(record.threadId));
      const triggerIndex = history.findIndex((item) => item.id === record.id);
      if (triggerIndex < 0) {
        throw new Error(`Trigger message '${record.id}' was not found.`);
      }
      const historyIds = Object.freeze(
        history.slice(0, triggerIndex + 1).map((item) => item.id),
      );
      for (const recipientId of new Set(stringArray(record.recipientIds))) {
        const participant = await loadParticipant(context, recipientId);
        if (!participant || participant.participantType !== "agent") continue;
        const agentId = participantAgentId(participant);
        const agent = context.resources.get<Agent>("agents", agentId);
        if (!agent) continue;
        const options = policyOptions(agent);
        const toolCatalog = toolCatalogFor(context, agent);
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
          : `${record.id}:${recipientId}`;
        const attemptMetadata = {
          triggerMessageId: record.id,
          ...(metadata?.batchId ? { batchId: metadata.batchId } : {}),
        };
        const id = await deriveWorkflowId("llm", continuationKey);
        await context.transaction({
          operationKey: `route:${continuationKey}`,
          namespace: event.namespace,
          identity: { metadata: ask
            ? withAgentAskMetadata(attemptMetadata, ask)
            : attemptMetadata },
          execute: async ({ collections }) => {
            await collections.llm_attempt.create({
              id,
              threadId: String(record.threadId),
              messageId: record.id,
              participantId: participant.id,
              initiatorParticipantId: sender.id,
              agentId,
              ...(metadata?.parentLlmAttemptId ?? ask?.callingAttemptId
                ? {
                  parentAttemptId: metadata?.parentLlmAttemptId ??
                    ask?.callingAttemptId,
                }
                : {}),
              inputMessageIds: [...historyIds],
              availableToolIds: tools.map((tool) => tool.key),
              status: "running",
              metadata: ask
                ? withAgentAskMetadata(attemptMetadata, ask)
                : attemptMetadata,
            }, {
              namespace: event.namespace,
              threadId: String(record.threadId),
              identity: {
                metadata: ask
                  ? withAgentAskMetadata(attemptMetadata, ask)
                  : attemptMetadata,
              },
            });
          },
        });
      }
    },
  });

export const executeTextAttemptProcessor: Processor<CopilotzProcessorContext> =
  defineProcessor<CopilotzProcessorContext>({
    id: "copilotz.core.execute-text-attempt",
    on: [{ eventType: "llm_attempt.created" }],
    async handle(event, context) {
      if (!event.durable) return;
      const record = collectionEventRecord(event);
      const attempt = record;
      if (!textWorkflowAttemptEventMetadata(asRecord(attempt.metadata))) return;
      if (String(attempt.status) !== "running") return;
      const agent = requireAgent(
        context.resources,
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
      const llm = llmResource(context, String(config.provider));
      const generate = requireLlmGenerate(llm);
      if (
        attempt.provider !== config.provider || attempt.model !== config.model
      ) {
        await context.transaction({
          operationKey: "logical:runtime-config",
          namespace: event.namespace,
          execute: async ({ collections }) => {
            await collections.llm_attempt.update(attempt.id, {
              set: {
                provider: String(config.provider),
                model: config.model,
              },
            }, { namespace: event.namespace, threadId: String(attempt.threadId) });
          },
        });
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
              threadId: recordThreadId(attempt),
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
        const response = await generate({
          request: {
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
          env: { ...(options.env ?? {}) },
          stream: (chunk, streamOptions) =>
            emitLive(
              streamOptions?.isReasoning ? "reasoning.delta" : "text.delta",
              {
                text: chunk,
                agent: publicAgent,
                llmAttemptId: attempt.id,
              },
            ),
        }).result;
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
        await completeLlmAttemptRecord(context, attempt, {
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
          await cancelLlmAttemptRecord(context, attempt, {
            reason: errorText(context.signal.reason ?? failure),
          }, { operationKey: "logical:cancel" });
          return;
        }
        const detail = await context.content.prepare({
          type: "text",
          text: errorText(failure),
          role: "provider.error_detail",
        }, { operationKey: "logical:error" });
        await failLlmAttemptRecord(context, attempt, {
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

async function toolCallsFromAttempt(
  context: CopilotzProcessorContext,
  attempt: CollectionRecord,
): Promise<readonly ToolInvocation[]> {
  const ref = llmAttemptContent(attempt).toolCalls;
  if (!ref) return Object.freeze([]);
  const resolved = await context.content.resolve(ref);
  const value = resolvedValue(resolved);
  return Object.freeze(Array.isArray(value) ? value as ToolInvocation[] : []);
}

export const projectTextResultProcessor: Processor<CopilotzProcessorContext> =
  defineProcessor<CopilotzProcessorContext>({
    id: "copilotz.core.project-text-result",
    on: [{
      eventType: "llm_attempt.updated",
      data: { record: { status: "completed" } },
    }],
    async handle(event, context) {
      const record = collectionEventRecord(event);
      const attempt = record;
      if (!textWorkflowAttemptEventMetadata(asRecord(attempt.metadata))) return;
      if (String(attempt.status) !== "completed") return;
      const participant = optionalText(attempt.participantId)
        ? await loadParticipant(context, optionalText(attempt.participantId)!)
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
      const outputMessage = await createThreadMessage(context, {
        id: await deriveWorkflowId("message", attempt.id, "output"),
        threadId: recordThreadId(attempt),
        sender: participant,
        recipientIds: [],
        content: content.answer ? [content.answer] : [],
        visibility: { kind: "public" },
        metadata: messageMetadata,
      }, {
        operationKey: "project:agent-message",
        metadata: messageMetadata,
      });
      const outputMessageId = String(outputMessage.id);
      if (!toolCalls.length) return;

      const agent = requireAgent(
        context.resources,
        requiredText(optionalText(attempt.agentId), "LLM attempt agent id"),
      );
      const toolCatalog = toolCatalogFor(context, agent);
      const granted = new Set(stringArray(attempt.availableToolIds));
      const availableTools = (await toolCatalog.forAgent(
        context.resources,
        agent,
      )).filter((tool) => granted.has(tool.key));
      const toolsByKey = new Map(
        availableTools.map((tool) => [tool.key, tool]),
      );

      const batchId = attempt.id;
      const items = [];
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
        const toolName = typeof tool?.name === "string"
          ? tool.name
          : call.tool?.name ?? toolId;
        items.push({
          id: await deriveWorkflowId("tool", attempt.id, call.id),
          ...(outputMessageId ? { messageId: outputMessageId } : {}),
          participantId: participant.id,
          agentId: optionalText(attempt.agentId),
          toolCallId: call.id,
          tool: { id: toolId, name: toolName },
          arguments: preparedArguments,
          status: "running",
          historyVisibility: tool?.historyPolicy?.visibility ?? "public_status",
          metadata: executionMetadata,
          sender: {
            externalId: `tool:${toolId}`,
            participantType: "tool" as const,
            name: toolName,
          },
        });
      }
      await createToolExecutionBatch(context, {
        threadId: recordThreadId(attempt),
        items,
      }, { operationKey: `project:tools:${attempt.id}:create` });
    },
  });

export const executeToolProcessor: Processor<CopilotzProcessorContext> =
  defineProcessor<CopilotzProcessorContext>({
    id: "copilotz.core.execute-tool",
    on: [{ eventType: "tool_execution.created" }],
    async handle(event, context) {
      const record = collectionEventRecord(event);
      const execution = record;
      if (String(execution.status) !== "running") return;
      const agent = optionalText(execution.agentId)
        ? context.resources.get<Agent>("agents", optionalText(execution.agentId)!)
        : undefined;
      const toolCatalog = toolCatalogFor(context, agent);
      const options = agent ? policyOptions(agent) : {};
      const toolId = requiredText(
        typeof toolField(execution, "id") === "string"
          ? toolField(execution, "id") as string
          : undefined,
        "Tool execution tool id",
      );
      let availableTools = agent
        ? await toolCatalog.forAgent(context.resources, agent)
        : await toolCatalog.all(context.resources);
      const workflow = workflowMetadata(execution.metadata);
      const attemptId = workflow?.parentLlmAttemptId ?? workflow?.llmAttemptId;
      if (attemptId) {
        const attemptRecord = await requireCollection(context, "llm_attempt")
          .get(attemptId, context.namespace);
        if (attemptRecord) {
          const attempt = attemptRecord;
          const granted = new Set(stringArray(attempt.availableToolIds));
          availableTools = (await toolCatalog.all(context.resources)).filter((
            tool,
          ) => granted.has(tool.key));
        }
      }
      const tool = availableTools.find((candidate) => candidate.key === toolId);
      const argumentRef = toolExecutionContent(execution).arguments;
      const args = resolvedValue(await context.content.resolve(argumentRef));
      const outcome = await executeTool({
        execution,
        tool,
        availableTools,
        arguments: args,
        context,
      }, {
        defaultTimeoutMs: options.toolExecutionTimeoutMs ??
          DEFAULT_TOOL_TIMEOUT_MS,
        timeoutsMs: options.toolExecutionTimeoutsMs,
      });
      if (outcome.status === "completed") {
        const origin = {
          scope: { type: "thread" as const, id: recordThreadId(execution) },
          producer: { type: "tool_execution", id: execution.id },
        };
        const prepared = await context.content.prepare(
          valueContent(outcome.output, "tool.output"),
          { operationKey: "tool:output", origin },
        );
        const explicitAttachments = outcome.attachments
          ? await context.content.prepare(outcome.attachments, {
            operationKey: "tool:attachments",
            origin,
          })
          : undefined;
        const attachments = mergePreparedContent(
          outcome.extractedAttachments,
          explicitAttachments,
        );
        await completeToolExecutionRecord(context, execution, {
          output: prepared,
          projectedOutput: prepared,
          ...(attachments ? { attachments } : {}),
          historyVisibility: historyVisibilityOf(execution),
          durationMs: outcome.durationMs,
        }, { operationKey: "tool:complete", metadata: asRecord(execution.metadata) });
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
        await cancelToolExecutionRecord(context, execution, {
          reason: outcome.reason,
          errorDetail: detail,
          projectedOutput: projection,
          historyVisibility: historyVisibilityOf(execution),
          durationMs: outcome.durationMs,
        }, { operationKey: "tool:cancel", metadata: asRecord(execution.metadata) });
        return;
      }
      await failToolExecutionRecord(context, execution, {
        safeError: safeError(
          outcome.code,
          "Tool execution failed.",
          outcome.error,
        ),
        errorDetail: detail,
        projectedOutput: projection,
        historyVisibility: historyVisibilityOf(execution),
        durationMs: outcome.durationMs,
      }, { operationKey: "tool:fail", metadata: asRecord(execution.metadata) });
    },
  });

function resultVisibility(execution: CollectionRecord): EventVisibility {
  const historyVisibility = optionalText(execution.historyVisibility);
  const policy = historyVisibility === "requester_only" ||
      historyVisibility === "public"
    ? historyVisibility
    : "public_status";
  const participantId = optionalText(execution.participantId);
  return participantId
    ? { kind: "tool" as const, policy, requesterId: participantId }
    : { kind: "internal" as const };
}

async function resultContent(
  context: CopilotzProcessorContext,
  execution: CollectionRecord,
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
  const safeError = asRecord(execution.safeError);
  return await context.content.prepare({
    type: "text",
    text: String(execution.status) === "failed"
      ? optionalText(safeError.message) ?? "Tool execution failed."
      : "No output returned",
    role: "tool.projected_output",
  }, { operationKey: "project:tool-result:fallback" });
}

async function executionOutput(
  context: CopilotzProcessorContext,
  execution: CollectionRecord,
): Promise<unknown> {
  const content = toolExecutionContent(execution);
  const selected = content.projectedOutput ?? content.output;
  return selected
    ? resolvedValue(await context.content.resolve(selected))
    : undefined;
}

export const projectToolResultProcessor: Processor<CopilotzProcessorContext> =
  defineProcessor<CopilotzProcessorContext>({
    id: "copilotz.core.project-tool-result",
    on: [
      {
        eventType: "tool_execution.updated",
        data: { record: { status: "completed" } },
      },
      {
        eventType: "tool_execution.updated",
        data: { record: { status: "failed" } },
      },
      {
        eventType: "tool_execution.updated",
        data: { record: { status: "cancelled" } },
      },
    ],
    async handle(event, context) {
      const record = collectionEventRecord(event);
      let execution = record;
      if (String(execution.status) === "running") return;
      let metadata = workflowMetadata(execution.metadata);
      if (metadata?.kind === "memory_consolidation") return;
      const agent = optionalText(execution.agentId)
        ? context.resources.get<Agent>(
          "agents",
          optionalText(execution.agentId)!,
        )
        : undefined;
      const toolCatalog = toolCatalogFor(context, agent);
      const evaluateJq = jqFor(context, agent);
      let projectedStatus = String(execution.status);
      let projectedContent: ContentSequence | PreparedContent | undefined;

      if (
        metadata?.pipeline && String(execution.status) === "completed" &&
        metadata.pipeline.stageIndex < metadata.pipeline.stages.length - 1
      ) {
        const advancement = await advanceWorkflowPipeline({
          pipeline: metadata.pipeline,
          output: await executionOutput(context, execution),
          upstreamToolExecutionId: execution.id,
          evaluateJq,
        });
        if (advancement.kind === "next_tool") {
          let availableTools = agent
            ? await toolCatalog.forAgent(context.resources, agent)
            : await toolCatalog.all(context.resources);
          const attemptId = metadata.parentLlmAttemptId ??
            metadata.llmAttemptId;
          if (attemptId) {
            const attemptRecord = await requireCollection(context, "llm_attempt")
              .get(attemptId, context.namespace);
            if (attemptRecord) {
              const attempt = attemptRecord;
              const granted = new Set(stringArray(attempt.availableToolIds));
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
          await createToolExecutionRecord(context, {
            id: await deriveWorkflowId(
              "tool",
              parentAttemptId,
              "pipeline",
              advancement.pipeline.id,
              String(advancement.stageIndex),
            ),
            threadId: recordThreadId(execution),
            messageId: optionalText(execution.messageId),
            participantId: optionalText(execution.participantId),
            agentId: optionalText(execution.agentId),
            toolCallId: advancement.stage.id,
            tool: {
              id: advancement.stage.tool.id,
              name: nextTool?.name ?? advancement.stage.tool.name ??
                advancement.stage.tool.id,
            },
            arguments: preparedArguments,
            status: "running",
            historyVisibility: nextTool?.historyPolicy?.visibility ??
              historyVisibilityOf(execution),
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
          const updated = await patchToolExecutionRecord(context, execution, {
            projectedOutput: projectedContent,
          }, {
            operationKey:
              `pipeline:${metadata.pipeline.id}:persist-final-projection`,
          });
          if (updated) execution = updated;
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
          const updated = await patchToolExecutionRecord(context, execution, {
            projectedOutput: projectedContent,
            metadataPatch: withWorkflowMetadata(undefined, failedWorkflow),
          }, {
            operationKey: `pipeline:${metadata.pipeline.id}:persist-failure`,
          });
          if (updated) execution = updated;
          metadata = failedWorkflow;
        }
      }

      const recipientId = optionalText(execution.participantId) ??
        metadata?.agentParticipantId;
      if (!recipientId) {
        throw new Error(`Tool execution '${execution.id}' has no requester.`);
      }
      const toolId = requiredText(
        typeof toolField(execution, "id") === "string"
          ? toolField(execution, "id") as string
          : undefined,
        "Tool execution tool id",
      );
      const activeAsk = agentAskMetadata(execution.metadata);
      const resultBaseMetadata = activeAsk
        ? withAgentAskMetadata({
          historyVisibility: historyVisibilityOf(execution),
          requesterId: recipientId,
          toolStatus: projectedStatus,
          toolId,
        }, activeAsk)
        : {
          historyVisibility: historyVisibilityOf(execution),
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
        toolCallId: metadata?.pipeline?.rootToolCallId ??
          optionalText(execution.toolCallId),
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
      await createThreadMessage(context, {
        id: await deriveWorkflowId("message", execution.id, "result"),
        threadId: recordThreadId(execution),
        sender: {
          externalId: `tool:${toolId}`,
          participantType: "tool",
          name: typeof toolField(execution, "name") === "string"
            ? toolField(execution, "name") as string
            : toolId,
        },
        recipientIds: [recipientId],
        content: await resultContent(context, execution, projectedContent),
        visibility: resultVisibility(execution),
        metadata: messageMetadata,
      }, {
        operationKey: `project:tool-result:message:${execution.id}`,
        metadata: messageMetadata,
      });
    },
  });
