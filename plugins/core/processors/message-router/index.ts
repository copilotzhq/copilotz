import type { TurnContextResult } from "../../shared/turn-context.ts";

import { coreEvent } from "../../shared/events/index.ts";
import { ContextCompactionAwaitingError } from "../../shared/context-compaction.ts";
/** Routes canonical Messages into agent LLM calls. @module */
import { ContextInputLimitError, prepareLlmCall } from "@copilotz/copilotz/llm";
import { isContentByteLimitError } from "@copilotz/copilotz/content";
import { isSettledActionError } from "@copilotz/copilotz/actions";
import {
  agentAskMetadata,
  CORE_LLM_CALL_METADATA_SCHEMA,
  coreAgentTurnMetadata,
  coreLlmStreamMetadata,
  coreMessageOrigin,
  coreToolActionMessageMetadata,
  coreToolPlanResultMetadata,
  defineCoreLlmCallMetadata,
  workflowMetadata,
} from "../../shared/workflow-metadata.ts";
import { defineProcessor, type Processor } from "@copilotz/copilotz/plugins";

import { buildCoreLlmRequest } from "./agents/prompt.ts";
import { historyLimitEstimatedTokens } from "./agents/history-budget.ts";
import { isContextResource } from "../../authoring/define-context/index.ts";
import type {
  AgentModelSelection,
  AgentResource,
} from "../../authoring/define-agent/index.ts";

import {
  coreAgent,
  type CoreProcessorContext,
} from "../../shared/runtime-context.ts";
import { mapParticipantRecord } from "../../shared/projections.ts";

import {
  asRecord,
  collectionEventRecord,
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
      const directAsk = agentAskMetadata(asRecord(record.metadata));
      const ask = directAsk ?? toolAction?.ask ?? branchResult?.ask;
      const initialAsk = directAsk?.phase === "question" && !toolCursor
        ? directAsk
        : undefined;
      // Ask output has a directional recipient for durable conversation shape,
      // but only its Tool-plan continuation may resume the requester.
      if (ask && (ask.phase === "progress" || ask.phase === "answer")) {
        return;
      }
      if (
        workflow?.continuation === "realtime" ||
        workflow?.continuation === "none"
      ) {
        return;
      }
      const routedRecipients = new Set(
        stringArray(coreEvent(event).routing?.recipientIds),
      );
      const recipientIds = [
        ...new Set(
          stringArray(record.recipientIds).filter((id) =>
            routedRecipients.has(id)
          ),
        ),
      ];
      // Addressing a Participant does not imply an Agent turn. Keep the Message's
      // recipients intact for conversation/channel delivery and select inference
      // recipients from current, authorized records before preparing an Action.
      const agentRecipients = new Set<string>();
      for (let offset = 0; offset < recipientIds.length; offset += 1_000) {
        const batch = recipientIds.slice(offset, offset + 1_000);
        const participants = await context.collections.participant.list({
          where: { id: { in: batch } },
          limit: batch.length,
        });
        for (const participant of participants) {
          if (participant.participantType === "agent") {
            agentRecipients.add(String(participant.id));
          }
        }
      }
      const route = async (recipientId: string) => {
        const continuationKey = workflow?.kind === "tool_result"
          ? `${requiredText(toolCursor?.planId, "Tool plan id")}:${recipientId}`
          : `${record.id}:${recipientId}`;
        try {
          const prepare = async () => {
            const initiatorParticipantId = coreMessageOrigin({
              id: record.id,
              senderId: String(record.senderId),
              metadata: record.metadata,
            }).initiatorParticipantId;
            for (
              const resource of Object.values(
                context.resources.promptContext ?? {},
              )
            ) {
              if (
                isContextResource(resource) &&
                resource.purposes.includes("conversation")
              ) {
                await resource.prepare?.({
                  context,
                  threadId: String(record.threadId),
                  initiatorParticipantId,
                  ...(agentTurn ? { historyScopeId: agentTurn.id } : {}),
                });
              }
            }
            const compactedBoundaries = new Set<string>();
            for (;;) {
              context.signal.throwIfAborted();
              const { value: captured } = await context.read<TurnContextResult>(
                "coreTurnContext",
                {
                  record,
                  recipientId,
                  agentTurn: agentTurn ?? null,
                  initialAsk: initialAsk ?? null,
                  initiatorParticipantId: initiatorParticipantId ?? null,
                  eventThreadId: coreEvent(event).threadId,
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
                    isContextResource(resource) &&
                    (resource.compact ||
                      (resource.reserveCompact && resource.checkCompact))
                  );
              const configuredLimit =
                selection.models[0].options?.limitEstimatedInputTokens ??
                  150_000;
              const limit = typeof configuredLimit === "number" &&
                  Number.isFinite(configuredLimit) && configuredLimit > 0
                ? configuredLimit
                : undefined;
              const compact = async (
                error: ContextInputLimitError,
                historyLimit: number,
              ) => {
                const boundaryKey = afterMessageId ?? "initial";
                if (compactedBoundaries.has(boundaryKey)) {
                  throw new Error(
                    "Consolidation did not advance the conversation history boundary.",
                  );
                }
                compactedBoundaries.add(boundaryKey);
                const result = await context.actions.compactContext.prepare(
                  () => ({
                    input: {
                      threadId: snapshot.thread.id,
                      agentId: resolved.agent.id,
                      participantId: String(participant.id),
                      triggerMessageId: String(record.id),
                      triggerEventId: event.id,
                      ...(event.correlationId
                        ? { routeCorrelationId: event.correlationId }
                        : {}),
                      ...(afterMessageId
                        ? { historyAfterMessageId: afterMessageId }
                        : {}),
                      estimatedTokens: error.estimatedInputTokens,
                      limitEstimatedTokens: error.limitEstimatedInputTokens,
                      historyLimitEstimatedTokens: historyLimit,
                    },
                    metadata: {
                      schema: "copilotz.core.context-compaction.v1",
                      threadId: snapshot.thread.id,
                      agentId: resolved.agent.id,
                      agentName: resolved.agent.name,
                      agentParticipantId: String(participant.id),
                      triggerMessageId: String(record.id),
                    },
                  }),
                  {
                    operationKey: `context:${continuationKey}:${boundaryKey}`,
                    signal: context.signal,
                  },
                );
                if (
                  result && typeof result === "object" &&
                  (result as { status?: unknown }).status === "awaiting"
                ) throw new ContextCompactionAwaitingError();
              };
              let request;
              let preparedHistory:
                readonly import("../../shared/agents/transcript.ts").LlmTranscriptEntry[] =
                  [];
              try {
                request = await buildCoreLlmRequest(context, {
                  agent: resolved.agent,
                  participant,
                  thread: snapshot.thread,
                  ...(agentTurn ? { historyScopeId: agentTurn.id } : {}),
                  ...(captured.routedAskQuestion
                    ? { routedAskQuestion: captured.routedAskQuestion }
                    : {}),
                  history: [
                    ...(captured.source?.messages ?? []),
                    ...snapshot.messages,
                  ],
                  messageIds: [
                    ...(captured.source?.messages.map((message) =>
                      message.id
                    ) ?? []),
                    ...snapshot.records.map((item) => String(item.id)),
                  ],
                  ...(captured.source
                    ? { frozenContributions: captured.source.context }
                    : {}),
                  onHistoryPrepared: (transcript) => {
                    preparedHistory = transcript;
                  },
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
                const prefixRequest = await buildCoreLlmRequest(context, {
                  agent: resolved.agent,
                  participant,
                  thread: snapshot.thread,
                  history: [],
                  messageIds: [],
                  tools: availableTools,
                  contributions: captured.contributions,
                });
                await compact(
                  new ContextInputLimitError(
                    Math.max(limit + 1, Math.ceil(error.bytes / 8)),
                    limit,
                  ),
                  await historyLimitEstimatedTokens(
                    {
                      models: selection.models,
                      mode: selection.mode,
                      request: prefixRequest,
                    },
                    context.resources.llmConnections,
                    context.namespace,
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
                ...coreMessageOrigin({
                  id: String(record.id),
                  senderId: String(sender.id),
                  metadata: record.metadata,
                }),
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
                ...(agentTurn
                  ? {
                    agentTurn: agentTurn.sourceHistory
                      ? (({ sourceHistory: _source, ...turn }) => ({
                        ...turn,
                        sourceHistoryRef: captured.sourceRef,
                      }))(agentTurn)
                      : structuredClone(agentTurn),
                  }
                  : {}),
                ...(resolved.revision
                  ? { instructionRevision: resolved.revision }
                  : {}),
                llmSession: {
                  schema: "copilotz.llm-session.v1",
                  threadId: String(record.threadId),
                  agentId,
                },
              });
              const callInput = {
                models: selection.models,
                mode: selection.mode,
                request,
                stream: {
                  metadata: coreLlmStreamMetadata(
                    resolved.agent,
                    ask ?? undefined,
                  ),
                },
              } as const;
              const preparation = await prepareLlmCall(
                callInput,
                context.resources.llmConnections,
                context.namespace,
              );
              // Compact for the preferred model before considering fallbacks.
              const preferred = preparation.candidates[0]!;
              if (hasCompaction && preferred.status === "too_large") {
                await compact(
                  new ContextInputLimitError(
                    preferred.estimatedInputTokens,
                    preferred.limitEstimatedInputTokens,
                  ),
                  await historyLimitEstimatedTokens(
                    callInput,
                    context.resources.llmConnections,
                    context.namespace,
                  ),
                );
                continue;
              }
              if (!agentTurn) {
                const observers = Object.values(
                  context.resources.promptContext ?? {},
                ).filter((resource) =>
                  isContextResource(resource) && resource.onHistoryPrepared
                );
                const historyLimit = observers.length
                  ? await historyLimitEstimatedTokens(
                    callInput,
                    context.resources.llmConnections,
                    context.namespace,
                  )
                  : 0;
                for (
                  const resource of observers
                ) {
                  if (
                    !isContextResource(resource) || !resource.onHistoryPrepared
                  ) continue;
                  await resource.onHistoryPrepared({
                    context,
                    collections: context.collections,
                    purpose: "conversation",
                    agent: resolved.agent,
                    participant: mapParticipantRecord(participant),
                    thread: snapshot.thread,
                    signal: context.signal,
                    idempotencyKey: `history:${continuationKey}:${
                      afterMessageId ?? "initial"
                    }`,
                    trigger: record,
                    history: snapshot.messages,
                    transcript: preparedHistory,
                    ...(afterMessageId
                      ? { historyAfterMessageId: afterMessageId }
                      : {}),
                    ...(limit ? { limitEstimatedTokens: limit } : {}),
                    historyLimitEstimatedTokens: historyLimit,
                  });
                }
              }
              return {
                input: {
                  ...callInput,
                  preparation,
                },
                metadata,
              };
            }
          };
          await context.actions.callLlm.prepare(
            () => prepare(),
            {
              operationKey: `route:${continuationKey}`,
              identity: {
                correlationId: event.correlationId,
                causationId: event.id,
                settlementScopeId: context.identity.settlementScopeId,
              },
              signal: context.signal,
            },
          );
        } catch (error) {
          if (error instanceof ContextCompactionAwaitingError) return;
          if (
            (agentTurn?.sourceHistory || agentTurn?.sourceHistoryRef) &&
            !isSettledActionError(error)
          ) {
            let settled = false;
            for (
              const resource of Object.values(
                context.resources.promptContext ?? {},
              )
            ) {
              if (
                !isContextResource(resource) || !resource.onTurnPreparationError
              ) continue;
              settled = await resource.onTurnPreparationError({
                context,
                turn: agentTurn,
                triggerMessageId: String(record.id),
                error,
              }) || settled;
            }
            if (settled) return;
          }
          if (error instanceof SupersededMessageError) {
            return;
          }
          if (!isSettledActionError(error)) {
            throw error;
          }
        }
      };
      // Recipients have independent Action identities. Let each reach its own
      // outcome, then retry the delivery if any turn remains retryable. Waiting
      // for every branch keeps the delivery's capability lifetime open until
      // in-flight completions have been checkpointed.
      const outcomes = await Promise.allSettled(
        recipientIds.filter((id) => agentRecipients.has(id)).map(route),
      );
      const rejected = outcomes.find((outcome) =>
        outcome.status === "rejected"
      );
      if (rejected?.status === "rejected") throw rejected.reason;
    },
  });
export default messageRouterProcessor;
