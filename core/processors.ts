import type { DurableEvent, EphemeralEvent } from "@/events/types.ts";
import { defineProcessor, type Processor } from "@/processors/types.ts";
import type {
  Agent,
  BackgroundThreadInput,
  BackgroundThreadResult,
  LlmAttemptRecord,
  MessageRecord,
  ParticipantRecord,
  Tool,
  ToolExecutionContext,
  ToolExecutionRecord,
  ToolInvocationInput,
} from "@/types/resources.ts";
import type {
  ChatContentPart,
  ChatMessage,
  LLMRuntimeConfig,
} from "@/runtime/llm/types.ts";
import { chat } from "@/runtime/llm/orchestrator.ts";
import { formatToolsForPrompt } from "@/runtime/tools/format-tools-for-prompt.ts";
import { prepareAgentChatRequest } from "@/runtime/llm/agent-request.ts";
import { type CoreServicesRef, requireCoreServices } from "./services.ts";

interface ActiveAsk {
  id: string;
  executionId: string;
  batchId: string;
  callerAgentId: string;
  targetAgentId: string;
  resumeRuntime?: "realtime";
  realtimeStreamId?: string;
  parent?: ActiveAsk;
}

function recordOf<T>(event: DurableEvent): T {
  const payload = event.payload as Record<string, unknown>;
  return (payload.record ?? payload) as T;
}

function objectOf(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function parseArgs(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      return objectOf(JSON.parse(value));
    } catch {
      return {};
    }
  }
  return objectOf(value);
}

function resolveAgent(agents: readonly Agent[], id: string): Agent | undefined {
  const normalized = id.toLowerCase();
  return agents.find((agent) =>
    agent.id.toLowerCase() === normalized ||
    agent.name.toLowerCase() === normalized
  );
}

async function ensureAgentParticipant(
  ref: CoreServicesRef,
  namespace: string,
  threadId: string,
  agent: Agent,
  event: DurableEvent,
  dedupeSuffix: string,
): Promise<ParticipantRecord> {
  const services = requireCoreServices(ref);
  const participant = await services.domain.ensureParticipant(
    namespace,
    {
      externalId: agent.id,
      participantType: "agent",
      name: agent.name,
      agentId: agent.id,
    },
    {
      causationId: event.id,
      correlationId: event.correlationId,
      deduplicationId: `${event.id}:participant:${agent.id}:${dedupeSuffix}`,
    },
  );
  await services.domain.addParticipant(namespace, threadId, participant.id, {
    causationId: event.id,
    correlationId: event.correlationId,
    deduplicationId: `${event.id}:membership:${agent.id}:${dedupeSuffix}`,
  });
  return participant;
}

function activeAskOf(value: unknown): ActiveAsk | undefined {
  const candidate = objectOf(value);
  return typeof candidate.id === "string" &&
      typeof candidate.executionId === "string" &&
      typeof candidate.batchId === "string" &&
      typeof candidate.callerAgentId === "string" &&
      typeof candidate.targetAgentId === "string"
    ? candidate as unknown as ActiveAsk
    : undefined;
}

async function createAttemptForAgent(options: {
  ref: CoreServicesRef;
  event: DurableEvent;
  message: MessageRecord;
  agent: Agent;
  deduplicationId: string;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  const services = requireCoreServices(options.ref);
  await ensureAgentParticipant(
    options.ref,
    options.event.namespace,
    options.message.threadId,
    options.agent,
    options.event,
    options.deduplicationId,
  );
  await services.domain.createLlmAttempt({
    namespace: options.event.namespace,
    threadId: options.message.threadId,
    messageId: options.message.id,
    agentId: options.agent.id,
    agentName: options.agent.name,
    metadata: options.metadata,
    context: {
      causationId: options.event.id,
      correlationId: options.event.correlationId,
      deduplicationId: options.deduplicationId,
      metadata: { sourceDeliveryId: options.event.metadata.sourceDeliveryId },
    },
  });
}

function createMessageRouter(ref: CoreServicesRef): Processor {
  return defineProcessor({
    id: "message.router",
    on: ["message.created"],
    delivery: "durable",
    handle: async (event, context) => {
      const services = requireCoreServices(ref);
      const message = recordOf<MessageRecord>(event);
      const metadata = objectOf(message.metadata);
      const agents = services.registry.list("agents");

      if (message.senderType === "agent" && message.toolCalls?.length) {
        const calls = message.toolCalls as readonly ToolInvocationInput[];
        const batchId = `${message.id}:tools`;
        const activeAsk = activeAskOf(metadata.activeAsk);
        const resumeRuntime = metadata.runtime === "realtime"
          ? "realtime" as const
          : undefined;
        const realtimeStreamId = typeof metadata.realtimeStreamId === "string"
          ? metadata.realtimeStreamId
          : undefined;
        await Promise.all(calls.map(async (call, index) => {
          await services.domain.createToolExecution({
            namespace: event.namespace,
            threadId: message.threadId,
            messageId: message.id,
            agentId: String(
              metadata.agentId ?? metadata.senderExternalId ?? message.senderId,
            ),
            agentName: String(
              metadata.agentName ?? metadata.senderDisplayName ??
                message.senderId,
            ),
            call,
            batchId,
            batchSize: calls.length,
            batchIndex: index,
            metadata: {
              ...(activeAsk ? { activeAsk } : {}),
              ...(resumeRuntime ? { resumeRuntime } : {}),
              ...(realtimeStreamId ? { realtimeStreamId } : {}),
            },
            context: {
              causationId: event.id,
              correlationId: event.correlationId,
              deduplicationId: `${context.idempotencyKey}:tool:${
                call.id ?? index
              }`,
            },
          });
        }));
        return;
      }

      if (message.senderType === "agent") {
        const activeAsk = activeAskOf(metadata.activeAsk);
        if (!activeAsk) {
          const recipientId = event.routing.recipientIds?.[0] ??
            message.targetId ?? undefined;
          if (!recipientId) return;
          let target = resolveAgent(agents, recipientId);
          if (!target) {
            const participant = await services.domain.findParticipant(
              event.namespace,
              recipientId,
            );
            const targetId = participant?.agentId ?? participant?.externalId;
            if (targetId) target = resolveAgent(agents, targetId);
          }
          const senderAgentId = typeof metadata.agentId === "string"
            ? metadata.agentId
            : undefined;
          if (!target || target.id === senderAgentId) return;
          await createAttemptForAgent({
            ref,
            event,
            message,
            agent: target,
            deduplicationId: `${context.idempotencyKey}:routed:${target.id}`,
          });
          return;
        }
        const askMetadata = objectOf(metadata.ask);
        if (askMetadata.phase === "request") {
          const target = resolveAgent(agents, activeAsk.targetAgentId);
          if (!target) {
            throw new Error(
              `Unknown asked agent '${activeAsk.targetAgentId}'.`,
            );
          }
          await createAttemptForAgent({
            ref,
            event,
            message,
            agent: target,
            deduplicationId: `${activeAsk.id}:answer:${target.id}`,
            metadata: { activeAsk },
          });
          return;
        }
        await services.domain.updateToolExecution(
          event.namespace,
          activeAsk.executionId,
          "completed",
          {
            status: "completed",
            output: { answerMessageId: message.id },
            finishedAt: new Date().toISOString(),
          },
          {
            causationId: event.id,
            correlationId: event.correlationId,
            deduplicationId: `${context.idempotencyKey}:ask-completed`,
          },
        );
        const batch = await services.domain.listNodes<ToolExecutionRecord>(
          event.namespace,
          "tool_execution",
          (execution) => execution.batchId === activeAsk.batchId,
        );
        if (
          !batch.length ||
          batch.some((execution) =>
            !["completed", "failed", "cancelled"].includes(execution.status)
          )
        ) return;
        if (activeAsk.resumeRuntime === "realtime") return;
        const caller = resolveAgent(agents, activeAsk.callerAgentId);
        if (!caller) {
          throw new Error(`Unknown asking agent '${activeAsk.callerAgentId}'.`);
        }
        await createAttemptForAgent({
          ref,
          event,
          message,
          agent: caller,
          deduplicationId: `${activeAsk.batchId}:resume`,
          metadata: activeAsk.parent ? { activeAsk: activeAsk.parent } : {},
        });
        return;
      }

      if (message.senderType === "tool") {
        const batchId = typeof metadata.batchId === "string"
          ? metadata.batchId
          : undefined;
        const requesterAgentId = typeof metadata.requesterAgentId === "string"
          ? metadata.requesterAgentId
          : undefined;
        if (!batchId || !requesterAgentId) return;
        const batch = await services.domain.listNodes<ToolExecutionRecord>(
          event.namespace,
          "tool_execution",
          (execution) => execution.batchId === batchId,
        );
        if (
          !batch.length ||
          batch.some((execution) =>
            !["completed", "failed", "cancelled"].includes(execution.status)
          )
        ) return;
        if (metadata.resumeRuntime === "realtime") return;
        const requester = resolveAgent(agents, requesterAgentId);
        if (!requester) {
          throw new Error(`Unknown requesting agent '${requesterAgentId}'.`);
        }
        const parentAsk = activeAskOf(metadata.activeAsk);
        await createAttemptForAgent({
          ref,
          event,
          message,
          agent: requester,
          deduplicationId: `${batchId}:resume`,
          metadata: parentAsk ? { activeAsk: parentAsk } : {},
        });
        return;
      }

      const recipientId = event.routing.recipientIds?.[0] ?? message.targetId ??
        undefined;
      let agent = recipientId ? resolveAgent(agents, recipientId) : agents[0];
      if (!agent && recipientId) {
        const participant = await services.domain.findParticipant(
          event.namespace,
          recipientId,
        );
        const agentId = participant?.agentId ?? participant?.externalId;
        if (agentId) agent = resolveAgent(agents, agentId);
      }
      if (!agent) throw new Error("No agent is available for this message.");
      await createAttemptForAgent({
        ref,
        event,
        message,
        agent,
        deduplicationId: `${context.idempotencyKey}:llm:${agent.id}`,
      });
    },
  });
}

function textOf(message: MessageRecord): ChatMessage["content"] {
  if (typeof message.content === "string") return message.content;
  if (message.content) return [...message.content] as ChatContentPart[];
  return "";
}

function historyForAgent(
  messages: readonly MessageRecord[],
  agent: Agent,
): ChatMessage[] {
  const history: ChatMessage[] = [];
  for (const message of messages) {
    const metadata = objectOf(message.metadata);
    const visibility = metadata.historyVisibility;
    if (
      message.senderType === "tool" && visibility === "requester_only" &&
      metadata.requesterAgentId !== agent.id
    ) continue;
    const senderLabel = String(
      metadata.senderDisplayName ?? metadata.senderExternalId ??
        message.senderId,
    );
    if (message.senderType === "agent" && metadata.agentId === agent.id) {
      const toolCalls = message.toolCalls?.filter((call) =>
        call.tool.id !== "ask"
      );
      const content = textOf(message);
      if (
        message.toolCalls?.length && !toolCalls?.length &&
        (typeof content !== "string" || content.trim().length === 0)
      ) {
        continue;
      }
      history.push({
        role: "assistant",
        content,
        senderId: message.senderId,
        ...(toolCalls?.length ? { toolCalls: toolCalls as never } : {}),
        reasoning: message.reasoning ?? undefined,
      });
    } else if (message.senderType === "tool") {
      history.push({
        role: "tool_result",
        content: textOf(message),
        senderId: message.senderId,
        tool_call_id: typeof metadata.toolCallId === "string"
          ? metadata.toolCallId
          : undefined,
      });
    } else {
      const content = textOf(message);
      history.push({
        role: "user",
        content: typeof content === "string" && message.senderType === "agent"
          ? `[${senderLabel}] ${content}`
          : content,
        senderId: message.senderId,
      });
    }
  }
  return history;
}

function systemPrompt(agent: Agent): string {
  return [
    `You are ${agent.name}.`,
    agent.role,
    agent.personality,
    agent.instructions,
  ].filter((value): value is string =>
    typeof value === "string" && value.trim().length > 0
  )
    .join("\n\n");
}

function allowedTools(agent: Agent, tools: readonly Tool[]): Tool[] {
  const allowed = agent.allowedTools;
  if (allowed === null) return [];
  const selected = allowed === undefined
    ? [...tools]
    : tools.filter((tool) =>
      allowed.includes(tool.key) || allowed.includes(tool.id)
    );
  const canAsk = agent.allowedAgents === undefined ||
    (Array.isArray(agent.allowedAgents) && agent.allowedAgents.length > 0);
  return canAsk
    ? selected
    : selected.filter((tool) =>
      tool.key !== "ask" && tool.key !== "create_thread"
    );
}

async function resolveLlmConfig(
  agent: Agent,
  event: DurableEvent,
  messages: ChatMessage[],
  tools: ReturnType<typeof formatToolsForPrompt>,
): Promise<LLMRuntimeConfig> {
  const shorthand = typeof agent.llmOptions === "function"
    ? await agent.llmOptions({ event, messages, tools })
    : agent.llmOptions ?? {};
  const runtime = agent.runtimes?.text;
  return {
    ...shorthand,
    ...(runtime?.options ?? {}),
    provider:
      (runtime?.provider ?? shorthand.provider) as LLMRuntimeConfig["provider"],
    model: runtime?.model ?? shorthand.model,
    stream: true,
  };
}

function createLlmProcessor(ref: CoreServicesRef): Processor {
  return defineProcessor({
    id: "llm.execute",
    on: ["llm_attempt.created"],
    delivery: "durable",
    handle: async (event, context) => {
      const services = requireCoreServices(ref);
      const attempt = recordOf<LlmAttemptRecord>(event);
      const agent = resolveAgent(
        services.registry.list("agents"),
        attempt.agentId,
      );
      if (!agent) throw new Error(`Unknown agent '${attempt.agentId}'.`);
      const agentParticipant = await ensureAgentParticipant(
        ref,
        event.namespace,
        attempt.threadId,
        agent,
        event,
        context.idempotencyKey,
      );
      const messages = await services.domain.listMessages(
        event.namespace,
        attempt.threadId,
      );
      const thread = await services.domain.findThread(
        event.namespace,
        attempt.threadId,
      );
      if (!thread) throw new Error(`Unknown thread '${attempt.threadId}'.`);
      const tools = allowedTools(agent, services.registry.list("tools"));
      const toolDefinitions = formatToolsForPrompt(tools);
      const memory = services.registry.list("memory").filter((resource) =>
        resource.enabled !== false
      );
      const history = memory.some((resource) => resource.kind === "history")
        ? historyForAgent(messages, agent)
        : [];
      const memoryMessages: ChatMessage[] = [];
      for (const resource of memory) {
        if (!resource.prepare) continue;
        memoryMessages.push(
          ...await resource.prepare({
            event,
            agent,
            thread,
            messages,
            history,
            collections: context.collections,
            signal: context.signal,
          }),
        );
      }
      const prepared = prepareAgentChatRequest({
        messages: [
          { role: "system", content: systemPrompt(agent) },
          ...memoryMessages,
          ...history,
        ],
        tools: toolDefinitions,
        agent,
        assetStore: services.assetStore,
      });
      const config = await resolveLlmConfig(
        agent,
        event,
        prepared.request.messages,
        toolDefinitions,
      );
      if (!config.provider) {
        throw new Error(`Agent '${agent.id}' has no text runtime provider.`);
      }
      await services.domain.updateLlmAttempt(
        event.namespace,
        attempt.id,
        "started",
        {
          status: "processing",
          provider: config.provider,
          model: config.model ?? null,
          messages: prepared.request.messages,
          tools: toolDefinitions,
          startedAt: new Date().toISOString(),
        },
        {
          causationId: event.id,
          correlationId: event.correlationId,
          deduplicationId: `${context.idempotencyKey}:started`,
        },
      );

      let sequence = 0;
      try {
        const providerRegistry = Object.fromEntries(
          services.registry.list("providers")
            .filter((provider) => provider.kind === "text")
            .map((provider) => [provider.id, provider.create]),
        );
        const response = await chat(
          { ...prepared.request, signal: context.signal },
          config,
          {},
          (chunk, options) => {
            const emitted: EphemeralEvent = {
              durable: false,
              type: options?.isReasoning ? "reasoning.delta" : "text.delta",
              namespace: event.namespace,
              threadId: attempt.threadId,
              payload: {
                text: chunk,
                participant: {
                  id: agentParticipant.id,
                  agentId: agent.id,
                  name: agent.name,
                },
                llmAttemptId: attempt.id,
              },
              routing: { senderId: agentParticipant.id },
              visibility: options?.isReasoning
                ? {
                  kind: "participants",
                  participantIds: [agentParticipant.id],
                }
                : { kind: "public" },
              metadata: {},
              causationId: event.id,
              correlationId: event.correlationId,
              streamId: attempt.id,
              sequence: sequence++,
              createdAt: new Date().toISOString(),
            };
            context.emit(emitted);
          },
          providerRegistry,
        );
        await services.domain.updateLlmAttempt(
          event.namespace,
          attempt.id,
          "completed",
          {
            status: "completed",
            provider: response.provider ?? config.provider,
            model: response.model ?? config.model ?? null,
            answer: response.answer,
            reasoning: response.reasoning ?? null,
            toolCalls: response.toolCalls ?? null,
            usage: response.usage ?? null,
            cost: response.cost ?? null,
            finishReason: response.finishReason ?? null,
            finishedAt: new Date().toISOString(),
          },
          {
            causationId: event.id,
            correlationId: event.correlationId,
            deduplicationId: `${context.idempotencyKey}:completed`,
          },
        );
        const attemptMetadata = objectOf(attempt.metadata);
        await services.domain.createMessage({
          namespace: event.namespace,
          thread,
          participant: agentParticipant,
          input: {
            content: response.answer,
            reasoning: response.reasoning ?? null,
            toolCalls: response.toolCalls?.map((call) => ({
              id: call.id,
              tool: call.tool,
              args: call.args,
              status: call.status,
            })) ?? null,
            sender: { id: agent.id, type: "agent", name: agent.name },
            metadata: {
              agentId: agent.id,
              agentName: agent.name,
              runtime: "text",
              ...(attemptMetadata.activeAsk
                ? { activeAsk: attemptMetadata.activeAsk }
                : {}),
              llmAttemptId: attempt.id,
            },
          },
          correlationId: event.correlationId,
          context: {
            causationId: event.id,
            correlationId: event.correlationId,
            deduplicationId: `${context.idempotencyKey}:message`,
          },
        });
      } catch (error) {
        await services.domain.updateLlmAttempt(
          event.namespace,
          attempt.id,
          context.signal.aborted ? "cancelled" : "failed",
          {
            status: context.signal.aborted ? "cancelled" : "failed",
            error: error instanceof Error
              ? { name: error.name, message: error.message }
              : { name: "Error", message: String(error) },
            finishedAt: new Date().toISOString(),
          },
          {
            causationId: event.id,
            correlationId: event.correlationId,
            deduplicationId: `${context.idempotencyKey}:failed`,
          },
        );
        if (context.signal.aborted) throw error;
      }
    },
  });
}

function combineSignals(parent: AbortSignal, timeoutMs?: number): {
  signal: AbortSignal;
  close(): void;
} {
  const controller = new AbortController();
  const abort = () => controller.abort(parent.reason);
  parent.addEventListener("abort", abort, { once: true });
  const timer = timeoutMs === undefined ? undefined : setTimeout(
    () =>
      controller.abort(
        new DOMException("Tool execution timed out", "TimeoutError"),
      ),
    timeoutMs,
  );
  return {
    signal: controller.signal,
    close() {
      parent.removeEventListener("abort", abort);
      if (timer) clearTimeout(timer);
    },
  };
}

async function createBackgroundThread(options: {
  ref: CoreServicesRef;
  event: DurableEvent;
  execution: ToolExecutionRecord;
  requester: ParticipantRecord;
  caller: Agent;
  input: BackgroundThreadInput;
  sequence: number;
  deliveryId: string;
}): Promise<BackgroundThreadResult> {
  const services = requireCoreServices(options.ref);
  const name = options.input.name.trim();
  if (!name) throw new TypeError("Background thread name is required.");
  const requested = [...new Set(options.input.participants)];
  if (!requested.length) {
    throw new TypeError("A background thread needs at least one agent.");
  }
  const agents = requested.map((candidate) => {
    const target = resolveAgent(services.registry.list("agents"), candidate);
    if (!target) throw new Error(`Unknown background agent '${candidate}'.`);
    if (
      target.id !== options.caller.id &&
      Array.isArray(options.caller.allowedAgents) &&
      !options.caller.allowedAgents.includes(target.id) &&
      !options.caller.allowedAgents.includes(target.name)
    ) {
      throw new Error(
        `Agent '${options.caller.id}' may not start work with '${target.id}'.`,
      );
    }
    return target;
  }).filter((agent, index, all) =>
    all.findIndex((candidate) => candidate.id === agent.id) === index
  );
  const base = `${options.execution.id}:background:${options.sequence}`;
  const correlationId = base;
  const mutationMetadata = { sourceDeliveryId: options.deliveryId };
  const mutationContext = (suffix: string) => ({
    causationId: options.event.id,
    correlationId,
    deduplicationId: `${base}:${suffix}`,
    metadata: mutationMetadata,
  });
  const thread = await services.domain.ensureThread(
    options.event.namespace,
    {
      id: base,
      externalId: base,
      name,
      parentThreadId: options.execution.threadId,
      metadata: {
        ...(options.input.metadata ?? {}),
        background: true,
        createdByAgentId: options.caller.id,
        ...(options.input.description
          ? { description: options.input.description }
          : {}),
      },
    },
    mutationContext("thread"),
  );
  await services.domain.addParticipant(
    options.event.namespace,
    thread.id,
    options.requester.id,
    mutationContext("requester-membership"),
  );

  const participants: ParticipantRecord[] = [];
  for (const agent of agents) {
    const participant = await services.domain.ensureParticipant(
      options.event.namespace,
      {
        externalId: agent.id,
        participantType: "agent",
        name: agent.name,
        agentId: agent.id,
      },
      mutationContext(`participant:${agent.id}`),
    );
    await services.domain.addParticipant(
      options.event.namespace,
      thread.id,
      participant.id,
      mutationContext(`membership:${agent.id}`),
    );
    participants.push(participant);
  }

  let initialEventId: string | undefined;
  if (options.input.initialMessage?.trim()) {
    const result = await services.domain.createMessage({
      namespace: options.event.namespace,
      thread,
      participant: options.requester,
      target: participants[0],
      input: {
        content: options.input.initialMessage,
        sender: {
          id: options.caller.id,
          type: "agent",
          name: options.caller.name,
        },
        target: participants[0].id,
        metadata: {
          backgroundThread: true,
          parentThreadId: options.execution.threadId,
          agentId: options.caller.id,
          agentName: options.caller.name,
        },
      },
      correlationId,
      context: mutationContext("initial-message"),
    });
    initialEventId = result.event.id;
  }

  return {
    threadId: thread.id,
    parentThreadId: options.execution.threadId,
    correlationId,
    participantIds: participants.map((participant) => participant.id),
    ...(initialEventId ? { initialEventId } : {}),
    status: "started",
  };
}

function createToolProcessor(ref: CoreServicesRef): Processor {
  return defineProcessor({
    id: "tool.execute",
    on: ["tool_execution.created"],
    delivery: "durable",
    handle: async (event, context) => {
      const services = requireCoreServices(ref);
      const execution = recordOf<ToolExecutionRecord>(event);
      const agent = resolveAgent(
        services.registry.list("agents"),
        execution.agentId,
      );
      if (!agent) {
        throw new Error(`Unknown tool-calling agent '${execution.agentId}'.`);
      }
      const requester = await ensureAgentParticipant(
        ref,
        event.namespace,
        execution.threadId,
        agent,
        event,
        context.idempotencyKey,
      );
      await services.domain.updateToolExecution(
        event.namespace,
        execution.id,
        "started",
        { status: "processing", startedAt: new Date().toISOString() },
        {
          causationId: event.id,
          correlationId: event.correlationId,
          deduplicationId: `${context.idempotencyKey}:started`,
        },
      );

      if (execution.tool.id === "ask") {
        const args = parseArgs(execution.args);
        const targetName = typeof args.agent === "string" ? args.agent : "";
        const question = typeof args.message === "string" ? args.message : "";
        const target = resolveAgent(
          services.registry.list("agents"),
          targetName,
        );
        if (!target || !question.trim()) {
          throw new TypeError("ask requires a valid agent and message.");
        }
        if (
          Array.isArray(agent.allowedAgents) &&
          !agent.allowedAgents.includes(target.id) &&
          !agent.allowedAgents.includes(target.name)
        ) {
          throw new Error(`Agent '${agent.id}' may not ask '${target.id}'.`);
        }
        const targetParticipant = await ensureAgentParticipant(
          ref,
          event.namespace,
          execution.threadId,
          target,
          event,
          `${context.idempotencyKey}:target`,
        );
        const executionMetadata = objectOf(execution.metadata);
        const activeAsk: ActiveAsk = {
          id: execution.toolCallId,
          executionId: execution.id,
          batchId: String(execution.batchId),
          callerAgentId: agent.id,
          targetAgentId: target.id,
          ...(executionMetadata.resumeRuntime === "realtime"
            ? { resumeRuntime: "realtime" as const }
            : {}),
          ...(typeof executionMetadata.realtimeStreamId === "string"
            ? { realtimeStreamId: executionMetadata.realtimeStreamId }
            : {}),
          ...(activeAskOf(executionMetadata.activeAsk)
            ? { parent: activeAskOf(executionMetadata.activeAsk) }
            : {}),
        };
        await services.domain.createMessage({
          namespace: event.namespace,
          thread: (await services.domain.findThread(
            event.namespace,
            execution.threadId,
          ))!,
          participant: requester,
          target: targetParticipant,
          input: {
            content: question,
            sender: { id: agent.id, type: "agent", name: agent.name },
            target: target.id,
            metadata: {
              agentId: agent.id,
              agentName: agent.name,
              activeAsk,
              ask: { id: activeAsk.id, phase: "request" },
            },
          },
          correlationId: event.correlationId,
          context: {
            causationId: event.id,
            correlationId: event.correlationId,
            deduplicationId: `${context.idempotencyKey}:ask-message`,
          },
        });
        await services.domain.updateToolExecution(
          event.namespace,
          execution.id,
          "waiting",
          { status: "waiting", ask: activeAsk },
          {
            causationId: event.id,
            correlationId: event.correlationId,
            deduplicationId: `${context.idempotencyKey}:waiting`,
          },
        );
        return;
      }

      const tool = services.registry.get("tools", execution.tool.id);
      if (!tool?.execute) {
        throw new Error(`Unknown executable tool '${execution.tool.id}'.`);
      }
      const timeout = services.toolExecutionTimeoutsMs &&
          execution.tool.id in services.toolExecutionTimeoutsMs
        ? services.toolExecutionTimeoutsMs[execution.tool.id]
        : services.toolExecutionTimeoutMs;
      const signals = combineSignals(context.signal, timeout);
      let backgroundThreadSequence = 0;
      const toolContext: ToolExecutionContext = {
        idempotencyKey: context.idempotencyKey,
        deliveryId: context.delivery!.id,
        event,
        threadId: execution.threadId,
        namespace: event.namespace,
        agent,
        agents: services.registry.list("agents"),
        tools: services.registry.list("tools"),
        collections: context.collections,
        assets: services.assets.scoped({
          namespace: event.namespace,
          threadId: execution.threadId,
          by: `tool:${execution.tool.id}`,
          toolCallId: execution.toolCallId,
          causationId: event.id,
          correlationId: event.correlationId,
          idempotencyKey: `${context.idempotencyKey}:asset`,
          metadata: { sourceDeliveryId: context.delivery!.id },
        }),
        createThread: (input) =>
          createBackgroundThread({
            ref,
            event,
            execution,
            requester,
            caller: agent,
            input,
            sequence: backgroundThreadSequence++,
            deliveryId: context.delivery!.id,
          }),
        signal: signals.signal,
        cancelled: signals.signal.aborted,
        cancelReason: signals.signal.aborted
          ? String(signals.signal.reason)
          : undefined,
      };
      const policy = tool.historyPolicy?.visibility ?? "requester_only";
      let output: unknown;
      let failure: unknown;
      try {
        output = await tool.execute(parseArgs(execution.args), toolContext);
      } catch (error) {
        failure = error;
      } finally {
        signals.close();
      }
      const operation = failure ? "failed" : "completed";
      await services.domain.updateToolExecution(
        event.namespace,
        execution.id,
        operation,
        {
          status: operation,
          ...(failure
            ? {
              error: failure instanceof Error
                ? { name: failure.name, message: failure.message }
                : { name: "Error", message: String(failure) },
            }
            : { output }),
          historyVisibility: policy,
          finishedAt: new Date().toISOString(),
        },
        {
          causationId: event.id,
          correlationId: event.correlationId,
          deduplicationId: `${context.idempotencyKey}:terminal`,
        },
      );
      const toolParticipant = await services.domain.ensureParticipant(
        event.namespace,
        {
          externalId: `tool:${tool.key}`,
          participantType: "job",
          name: tool.name,
          metadata: { toolId: tool.id },
        },
        {
          causationId: event.id,
          correlationId: event.correlationId,
          deduplicationId: `${context.idempotencyKey}:tool-participant`,
        },
      );
      await services.domain.addParticipant(
        event.namespace,
        execution.threadId,
        toolParticipant.id,
        {
          causationId: event.id,
          correlationId: event.correlationId,
          deduplicationId: `${context.idempotencyKey}:tool-membership`,
        },
      );
      const executionMetadata = objectOf(execution.metadata);
      await services.domain.createMessage({
        namespace: event.namespace,
        thread: (await services.domain.findThread(
          event.namespace,
          execution.threadId,
        ))!,
        participant: toolParticipant,
        target: requester,
        input: {
          content: failure
            ? `Tool ${tool.name} failed: ${
              failure instanceof Error ? failure.message : String(failure)
            }`
            : JSON.stringify(output ?? null),
          sender: { id: tool.id, type: "tool", name: tool.name },
          metadata: {
            toolCallId: execution.toolCallId,
            toolExecutionId: execution.id,
            requesterAgentId: agent.id,
            batchId: execution.batchId,
            batchSize: execution.batchSize,
            batchIndex: execution.batchIndex,
            historyVisibility: policy,
            ...(executionMetadata.activeAsk
              ? { activeAsk: executionMetadata.activeAsk }
              : {}),
            ...(executionMetadata.resumeRuntime === "realtime"
              ? { resumeRuntime: "realtime" }
              : {}),
            ...(typeof executionMetadata.realtimeStreamId === "string"
              ? { realtimeStreamId: executionMetadata.realtimeStreamId }
              : {}),
          },
        },
        correlationId: event.correlationId,
        context: {
          causationId: event.id,
          correlationId: event.correlationId,
          deduplicationId: `${context.idempotencyKey}:result-message`,
        },
        visibility: {
          kind: "tool",
          policy,
          requesterId: requester.id,
        },
      });
    },
  });
}

export function createCoreProcessors(
  ref: CoreServicesRef,
): readonly Processor[] {
  return [
    createMessageRouter(ref),
    createLlmProcessor(ref),
    createToolProcessor(ref),
  ];
}
