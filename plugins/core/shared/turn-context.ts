import {
  agentTurnSourceDigest,
  resolveAgentTurnSource,
} from "./agent-turn-source.ts";
import { collectContextContributions } from "./contributions.ts";

/** Routes canonical Messages into agent LLM calls. @module */

import {
  agentAskMetadata,
  type coreAgentTurnMetadata,
} from "./workflow-metadata.ts";

import type {
  CollectionRecord,
  ReadCollections,
} from "@copilotz/copilotz/collections";

import type {
  AgentDynamicResolveContext,
  AgentDynamicResolveExecution,
  AgentDynamicResolveOutput,
  AgentResource,
} from "../authoring/define-agent/index.ts";
import {
  normalizeAgentHistory,
  normalizeAgentModels,
} from "../authoring/define-agent/index.ts";
import { coreAgent, type CoreProcessorContext } from "./runtime-context.ts";
import { mapMessageRecord, mapParticipantRecord } from "./projections.ts";
import type { ConversationMessage, ConversationThread } from "./contracts.ts";
import {
  loadCoreThreadMessageSnapshot,
  loadCoreThreadMetadata,
  participantAgentId,
} from "./helpers.ts";

import { defineRead } from "@copilotz/copilotz/collections/authoring";
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
    collections: ReadCollections;
  }>,
): Promise<
  Readonly<{
    agent: AgentResource;
    revision?: string;
  }>
> {
  const baseHistory = normalizeAgentHistory(agent.history, agent.id);
  const resolver = agent.dynamicResolve;
  if (!resolver) {
    return ({
      agent: baseHistory ? { ...agent, history: baseHistory } : agent,
    } as const);
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
  const {
    dynamicResolve: _dynamicResolve,
    history: _history,
    ...staticAgent
  } = agent;
  return ({
    agent: {
      ...staticAgent,
      ...(baseHistory ? { history: baseHistory } : {}),
      ...(resolved.instructions !== undefined
        ? { instructions: resolved.instructions }
        : {}),
      ...(resolved.models !== undefined ? { models: resolved.models } : {}),
      ...(resolved.history !== undefined ? { history: resolved.history } : {}),
    } as const,
    ...(resolved.revision ? { revision: resolved.revision } : {}),
  } as const);
}
function historyStart(createdAt: unknown, maxAgeMs: number): string {
  const timestamp = Date.parse(String(createdAt));
  if (!Number.isFinite(timestamp)) {
    throw new TypeError("Agent history requires a valid trigger timestamp.");
  }
  return new Date(
    Math.max(-8_640_000_000_000_000, timestamp - maxAgeMs),
  ).toISOString();
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
      key !== "instructions" && key !== "models" && key !== "history" &&
      key !== "revision"
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
  const history = normalizeAgentHistory(record.history, agentId);
  const revision = record.revision === undefined
    ? undefined
    : stableText(record.revision, `${agentId} revision`);
  return ({
    ...(instructions !== undefined ? { instructions } : {}),
    ...(models !== undefined ? { models } : {}),
    ...(history !== undefined ? { history } : {}),
    ...(revision !== undefined ? { revision } : {}),
  } as const);
}

export type TurnContextArgs = {
  record: CollectionRecord;
  recipientId: string;
  agentTurn: ReturnType<typeof coreAgentTurnMetadata> | null;
  initialAsk: ReturnType<typeof agentAskMetadata> | null;
  initiatorParticipantId: string | null;
  eventThreadId: string;
};
async function loadTurnContext(
  input: TurnContextArgs,
  readContext: import("@copilotz/copilotz/collections").ReadContext,
): Promise<TurnContextResult> {
  const context = readContext as CoreProcessorContext;
  const { collections } = readContext;
  const { record, recipientId, agentTurn, initialAsk, eventThreadId } = input;
  const initiatorParticipantId = input.initiatorParticipantId ?? undefined;
  const metadata = await loadCoreThreadMetadata(
    { collections } as typeof context,
    String(record.threadId),
  );
  const participant = metadata.participantRecords.find((
    candidate,
  ) => String(candidate.id) === recipientId);
  const agent = participant && participant.participantType === "agent"
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
  const scopedSnapshot = agentTurn?.sourceHistoryRef
    ? await loadCoreThreadMessageSnapshot(
      { collections } as typeof context,
      String(record.threadId),
      record,
      {
        historyScopeId: agentTurn.id,
        internalOnly: true,
        viewerIds: [recipientId],
      },
    )
    : undefined;
  const source = agentTurn
    ? await resolveAgentTurnSource(
      agentTurn,
      scopedSnapshot?.records ?? [],
      {
        namespace: context.namespace,
        threadId: String(record.threadId),
        participantId: recipientId,
      },
    )
    : undefined;
  const sourceRef = agentTurn?.sourceHistory
    ? {
      messageId: String(record.id),
      digest: await agentTurnSourceDigest(
        agentTurn.sourceHistory,
      ),
    }
    : agentTurn?.sourceHistoryRef;
  if (
    source &&
    source.branch !==
      JSON.stringify(
        metadata.thread.activeMessageBranch ?? null,
      )
  ) {
    throw new Error(
      "Agent turn source branch changed during input preparation.",
    );
  }
  if (
    source && (agentTurn?.ownerParticipantId !== recipientId ||
      source.messages.some((message) =>
        message.threadId !== String(record.threadId) ||
        message.namespace !== context.namespace
      ) ||
      source.trigger &&
        (source.trigger.threadId !== String(record.threadId) ||
          source.trigger.namespace !== context.namespace))
  ) {
    throw new Error(
      "Agent turn source history belongs to another thread.",
    );
  }
  const resolutionTrigger = source?.trigger;
  const resolved = participant && agent && sender
    ? await resolvedAgent(context, agent, {
      agentParticipant: participant,
      thread: metadata.thread,
      triggerMessage: resolutionTrigger
        ? {
          ...resolutionTrigger,
          senderId: resolutionTrigger.sender.id,
        } as unknown as CollectionRecord
        : record,
      triggerSender: resolutionTrigger
        ? resolutionTrigger
          .sender as unknown as CollectionRecord
        : sender,
      collections,
    })
    : undefined;
  const contributions = source
    ? []
    : participant && resolved
    ? await collectContextContributions(
      { ...context, collections } as typeof context,
      {
        purpose: "conversation",
        agent: resolved.agent,
        participant: mapParticipantRecord(participant),
        thread: metadata.thread,
        initiatorParticipantId,
        ...(agentTurn ? { historyScopeId: agentTurn.id } : {}),
      },
    )
    : [];
  const afterMessageId = contributions.map((entry) =>
    entry.historyAfterMessageId
  )
    .filter((id): id is string => Boolean(id)).at(-1);
  const historyPolicy = resolved?.agent.history;
  const scopedStart = historyPolicy
    ? historyStart(record.createdAt, historyPolicy.maxAgeMs)
    : undefined;
  const snapshot = scopedSnapshot
    ? {
      ...scopedSnapshot,
      records: scopedSnapshot.records.filter((item) =>
        !scopedStart || String(item.createdAt) >= scopedStart
      ),
      messages: scopedSnapshot.messages.filter((item) =>
        !scopedStart || item.createdAt >= scopedStart
      ),
    }
    : await loadCoreThreadMessageSnapshot(
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
        ...(historyPolicy
          ? {
            createdAtOrAfter: historyStart(
              record.createdAt,
              historyPolicy.maxAgeMs,
            ),
          }
          : {}),
      },
    );
  let routedAskQuestion: ConversationMessage | undefined;
  if (initialAsk && snapshot.active) {
    if (
      initialAsk.questionMessageId !== String(record.id) ||
      initialAsk.origin.threadId !== String(record.threadId) ||
      eventThreadId !== String(record.threadId)
    ) {
      throw new Error(
        "Initial Ask question has a different trigger.",
      );
    }
    routedAskQuestion = snapshot.messages.find((message) =>
      message.id === initialAsk.questionMessageId
    );
    // A certified history boundary may omit the still-active
    // task. Select only its already-bound point, under the same
    // snapshot, branch and recipient visibility predicates.
    if (
      !routedAskQuestion && (afterMessageId || historyPolicy)
    ) {
      const point = await loadCoreThreadMessageSnapshot(
        { collections } as typeof context,
        String(record.threadId),
        record,
        {
          ...(agentTurn
            ? {
              historyScopeId: agentTurn.id,
              internalOnly: Boolean(scopedSnapshot) ||
                agentTurn.history === "scope",
            }
            : {}),
          viewerIds: [recipientId],
          range: {
            startMessageId: initialAsk.questionMessageId,
            endMessageId: initialAsk.questionMessageId,
          },
        },
      );
      if (point.active && point.messages.length === 1) {
        routedAskQuestion = point.messages[0];
      }
    }
    const currentAsk = agentAskMetadata(
      routedAskQuestion?.metadata,
    );
    if (
      !routedAskQuestion || !currentAsk || !participant ||
      !agent || !sender || sender.participantType !== "agent" ||
      routedAskQuestion.namespace !== context.namespace ||
      routedAskQuestion.threadId !== String(record.threadId) ||
      routedAskQuestion.id !== String(record.id) ||
      currentAsk.phase !== "question" ||
      currentAsk.askId !== initialAsk.askId ||
      currentAsk.questionMessageId !== routedAskQuestion.id ||
      currentAsk.toolActionRunId !==
        initialAsk.toolActionRunId ||
      currentAsk.toolCallId !== initialAsk.toolCallId ||
      currentAsk.origin.threadId !==
        routedAskQuestion.threadId ||
      currentAsk.askedParticipantId !== recipientId ||
      currentAsk.askedParticipantId !==
        initialAsk.askedParticipantId ||
      currentAsk.askedAgentId !== agent.id ||
      currentAsk.askedAgentId !== initialAsk.askedAgentId ||
      currentAsk.askingParticipantId !==
        routedAskQuestion.sender.id ||
      currentAsk.askingParticipantId !==
        initialAsk.askingParticipantId ||
      currentAsk.askingAgentId !== initialAsk.askingAgentId ||
      currentAsk.askingAgentId !== participantAgentId(sender) ||
      !routedAskQuestion.recipientIds.includes(recipientId)
    ) {
      throw new Error(
        "Initial Ask question does not match its routed identity.",
      );
    }
  }
  return {
    snapshot,
    routedAskQuestion,
    contributions,
    resolved,
    source,
    sourceRef,
  };
}
export type TurnContextResult = Readonly<{
  snapshot: Awaited<ReturnType<typeof loadCoreThreadMessageSnapshot>>;
  routedAskQuestion: ConversationMessage | undefined;
  contributions: Awaited<ReturnType<typeof collectContextContributions>>;
  resolved: Awaited<ReturnType<typeof resolvedAgent>> | undefined;
  source: Awaited<ReturnType<typeof resolveAgentTurnSource>> | undefined;
  sourceRef: NonNullable<
    ReturnType<typeof coreAgentTurnMetadata>
  >["sourceHistoryRef"];
}>;
export const turnContextRead:
  import("@copilotz/copilotz/collections").RegisteredRead<
    TurnContextArgs,
    TurnContextResult
  > = defineRead(loadTurnContext);
