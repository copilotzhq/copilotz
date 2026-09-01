/** Routes canonical Messages into agent LLM calls. @module */

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
} from "../../internal/workflow-metadata.ts";
import { defineProcessor, type Processor } from "@copilotz/copilotz/plugins";
import type { CollectionRecord } from "@copilotz/copilotz/collections";
import { buildCoreLlmRequest } from "../../internal/agents/prompt.ts";
import type {
  AgentInstructionContext,
  AgentInstructionExecution,
  AgentModelSelection,
  AgentResource,
} from "../../resources/agent/index.ts";
import {
  coreAgent,
  type CoreProcessorContext,
} from "../../internal/runtime-context.ts";
import {
  mapMessageRecord,
  mapParticipantRecord,
} from "../../../core-collections/internal/projections.ts";
import type { ConversationThread } from "../../../core-collections/internal/contracts.ts";
import {
  asRecord,
  collectionEventRecord,
  loadCoreThreadMessageSnapshot,
  participantAgentId,
  requiredText,
  stringArray,
  toolsForAgent,
} from "../internal/helpers.ts";

function modelsFor(agent: AgentResource): Readonly<{
  models: AgentModelSelection;
  mode: "generate" | "session";
}> {
  if (agent.models.generate) {
    return Object.freeze({ models: agent.models.generate, mode: "generate" });
  }
  if (agent.models.session) {
    return Object.freeze({ models: agent.models.session, mode: "session" });
  }
  throw new Error(`Agent '${agent.id}' requires a generate or session model.`);
}

/** Clones durable facts so a process-local instruction hook cannot mutate them. */
function frozenFact<T>(value: T): T {
  return freezeFact(structuredClone(value), new WeakSet<object>()) as T;
}

function freezeFact(value: unknown, seen: WeakSet<object>): unknown {
  if (!value || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor && "value" in descriptor) freezeFact(descriptor.value, seen);
  }
  return Object.freeze(value);
}

async function resolvedAgentInstructions(
  context: CoreProcessorContext,
  agent: AgentResource,
  input: Readonly<{
    agentParticipant: CollectionRecord;
    thread: ConversationThread;
    triggerMessage: CollectionRecord;
    triggerSender: CollectionRecord;
  }>,
): Promise<Readonly<{ agent: AgentResource; instructionRevision?: string }>> {
  const policy = agent.instructions;
  if (!policy || typeof policy === "string") {
    return Object.freeze({ agent });
  }
  const facts: AgentInstructionContext = Object.freeze({
    agent,
    participant: frozenFact(mapParticipantRecord(input.agentParticipant)),
    thread: frozenFact(input.thread),
    triggerMessage: frozenFact(mapMessageRecord(
      input.triggerMessage,
      mapParticipantRecord(input.triggerSender),
    )),
  });
  const execution: AgentInstructionExecution = Object.freeze({
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
  });
  const output = await policy.resolve(facts, execution);
  const resolved = instructionResolution(output, agent.id);
  const { instructions: _instructions, ...staticAgent } = agent;
  const selected = resolved.instructions ?? policy.base;
  return Object.freeze({
    agent: Object.freeze({
      ...staticAgent,
      ...(selected !== undefined ? { instructions: selected } : {}),
    }),
    ...(resolved.revision ? { instructionRevision: resolved.revision } : {}),
  });
}

function stableText(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim() || value.trim() !== value) {
    throw new TypeError(
      `Agent '${label}' resolver returned invalid text.`,
    );
  }
  return value;
}

function instructionResolution(
  value: unknown,
  agentId: string,
): Readonly<{ instructions?: string; revision?: string }> {
  if (value === null || value === undefined) return Object.freeze({});
  if (typeof value === "string") {
    return Object.freeze({ instructions: stableText(value, agentId) });
  }
  if (
    !value || typeof value !== "object" || Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    throw new TypeError(
      `Agent '${agentId}' resolver returned invalid instructions.`,
    );
  }
  const record = value as Record<string, unknown>;
  if (
    Reflect.ownKeys(record).some((key) =>
      key !== "instructions" && key !== "revision"
    ) ||
    !("instructions" in record) ||
    (record.instructions !== null && typeof record.instructions !== "string")
  ) {
    throw new TypeError(
      `Agent '${agentId}' resolver returned invalid instructions.`,
    );
  }
  return Object.freeze({
    ...(typeof record.instructions === "string"
      ? { instructions: stableText(record.instructions, agentId) }
      : {}),
    ...(record.revision === undefined
      ? {}
      : { revision: stableText(record.revision, agentId) }),
  });
}

export const messageRouterProcessor: Processor<CoreProcessorContext> =
  defineProcessor<CoreProcessorContext>({
    id: "copilotz.core.message-to-llm-call",
    on: [{ eventType: "message.created" }],
    async handle(event, context) {
      if (!event.routing?.recipientIds?.length) return;
      if (!event.durable || !event.threadId) return;
      const record = collectionEventRecord(event);
      const workflow = workflowMetadata(asRecord(record.metadata));
      const toolAction = coreToolActionMessageMetadata(record.metadata);
      const branchResult = coreToolPlanResultMetadata(record.metadata);
      const toolCursor = toolAction ?? branchResult?.origin;
      const directTurn = coreAgentTurnMetadata(record.metadata);
      const agentTurn = directTurn ?? toolCursor?.agentTurn;
      if (
        agentTurn && (
          event.visibility?.kind !== "internal" ||
          asRecord(record.visibility).kind !== "internal" ||
          record.historyScopeId !== agentTurn.id
        )
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
      if (ask && (ask.phase === "progress" || ask.phase === "answer")) return;
      if (
        workflow?.continuation === "realtime" ||
        workflow?.continuation === "none"
      ) return;
      const snapshot = await loadCoreThreadMessageSnapshot(
        context,
        String(record.threadId),
        record,
        agentTurn ? { historyScopeId: agentTurn.id } : undefined,
      );
      // A revision can supersede an already-enqueued Message before its
      // Processor runs. Inactive anchors are intentionally ignored.
      if (!snapshot.active) return;
      const participants = new Map(
        snapshot.participantRecords.map((participant) => [
          String(participant.id),
          participant,
        ]),
      );
      const sender = participants.get(String(record.senderId));
      if (!sender) {
        throw new Error(`Message '${record.id}' sender was not found.`);
      }
      const historyIds = Object.freeze(
        snapshot.records.map((item) => String(item.id)),
      );
      for (const recipientId of new Set(stringArray(record.recipientIds))) {
        const participant = participants.get(recipientId);
        if (!participant || participant.participantType !== "agent") continue;
        const agentId = participantAgentId(participant);
        const agent = coreAgent(context.resources, agentId);
        if (!agent) continue;
        const availableTools = toolsForAgent(context, agent);
        const availableToolIds = Object.freeze(
          availableTools.map((tool) => tool.alias),
        );
        const resolved = await resolvedAgentInstructions(context, agent, {
          agentParticipant: participant,
          thread: snapshot.thread,
          triggerMessage: record,
          triggerSender: sender,
        });
        const request = await buildCoreLlmRequest(context, {
          agent: resolved.agent,
          participant,
          thread: snapshot.thread,
          history: snapshot.messages,
          messageIds: historyIds,
          tools: availableTools,
        });
        const continuationKey = workflow?.kind === "tool_result"
          ? `${requiredText(toolCursor?.planId, "Tool plan id")}:${recipientId}`
          : `${record.id}:${recipientId}`;
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
            toolCursor?.responseVisibility ?? event.visibility,
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
          ...(resolved.instructionRevision
            ? { instructionRevision: resolved.instructionRevision }
            : {}),
        });
        const selection = modelsFor(agent);
        try {
          await context.actions.callLlm({
            models: selection.models,
            mode: selection.mode,
            request,
            stream: {
              metadata: coreLlmStreamMetadata(agent, ask ?? undefined),
            },
          }, {
            operationKey: `route:${continuationKey}`,
            identity: {
              correlationId: event.correlationId,
              causationId: event.id,
              settlementScopeId: context.identity.settlementScopeId,
            },
            metadata,
            signal: context.signal,
          });
        } catch (error) {
          if (!isSettledActionError(error)) throw error;
        }
      }
    },
  });
