import { collectContextContributions } from "../../shared/contributions.ts";
import { coreEvent } from "../../shared/events/index.ts";
/** Routes canonical Messages into agent LLM calls. @module */
import {
  ContextInputLimitError,
  isContextInputLimitError,
  preflightLlmRequest,
} from "@copilotz/copilotz/llm";
import { isContentByteLimitError } from "@copilotz/copilotz/content";
import { isSettledActionError } from "@copilotz/copilotz/actions";
import {
  agentAskMetadata,
  CORE_LLM_CALL_METADATA_SCHEMA,
  coreAgentTurnMetadata,
  coreLlmStreamMetadata,
  coreToolActionMessageMetadata,
  coreToolPlanResultMetadata,
  defineCoreLlmCallMetadata,
  workflowMetadata,
} from "../../shared/workflow-metadata.ts";
import { defineProcessor, type Processor } from "@copilotz/copilotz/plugins";
import type {
  CollectionRecord,
  SnapshotCollections,
} from "@copilotz/copilotz/collections";
import { buildCoreLlmRequest } from "./agents/prompt.ts";
import { isContextResource } from "../../authoring/define-context/index.ts";
import type {
  AgentDynamicResolveContext,
  AgentDynamicResolveExecution,
  AgentDynamicResolveOutput,
  AgentModelSelection,
  AgentResource,
} from "../../authoring/define-agent/index.ts";
import { normalizeAgentModels } from "../../authoring/define-agent/index.ts";
import {
  coreAgent,
  type CoreProcessorContext,
} from "../../shared/runtime-context.ts";
import {
  mapMessageRecord,
  mapParticipantRecord,
} from "../../shared/projections.ts";
import type { ConversationThread } from "../../shared/contracts.ts";
import {
  asRecord,
  collectionEventRecord,
  loadCoreThreadMessageSnapshot,
  loadCoreThreadMetadata,
  participantAgentId,
  requiredText,
  stringArray,
  toolsForAgent,
} from "../../shared/helpers.ts";
class SupersededMessageError extends Error {
}
function modelsFor(agent: AgentResource): Readonly<{
  models: AgentModelSelection;
  mode: "generate" | "session";
}> {
  if (agent.models.generate) {
    return ({ models: agent.models.generate, mode: "generate" } as const);
  }
  if (agent.models.session) {
    return ({ models: agent.models.session, mode: "session" } as const);
  }
  throw new Error(`Agent '${agent.id}' requires a generate or session model.`);
}
/** Clones durable facts so a process-local resolver cannot mutate them. */
function frozenFact<T>(value: T): T {
  return freezeFact(structuredClone(value), new WeakSet<object>()) as T;
}
/** Clones static Agent data before handing it to an untrusted resolver. */
function frozenBaseAgent(agent: AgentResource): AgentResource {
  const { dynamicResolve, ...staticAgent } = agent;
  const clone = structuredClone(staticAgent) as AgentResource;
  if (dynamicResolve) {
    Object.defineProperty(clone, "dynamicResolve", {
      configurable: false,
      enumerable: true,
      value: dynamicResolve,
      writable: false,
    });
  }
  return freezeFact(clone, new WeakSet<object>()) as AgentResource;
}
function freezeFact(value: unknown, seen: WeakSet<object>): unknown {
  if (!value || typeof value !== "object" || seen.has(value)) {
    return value;
  }
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor && "value" in descriptor) {
      freezeFact(descriptor.value, seen);
    }
  }
  Object.freeze(value);
  return value;
}
async function resolvedAgent(
  context: CoreProcessorContext,
  agent: AgentResource,
  input: Readonly<{
    agentParticipant: CollectionRecord;
    thread: ConversationThread;
    triggerMessage: CollectionRecord;
    triggerSender: CollectionRecord;
    collections: SnapshotCollections;
  }>,
): Promise<
  Readonly<{
    agent: AgentResource;
    revision?: string;
  }>
> {
  const resolver = agent.dynamicResolve;
  if (!resolver) {
    return ({ agent } as const);
  }
  const facts: AgentDynamicResolveContext = Object.freeze(
    {
      baseAgent: frozenBaseAgent(agent),
      participant: frozenFact(mapParticipantRecord(input.agentParticipant)),
      thread: frozenFact(input.thread),
      triggerMessage: frozenFact(
        mapMessageRecord(
          input.triggerMessage,
          mapParticipantRecord(input.triggerSender),
        ),
      ),
      collections: input.collections,
    } as const,
  );
  const execution: AgentDynamicResolveExecution = Object.freeze(
    {
      agentId: agent.id,
      agentParticipantId: String(input.agentParticipant.id),
      threadId: input.thread.id,
      triggerMessageId: String(input.triggerMessage.id),
      namespace: context.namespace,
      operationKey: context.operationKey,
      ...(context.identity.correlationId
        ? { correlationId: context.identity.correlationId }
        : {}),
      ...(context.identity.causationId
        ? { causationId: context.identity.causationId }
        : {}),
    } as const,
  );
  const resolved = dynamicResolution(
    await resolver(facts, execution),
    agent.id,
  );
  const { dynamicResolve: _dynamicResolve, ...staticAgent } = agent;
  return ({
    agent: {
      ...staticAgent,
      ...(resolved.instructions !== undefined
        ? { instructions: resolved.instructions }
        : {}),
      ...(resolved.models !== undefined ? { models: resolved.models } : {}),
    } as const,
    ...(resolved.revision ? { revision: resolved.revision } : {}),
  } as const);
}
function stableText(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim() || value.trim() !== value) {
    throw new TypeError(`Agent '${label}' resolver returned invalid text.`);
  }
  return value;
}
function dynamicResolution(
  value: unknown,
  agentId: string,
): Readonly<AgentDynamicResolveOutput> {
  if (value === undefined) return ({} as const);
  if (
    !value || typeof value !== "object" || Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    throw new TypeError(
      `Agent '${agentId}' dynamicResolve returned invalid output.`,
    );
  }
  const record = value as Record<string, unknown>;
  if (
    Reflect.ownKeys(record).some((key) =>
      key !== "instructions" && key !== "models" && key !== "revision"
    )
  ) {
    throw new TypeError(
      `Agent '${agentId}' dynamicResolve returned invalid output.`,
    );
  }
  let instructions: string | undefined;
  if (record.instructions !== undefined) {
    instructions = stableText(record.instructions, `${agentId} instructions`);
  }
  const models = record.models === undefined
    ? undefined
    : normalizeAgentModels(record.models, `Agent '${agentId}'`);
  const revision = record.revision === undefined
    ? undefined
    : stableText(record.revision, `${agentId} revision`);
  return ({
    ...(instructions !== undefined ? { instructions } : {}),
    ...(models !== undefined ? { models } : {}),
    ...(revision !== undefined ? { revision } : {}),
  } as const);
}

export const messageRouterProcessor: Processor<CoreProcessorContext> =
  defineProcessor<CoreProcessorContext>({
    id: "copilotz.core.message-to-llm-call",
    on: [{ eventType: "message.created" }],
    async handle(event, context) {
      if (!coreEvent(event).routing?.recipientIds?.length) {
        return;
      }
      if (!event.durable || !coreEvent(event).threadId) {
        return;
      }
      const record = collectionEventRecord(event);
      const workflow = workflowMetadata(asRecord(record.metadata));
      const toolAction = coreToolActionMessageMetadata(record.metadata);
      const branchResult = coreToolPlanResultMetadata(record.metadata);
      const toolCursor = toolAction ?? branchResult?.origin;
      const directTurn = coreAgentTurnMetadata(record.metadata);
      const agentTurn = directTurn ?? toolCursor?.agentTurn;
      if (
        agentTurn && (coreEvent(event).visibility?.kind !== "internal" ||
          asRecord(record.visibility).kind !== "internal" ||
          record.historyScopeId !== agentTurn.id)
      ) {
        throw new Error(
          "Core Agent turn requires a matching internal Message.",
        );
      }
      // A projected Tool result retains an outer ask under its durable cursor;
      // use it when the Message itself is not an ask-question/answer Message.
      const ask = agentAskMetadata(asRecord(record.metadata)) ??
        toolAction?.ask ?? branchResult?.ask;
      // Ask output has a directional recipient for durable conversation shape,
      // but only its deferred Tool-plan barrier may resume the requester.
      if (ask && (ask.phase === "progress" || ask.phase === "answer")) {
        return;
      }
      if (
        workflow?.continuation === "realtime" ||
        workflow?.continuation === "none"
      ) {
        return;
      }
      for (const recipientId of new Set(stringArray(record.recipientIds))) {
        const continuationKey = workflow?.kind === "tool_result"
          ? `${requiredText(toolCursor?.planId, "Tool plan id")}:${recipientId}`
          : `${record.id}:${recipientId}`;
        try {
          await context.actions.callLlm.prepare(async () => {
            const compactedBoundaries = new Set<string>();
            for (;;) {
              context.signal.throwIfAborted();
              const captured = await context.readSnapshot(
                async ({ collections }) => {
                  const metadata = await loadCoreThreadMetadata(
                    { collections } as typeof context,
                    String(record.threadId),
                  );
                  const participant = metadata.participantRecords.find((
                    candidate,
                  ) => String(candidate.id) === recipientId);
                  const agent =
                    participant && participant.participantType === "agent"
                      ? coreAgent(
                        context.resources,
                        participantAgentId(participant),
                      )
                      : undefined;
                  const sender = metadata.participantRecords.find((candidate) =>
                    String(candidate.id) === String(record.senderId)
                  );
                  if (participant && agent && !sender) {
                    throw new Error(
                      `Message '${record.id}' sender was not found.`,
                    );
                  }
                  const resolved = participant && agent && sender
                    ? await resolvedAgent(context, agent, {
                      agentParticipant: participant,
                      thread: metadata.thread,
                      triggerMessage: record,
                      triggerSender: sender,
                      collections,
                    })
                    : undefined;
                  const contributions = participant && resolved
                    ? await collectContextContributions(
                      { ...context, collections } as typeof context,
                      {
                        purpose: "conversation",
                        agent: resolved.agent,
                        participant: mapParticipantRecord(participant),
                        thread: metadata.thread,
                        ...(agentTurn ? { historyScopeId: agentTurn.id } : {}),
                      },
                    )
                    : [];
                  const afterMessageId = contributions.map((entry) =>
                    entry.historyAfterMessageId
                  )
                    .filter((id): id is string => Boolean(id)).at(-1);
                  const snapshot = await loadCoreThreadMessageSnapshot(
                    { collections } as typeof context,
                    String(record.threadId),
                    record,
                    {
                      ...(agentTurn
                        ? {
                          historyScopeId: agentTurn.id,
                          internalOnly: agentTurn.history === "scope",
                        }
                        : {}),
                      viewerIds: [recipientId],
                      ...(afterMessageId ? { afterMessageId } : {}),
                    },
                  );
                  return { snapshot, contributions, resolved };
                },
              );
              const snapshot = captured.snapshot;
              if (!snapshot.active) {
                throw new SupersededMessageError(
                  `Message '${record.id}' is no longer active.`,
                );
              }
              if (
                !snapshot.thread.participants.some((item) =>
                  item.id === recipientId
                )
              ) {
                throw new SupersededMessageError(
                  "Message recipient is no longer in the thread.",
                );
              }
              const participants = new Map(
                snapshot.participantRecords.map((
                  candidate,
                ) => [String(candidate.id), candidate]),
              );
              const sender = participants.get(String(record.senderId));
              const participant = participants.get(recipientId);
              if (!sender) {
                throw new Error(`Message '${record.id}' sender was not found.`);
              }
              if (!participant || participant.participantType !== "agent") {
                throw new SupersededMessageError(
                  "Message recipient is no longer an Agent.",
                );
              }
              const agentId = participantAgentId(participant);
              const agent = coreAgent(context.resources, agentId);
              if (!agent) {
                throw new SupersededMessageError(
                  `Agent '${agentId}' is no longer available.`,
                );
              }
              const availableTools = toolsForAgent(context, agent);
              const availableToolIds = availableTools.map((tool) => tool.alias);
              const resolved = captured.resolved;
              if (!resolved) {
                throw new SupersededMessageError(
                  "Message recipient could not be resolved as an Agent.",
                );
              }
              const selection = modelsFor(resolved.agent);
              const afterMessageId = captured.contributions.map((item) =>
                item.historyAfterMessageId
              ).filter((id): id is string => Boolean(id)).at(-1);
              const hasCompaction = !agentTurn &&
                Object.values(context.resources.promptContext ?? {})
                  .some((resource) =>
                    isContextResource(resource) && resource.compact
                  );
              const limits = selection.models.map((model) =>
                preflightLlmRequest({ messages: [] }, {
                  ...model.options,
                  model: model.model,
                }, context.namespace).limitEstimatedInputTokens
              ).filter((limit): limit is number =>
                typeof limit === "number" && Number.isFinite(limit) && limit > 0
              );
              const limit = limits.length ? Math.min(...limits) : undefined;
              const compact = async (error: ContextInputLimitError) => {
                const boundaryKey = afterMessageId ?? "initial";
                if (compactedBoundaries.has(boundaryKey)) {
                  throw new Error(
                    "Consolidation did not advance the conversation history boundary.",
                  );
                }
                compactedBoundaries.add(boundaryKey);
                await context.actions.compactContext({
                  threadId: snapshot.thread.id,
                  agentId: resolved.agent.id,
                  participantId: String(participant.id),
                  triggerMessageId: String(record.id),
                  ...(afterMessageId
                    ? { historyAfterMessageId: afterMessageId }
                    : {}),
                  estimatedTokens: error.estimatedInputTokens,
                  limitEstimatedTokens: error.limitEstimatedInputTokens,
                }, {
                  operationKey: `context:${continuationKey}:${boundaryKey}`,
                  signal: context.signal,
                  metadata: {
                    schema: "copilotz.core.context-compaction.v1",
                    threadId: snapshot.thread.id,
                    agentId: resolved.agent.id,
                    agentName: resolved.agent.name,
                    agentParticipantId: String(participant.id),
                    triggerMessageId: String(record.id),
                  },
                });
              };
              let request;
              try {
                request = await buildCoreLlmRequest(context, {
                  agent: resolved.agent,
                  participant,
                  thread: snapshot.thread,
                  ...(agentTurn ? { historyScopeId: agentTurn.id } : {}),
                  history: snapshot.messages,
                  messageIds: snapshot.records.map((item) => String(item.id)),
                  tools: availableTools,
                  contributions: captured.contributions,
                  ...(hasCompaction && limit
                    ? { historyByteLimit: Math.floor(limit * 8) }
                    : {}),
                });
              } catch (error) {
                if (
                  !isContentByteLimitError(error) || !hasCompaction ||
                  !limit
                ) {
                  throw error;
                }
                await compact(
                  new ContextInputLimitError(
                    Math.max(limit + 1, Math.ceil(error.bytes / 8)),
                    limit,
                  ),
                );
                continue;
              }
              const currentThread = await context.collections.thread.get({
                id: snapshot.thread.id,
              });
              if (
                !currentThread ||
                !stringArray(currentThread.participantIds).includes(recipientId)
              ) {
                throw new SupersededMessageError(
                  "Message recipient is no longer in the thread.",
                );
              }
              if (
                JSON.stringify(currentThread.activeMessageBranch ?? null) !==
                  JSON.stringify(snapshot.thread.activeMessageBranch ?? null)
              ) {
                throw new Error(
                  "Conversation branch changed during input preparation.",
                );
              }
              const metadata = defineCoreLlmCallMetadata({
                schema: CORE_LLM_CALL_METADATA_SCHEMA,
                threadId: String(record.threadId),
                triggerMessageId: String(record.id),
                agentId,
                agentParticipantId: String(participant.id),
                initiatorParticipantId: toolCursor?.initiatorParticipantId ??
                  ask?.origin.initiatorParticipantId ??
                  workflow?.initiatorParticipantId ??
                  String(sender.id),
                availableToolIds,
                responseVisibility: structuredClone(
                  toolCursor?.responseVisibility ?? coreEvent(event).visibility,
                ),
                ...(toolCursor?.parentLlmActionRunId ??
                    workflow?.parentLlmAttemptId ?? ask?.callingAttemptId
                  ? {
                    parentActionRunId: toolAction?.parentLlmActionRunId ??
                      workflow?.parentLlmAttemptId ?? ask?.callingAttemptId,
                  }
                  : {}),
                ...(ask ? { ask: structuredClone(ask) } : {}),
                ...(agentTurn ? { agentTurn: structuredClone(agentTurn) } : {}),
                ...(resolved.revision
                  ? { instructionRevision: resolved.revision }
                  : {}),
                llmSession: {
                  schema: "copilotz.llm-session.v1",
                  threadId: String(record.threadId),
                  agentId,
                },
              });
              try {
                for (const model of selection.models) {
                  const connection =
                    context.resources.llmConnections[model.connection];
                  if (!connection) {
                    throw new Error(
                      `Unknown LLM connection '${model.connection}'.`,
                    );
                  }
                  preflightLlmRequest(request, {
                    ...model.options,
                    model: model.model,
                    ...(connection.provider
                      ? { provider: connection.provider }
                      : {}),
                  }, context.namespace);
                }
              } catch (error) {
                if (!isContextInputLimitError(error)) {
                  throw error;
                }
                if (hasCompaction) {
                  await compact(error);
                  continue;
                }
              }
              return {
                input: {
                  models: selection.models,
                  mode: selection.mode,
                  request,
                  stream: {
                    metadata: coreLlmStreamMetadata(
                      resolved.agent,
                      ask ?? undefined,
                    ),
                  },
                },
                metadata,
              };
            }
          }, {
            operationKey: `route:${continuationKey}`,
            identity: {
              correlationId: event.correlationId,
              causationId: event.id,
              settlementScopeId: context.identity.settlementScopeId,
            },
            signal: context.signal,
          });
        } catch (error) {
          if (error instanceof SupersededMessageError) {
            continue;
          }
          if (!isSettledActionError(error)) {
            throw error;
          }
        }
      }
    },
  });
export default messageRouterProcessor;
