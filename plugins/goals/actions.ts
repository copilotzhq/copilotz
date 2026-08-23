import {
  type ActionContext,
  type ActionDefinition,
  defineAction,
  isSettledActionError,
} from "@copilotz/copilotz/actions";
import type { CollectionRecord } from "@copilotz/copilotz/collections";
import {
  base64ToBytes,
  type ContentInput,
  type ContentRef,
  type ContentSequence,
  type DurableContentInput,
  type PreparedContent,
} from "@copilotz/copilotz/content";
import {
  type AgentResource,
  coreToolPlanMetadata,
  workflowMetadata,
} from "@copilotz/copilotz/core";
import type { ParticipantInput } from "@copilotz/copilotz/core";
import { deriveWorkflowId } from "@copilotz/copilotz/events";
import { asGoalRecord } from "./collection.ts";
import { finalToolStep, resolveGoalCausality } from "./causality.ts";
import { cloneGoalJson, snapshotGoalResource } from "./resource.ts";
import type {
  GoalAssessment,
  GoalCancelInput,
  GoalCancelOutput,
  GoalContentInput,
  GoalEvaluateActionInput,
  GoalMetrics,
  GoalRecord,
  GoalResource,
  GoalResourceSnapshot,
  GoalStartInput,
  GoalStartOutput,
  GoalStatus,
  GoalStopActionInput,
  GoalStopActionOutput,
  GoalStopDecision,
  GoalTerminalStatus,
} from "./types.ts";

export const START_GOAL_ACTION_ID = "copilotz.goals.start";
export const ACCEPT_GOAL_MESSAGE_ACTION_ID = "copilotz.goals.accept-message";
export const ADVANCE_GOAL_ACTION_ID = "copilotz.goals.advance";
export const FAIL_GOAL_AWAITED_ACTION_ID = "copilotz.goals.fail-awaited";
export const CANCEL_GOAL_ACTION_ID = "copilotz.goals.cancel";

const GOAL_METADATA_KEY = "copilotzGoal";

class GoalInvariantError extends Error {
  override readonly name = "GoalInvariantError";
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function text(value: unknown, label?: string): string {
  const result = typeof value === "string" ? value.trim() : "";
  if (!result && label) throw new TypeError(`${label} must be non-empty.`);
  return result;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function interrupted(error: unknown, signal: AbortSignal): boolean {
  return signal.aborted ||
    (error instanceof Error &&
      (error.name === "AbortError" || error.name === "CancellationError"));
}

function goalMetadata(
  goalId: string,
  phase: "target" | "lead" | "judge",
  turn: number,
  metadata?: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  return {
    [GOAL_METADATA_KEY]: {
      schema: "copilotz.goal.v2",
      goalId,
      phase,
      turn,
      ...(metadata ? { metadata: structuredClone(metadata) } : {}),
    },
  };
}

function goalContentPart(value: GoalContentInput): ContentInput {
  if (typeof value === "string") return value;
  const item = record(value);
  if (typeof item.dataBase64 !== "string") {
    return structuredClone(item) as ContentInput;
  }
  const { dataBase64, ...rest } = item;
  return {
    ...rest,
    bytes: base64ToBytes(dataBase64),
  } as ContentInput;
}

function goalContent(
  value: GoalStartInput["content"],
): ContentInput | readonly ContentInput[] {
  return Array.isArray(value)
    ? value.map((entry) => goalContentPart(entry))
    : goalContentPart(value as GoalContentInput);
}

function agentResource(
  context: ActionContext,
  alias: string,
): AgentResource {
  const resources = context.resources.agents as
    | Readonly<Record<string, AgentResource | undefined>>
    | undefined;
  const resource = resources && Object.hasOwn(resources, alias)
    ? resources[alias]
    : undefined;
  if (!resource) throw new Error(`Unknown Agent Resource alias '${alias}'.`);
  text(resource.id, `Agent Resource '${alias}' id`);
  text(resource.name, `Agent Resource '${alias}' name`);
  return resource;
}

function goalResource(
  context: ActionContext,
  alias: string,
): GoalResourceSnapshot {
  const resources = context.resources.goals as
    | Readonly<Record<string, GoalResource | undefined>>
    | undefined;
  const resource = resources && Object.hasOwn(resources, alias)
    ? resources[alias]
    : undefined;
  if (!resource) throw new Error(`Unknown Goal Resource alias '${alias}'.`);
  return snapshotGoalResource(alias, resource);
}

function agentParticipant(agent: AgentResource): ParticipantInput {
  return {
    externalId: agent.id,
    participantType: "agent",
    agentId: agent.id,
    name: agent.name,
  };
}

function senderParticipant(value: GoalStartInput["sender"]): ParticipantInput {
  const externalId = text(value.externalId) || text(value.id);
  if (!externalId) {
    throw new TypeError("Goal sender requires id or externalId.");
  }
  return {
    ...(text(value.id) ? { id: text(value.id) } : {}),
    externalId,
    participantType: "human",
    ...(text(value.name) ? { name: text(value.name) } : {}),
    ...(text(value.email) ? { email: text(value.email) } : {}),
    metadata: structuredClone(value.metadata ?? {}),
  };
}

async function invoke(
  context: ActionContext,
  alias: string,
  input: unknown,
  operationKey: string,
  correlationId: string,
): Promise<unknown> {
  const caller = configuredAction(context, alias);
  return await caller(input, {
    operationKey,
    identity: {
      correlationId,
      deduplicationId: `${correlationId}:${operationKey}`,
    },
    signal: context.signal,
  });
}

function configuredAction(
  context: ActionContext,
  alias: string,
): (input: unknown, options?: unknown) => Promise<unknown> {
  const caller = Object.hasOwn(context.actions, alias)
    ? context.actions[alias] as
      | ((input: unknown, options?: unknown) => Promise<unknown>)
      | undefined
    : undefined;
  if (typeof caller !== "function") {
    throw new TypeError(`Required Action alias '${alias}' is not composed.`);
  }
  return caller;
}

async function findThread(
  context: ActionContext,
  ref: GoalStartInput["thread"] | undefined,
): Promise<CollectionRecord | null> {
  if (!ref) return null;
  const descriptor = typeof ref === "string"
    ? { id: ref, externalId: ref }
    : ref;
  const id = text(descriptor.id);
  if (id) {
    const byId = await context.collections.thread.get({ id });
    if (byId) return byId;
  }
  const externalId = text(descriptor.externalId);
  if (externalId && context.collections.thread.queries.byExternalId) {
    return (await context.collections.thread.queries.byExternalId({
      externalId,
    }))[0] ??
      null;
  }
  return null;
}

async function ensureThread(
  context: ActionContext,
  input: Readonly<{
    id: string;
    descriptor?: GoalStartInput["thread"];
    participants: readonly ParticipantInput[];
    metadata: Readonly<Record<string, unknown>>;
    operation: string;
    goalId: string;
  }>,
): Promise<CollectionRecord> {
  let thread = await findThread(context, input.descriptor);
  if (!thread) {
    const descriptor = typeof input.descriptor === "object"
      ? input.descriptor
      : {};
    const id = text(descriptor.id) ||
      (typeof input.descriptor === "string" ? input.descriptor : input.id);
    thread = await invoke(
      context,
      "createThread",
      {
        id,
        ...(text(descriptor.externalId)
          ? { externalId: text(descriptor.externalId) }
          : {}),
        ...(text(descriptor.parentThreadId)
          ? { parentThreadId: text(descriptor.parentThreadId) }
          : {}),
        participants: input.participants,
        metadata: input.metadata,
      },
      `thread:${input.operation}:create`,
      input.goalId,
    ) as CollectionRecord;
  }
  for (const [index, participant] of input.participants.entries()) {
    await invoke(
      context,
      "addThreadParticipant",
      {
        threadId: thread.id,
        participant,
        eventMetadata: input.metadata,
      },
      `thread:${input.operation}:participant:${index}`,
      input.goalId,
    );
  }
  const reloaded = await context.collections.thread.get({ id: thread.id });
  if (!reloaded) throw new Error(`Goal thread '${thread.id}' was not found.`);
  return reloaded;
}

async function participant(
  context: ActionContext,
  input: ParticipantInput,
): Promise<CollectionRecord> {
  if (text(input.id)) {
    const byId = await context.collections.participant.get({
      id: text(input.id),
    });
    if (byId) return compatibleParticipant(byId, input);
  }
  const [byExternal] = await context.collections.participant.queries
    .byExternalId({
      externalId: input.externalId,
    });
  if (!byExternal) {
    throw new Error(`Goal participant '${input.externalId}' was not found.`);
  }
  return compatibleParticipant(byExternal, input);
}

function compatibleParticipant(
  candidate: CollectionRecord,
  input: ParticipantInput,
): CollectionRecord {
  if (candidate.participantType !== input.participantType) {
    throw new Error(
      `Participant '${input.externalId}' has incompatible participantType.`,
    );
  }
  if (input.agentId && candidate.agentId !== input.agentId) {
    throw new Error(
      `Participant '${input.externalId}' belongs to another Agent.`,
    );
  }
  return candidate;
}

async function executeStartGoal(
  inputValue: GoalStartInput,
  context: ActionContext,
): Promise<GoalStartOutput> {
  const alias = text(inputValue.goal, "Goal Resource alias");
  const resource = goalResource(context, alias);
  if (resource.stopAction) configuredAction(context, resource.stopAction);
  if (resource.evaluateAction) {
    configuredAction(context, resource.evaluateAction);
  }
  const targetAgent = agentResource(context, resource.target);
  const leadAgent = agentResource(context, resource.lead);
  const judgeAgent = resource.judge
    ? agentResource(context, resource.judge.agent)
    : null;
  const goalId = text(inputValue.id) ||
    await deriveWorkflowId("goal", context.action.runId);
  const senderInput = senderParticipant(inputValue.sender);
  const targetInput = agentParticipant(targetAgent);
  const leadInput: ParticipantInput = {
    externalId: `${goalId}:lead-input`,
    participantType: "human",
    name: targetAgent.name,
    metadata: goalMetadata(goalId, "lead", 1),
  };
  const leadAgentInput = agentParticipant(leadAgent);
  const sharedMetadata = goalMetadata(
    goalId,
    "target",
    1,
    inputValue.metadata,
  );
  const targetThread = await ensureThread(context, {
    id: `${goalId}:target`,
    descriptor: inputValue.thread,
    participants: [senderInput, targetInput],
    metadata: sharedMetadata,
    operation: "target",
    goalId,
  });
  const leadThread = await ensureThread(context, {
    id: `${goalId}:lead`,
    participants: [leadInput, leadAgentInput],
    metadata: goalMetadata(goalId, "lead", 1, inputValue.metadata),
    operation: "lead",
    goalId,
  });
  const [sender, target, leadSender, lead] = await Promise.all([
    participant(context, senderInput),
    participant(context, targetInput),
    participant(context, leadInput),
    participant(context, leadAgentInput),
  ]);
  const initialMessageId = `${goalId}:target:1:input`;
  const prepared = await context.content.prepare(
    goalContent(inputValue.content),
    {
      operationKey: `goal:${goalId}:target:1:content`,
      origin: {
        type: "goal",
        id: goalId,
      },
    },
  );
  const startedAt = context.now().toISOString();
  await context.transaction(async (transaction) => {
    await transaction.collections.goal.create({
      id: goalId,
      resourceAlias: alias,
      resource,
      status: "running",
      phase: "target",
      turn: 1,
      maxTurns: resource.maxTurns,
      correlationId: context.identity.correlationId ?? goalId,
      threadId: targetThread.id,
      leadThreadId: leadThread.id,
      judgeThreadId: null,
      senderParticipantId: sender.id,
      targetAgentId: targetAgent.id,
      targetParticipantId: target.id,
      leadAgentId: leadAgent.id,
      leadInputParticipantId: leadSender.id,
      leadParticipantId: lead.id,
      judgeInputParticipantId: null,
      judgeAgentId: judgeAgent?.id ?? null,
      judgeParticipantId: null,
      expectedThreadId: targetThread.id,
      expectedParticipantId: target.id,
      awaitingMessageId: initialMessageId,
      responseMessageId: null,
      plan: null,
      transcript: [{
        phase: "target",
        turn: 1,
        inputMessageId: initialMessageId,
      }],
      finalMessageId: null,
      judgeMessageId: null,
      pendingStatus: null,
      pendingReason: null,
      transitionClaimId: null,
      stopStatus: "idle",
      stopRequestId: null,
      stopAttempt: 0,
      stopDecision: null,
      evaluationStatus: "idle",
      evaluationRequestId: null,
      evaluationAttempt: 0,
      inputContent: prepared,
      assessments: [],
      resultContent: [],
      score: null,
      metrics: {
        durationMs: 0,
        targetRuns: 1,
        leadRuns: 0,
        judgeRuns: 0,
        messages: 0,
        errors: 0,
      },
      metadata: structuredClone(inputValue.metadata ?? {}),
      startedAt,
      finishedAt: null,
    }, {
      operationKey: `goal:${goalId}:create`,
      identity: {
        correlationId: context.identity.correlationId ?? goalId,
        metadata: { goalId },
      },
      visibility: { kind: "internal" },
    });
    await transaction.collections.message.create({
      id: initialMessageId,
      threadId: targetThread.id,
      senderId: sender.id,
      recipientIds: [target.id],
      content: prepared,
      metadata: sharedMetadata,
    }, {
      operationKey: `goal:${goalId}:target:1:message`,
      threadId: targetThread.id,
      routing: { senderId: sender.id, recipientIds: [target.id] },
      visibility: { kind: "public" },
      identity: {
        correlationId: context.identity.correlationId ?? goalId,
        metadata: sharedMetadata,
      },
    });
  }, {
    operationKey: `goal:${goalId}:start`,
    identity: {
      correlationId: context.identity.correlationId ?? goalId,
      metadata: { goalId },
    },
  });
  return Object.freeze({
    goalId,
    status: "running",
    phase: "target",
    turn: 1,
    awaitingMessageId: initialMessageId,
  });
}

type GoalMessageAcceptance = Readonly<{
  goalId?: string;
  kind: "ignored" | "plan" | "tool" | "response";
}>;

type GoalMessageAcceptanceInput = Readonly<{ messageId: string }>;

type GoalAwaitedFailureInput = Readonly<{
  triggerMessageId: string;
  threadId: string;
  participantId: string;
  agentId: string;
  status: "failed" | "cancelled";
  reason?: string;
}>;

type GoalAwaitedFailureOutput = Readonly<{
  goalId?: string;
  status: string;
}>;

type GoalAdvanceInput = Readonly<{ goalId: string }>;

type GoalAdvanceOutput = Readonly<{
  goalId: string;
  status: GoalStatus;
  phase: string;
}>;

async function messageAgentId(
  context: ActionContext,
  message: CollectionRecord,
): Promise<string> {
  const sender = await context.collections.participant.get({
    id: text(message.senderId, "Message sender ID"),
  });
  if (!sender || sender.participantType !== "agent") return "";
  return text(sender.agentId) || text(sender.externalId);
}

async function executeAcceptGoalMessage(
  input: GoalMessageAcceptanceInput,
  context: ActionContext,
): Promise<GoalMessageAcceptance> {
  const messageId = text(input.messageId, "Message ID");
  const message = await context.collections.message.get({ id: messageId });
  if (!message) return { kind: "ignored" };
  const metadata = record(message.metadata);
  const workflow = workflowMetadata(metadata);
  if (!workflow) return { kind: "ignored" };

  if (workflow.kind === "tool_result") {
    const step = await finalToolStep(context, messageId);
    if (!step) return { kind: "ignored" };
    const causal = await resolveGoalCausality(context, {
      sourceMessageId: messageId,
      threadId: step.threadId,
      participantId: step.participantId,
      agentId: step.agentId,
    });
    if (!causal) return { kind: "ignored" };
    await context.collections.goal.commands.advanceToolCursor({
      id: causal.goal.id,
      anchors: causal.anchors,
      plan: step.plan,
      toolResultMessageId: messageId,
      threadId: step.threadId,
      participantId: step.participantId,
    }, {
      operationKey:
        `goal:${causal.goal.id}:tool:${step.plan.planId}:${messageId}`,
      threadId: step.threadId,
      visibility: { kind: "internal" },
      identity: { correlationId: causal.goal.correlationId },
    });
    return { goalId: causal.goal.id, kind: "tool" };
  }

  if (
    workflow.kind !== "agent_output" || !workflow.sourceMessageId ||
    !workflow.agentParticipantId ||
    workflow.agentParticipantId !== message.senderId
  ) return { kind: "ignored" };
  const agentId = await messageAgentId(context, message);
  if (!agentId) return { kind: "ignored" };
  const causal = await resolveGoalCausality(context, {
    sourceMessageId: workflow.sourceMessageId,
    threadId: text(message.threadId),
    participantId: workflow.agentParticipantId,
    agentId,
  });
  if (!causal) return { kind: "ignored" };
  const plan = coreToolPlanMetadata(metadata);
  if (plan) {
    await context.collections.goal.commands.recordPlan({
      id: causal.goal.id,
      anchors: causal.anchors,
      plan: {
        planId: plan.planId,
        planMessageId: messageId,
        triggerMessageId: workflow.sourceMessageId,
        planSize: plan.planSize,
      },
      threadId: message.threadId,
      participantId: message.senderId,
    }, {
      operationKey: `goal:${causal.goal.id}:plan:${plan.planId}`,
      threadId: text(message.threadId),
      visibility: { kind: "internal" },
      identity: { correlationId: causal.goal.correlationId },
    });
    return { goalId: causal.goal.id, kind: "plan" };
  }
  await context.collections.goal.commands.recordResponse({
    id: causal.goal.id,
    anchors: causal.anchors,
    messageId,
    threadId: message.threadId,
    participantId: message.senderId,
  }, {
    operationKey: `goal:${causal.goal.id}:response:${messageId}`,
    threadId: text(message.threadId),
    visibility: { kind: "internal" },
    identity: { correlationId: causal.goal.correlationId },
  });
  return { goalId: causal.goal.id, kind: "response" };
}

async function executeFailGoalAwaited(
  input: GoalAwaitedFailureInput,
  context: ActionContext,
): Promise<GoalAwaitedFailureOutput> {
  const causal = await resolveGoalCausality(context, {
    sourceMessageId: text(input.triggerMessageId, "LLM trigger Message ID"),
    threadId: text(input.threadId, "LLM thread ID"),
    participantId: text(input.participantId, "LLM participant ID"),
    agentId: text(input.agentId, "LLM Agent ID"),
  });
  if (!causal) return { status: "ignored" };
  if (input.status === "cancelled") {
    const before = causal.goal.status;
    const updated = asGoalRecord(
      await context.collections.goal.commands.cancelAwaited({
        id: causal.goal.id,
        anchors: causal.anchors,
        threadId: input.threadId,
        participantId: input.participantId,
        reason: input.reason ?? "The awaited model call was cancelled.",
        finishedAt: context.now().toISOString(),
      }, {
        operationKey:
          `goal:${causal.goal.id}:llm-cancel:${input.triggerMessageId}`,
        visibility: { kind: "internal" },
        identity: { correlationId: causal.goal.correlationId },
      }),
    );
    return {
      goalId: causal.goal.id,
      status: updated.status === before ? "ignored" : updated.status,
    };
  }
  await context.collections.goal.commands.failAwaited({
    id: causal.goal.id,
    anchors: causal.anchors,
    threadId: input.threadId,
    participantId: input.participantId,
    reason: input.reason ?? "The awaited model call failed.",
  }, {
    operationKey: `goal:${causal.goal.id}:llm-fail:${input.triggerMessageId}`,
    visibility: { kind: "internal" },
    identity: { correlationId: causal.goal.correlationId },
  });
  return { goalId: causal.goal.id, status: "error" };
}

async function executeCancelGoal(
  input: GoalCancelInput,
  context: ActionContext,
): Promise<GoalCancelOutput> {
  const goalId = text(input.goalId, "Goal ID");
  const currentValue = await context.collections.goal.get({ id: goalId });
  if (!currentValue) throw new Error(`Goal '${goalId}' was not found.`);
  const current = asGoalRecord(currentValue);
  if (current.status !== "running") {
    return Object.freeze({
      goalId,
      status: current.status,
    });
  }
  const updated = asGoalRecord(
    await context.collections.goal.commands.cancel({
      id: goalId,
      reason: input.reason,
      finishedAt: context.now().toISOString(),
    }, {
      operationKey: `goal:${goalId}:cancel`,
      visibility: { kind: "internal" },
      identity: { correlationId: current.correlationId },
    }),
  );
  if (updated.status === "running") {
    throw new Error(`Goal '${goalId}' cancellation did not settle.`);
  }
  return Object.freeze({
    goalId,
    status: updated.status,
  });
}

function messageContent(value: CollectionRecord): ContentSequence {
  return Object.freeze(
    (Array.isArray(value.content) ? value.content : []).map((entry) =>
      structuredClone(entry)
    ) as ContentRef[],
  );
}

async function requiredMessage(
  context: ActionContext,
  id: string,
): Promise<CollectionRecord> {
  const value = await context.collections.message.get({ id });
  if (!value) {
    throw new GoalInvariantError(`Goal Message '${id}' was not found.`);
  }
  return value;
}

function phaseVisibility(
  phase: "target" | "lead" | "judge",
  senderId: string,
  participantId: string,
) {
  return phase === "target" ? { kind: "public" as const } : {
    kind: "participants" as const,
    participantIds: [senderId, participantId],
  };
}

async function createPhaseMessage(
  context: ActionContext,
  goal: GoalRecord,
  input: Readonly<{
    claimId: string;
    phase: "target" | "lead" | "judge";
    turn: number;
    threadId: string;
    senderId: string;
    participantId: string;
    content: DurableContentInput;
    pendingStatus?: Exclude<GoalTerminalStatus, "cancelled">;
    pendingReason?: string;
    judgeThreadId?: string;
    judgeInputParticipantId?: string;
    judgeParticipantId?: string;
    extraErrors?: number;
  }>,
): Promise<GoalRecord> {
  const messageId = `${goal.id}:${input.phase}:${input.turn}:input`;
  const metadata = goalMetadata(
    goal.id,
    input.phase,
    input.turn,
    goal.metadata,
  );
  const operation = `goal:${goal.id}:advance:${input.phase}:${input.turn}:${
    goal.responseMessageId ?? "failure"
  }`;
  await context.transaction(async (transaction) => {
    await transaction.collections.goal.commands.advance({
      id: goal.id,
      claimId: input.claimId,
      expectedPhase: goal.phase,
      expectedTurn: goal.turn,
      expectedResponseMessageId: goal.responseMessageId,
      phase: input.phase,
      turn: input.turn,
      inputMessageId: messageId,
      threadId: input.threadId,
      participantId: input.participantId,
      ...(input.pendingStatus ? { pendingStatus: input.pendingStatus } : {}),
      ...(input.pendingReason ? { pendingReason: input.pendingReason } : {}),
      ...(input.judgeThreadId ? { judgeThreadId: input.judgeThreadId } : {}),
      ...(input.judgeInputParticipantId
        ? { judgeInputParticipantId: input.judgeInputParticipantId }
        : {}),
      ...(input.judgeParticipantId
        ? { judgeParticipantId: input.judgeParticipantId }
        : {}),
      ...(input.extraErrors ? { extraErrors: input.extraErrors } : {}),
    }, {
      operationKey: `${operation}:state`,
      threadId: input.threadId,
      visibility: { kind: "internal" },
      identity: { correlationId: goal.correlationId },
    });
    await transaction.collections.message.create({
      id: messageId,
      threadId: input.threadId,
      senderId: input.senderId,
      recipientIds: [input.participantId],
      content: input.content,
      metadata,
    }, {
      operationKey: `${operation}:message`,
      threadId: input.threadId,
      routing: {
        senderId: input.senderId,
        recipientIds: [input.participantId],
      },
      visibility: phaseVisibility(
        input.phase,
        input.senderId,
        input.participantId,
      ),
      identity: {
        correlationId: goal.correlationId,
        metadata,
      },
    });
  }, {
    operationKey: operation,
    identity: {
      correlationId: goal.correlationId,
      metadata: { goalId: goal.id, phase: input.phase, turn: input.turn },
    },
  });
  const updated = await context.collections.goal.get({ id: goal.id });
  if (!updated) {
    throw new GoalInvariantError(
      `Goal '${goal.id}' disappeared after advance.`,
    );
  }
  return asGoalRecord(updated);
}

function safeTranscriptRef(ref: ContentRef): boolean {
  return ref.role !== "reasoning" && !ref.role.startsWith("tool.") &&
    ref.role !== "provider.trace";
}

async function prepareJudgePrompt(
  context: ActionContext,
  goal: GoalRecord,
): Promise<PreparedContent> {
  const instructions = goal.resource.judge?.instructions ??
    "Assess the goal transcript and provide the requested evaluation evidence.";
  const prompt: ContentInput[] = [
    { type: "text", text: instructions, role: "body" },
  ];
  const seen = new Set<string>();
  for (const coordinate of goal.transcript) {
    if (coordinate.phase === "judge") continue;
    for (
      const [kind, messageId] of [
        ["input", coordinate.inputMessageId],
        ["output", coordinate.outputMessageId],
      ] as const
    ) {
      if (!messageId || seen.has(messageId)) continue;
      seen.add(messageId);
      const message = await requiredMessage(context, messageId);
      const refs = messageContent(message).filter(safeTranscriptRef);
      prompt.push({
        type: "json",
        value: {
          goalId: goal.id,
          phase: coordinate.phase,
          turn: coordinate.turn,
          kind,
          messageId,
        },
        role: "body",
        name: `goal-${coordinate.phase}-${coordinate.turn}-${kind}.json`,
      }, ...refs);
    }
  }
  return await context.content.prepare(prompt, {
    operationKey: `goal:${goal.id}:judge:${goal.turn}:content`,
    origin: {
      type: "goal",
      id: goal.id,
    },
  });
}

async function startJudge(
  context: ActionContext,
  goal: GoalRecord,
  candidate: Readonly<{
    status: Exclude<GoalTerminalStatus, "cancelled">;
    reason?: string;
    extraErrors?: number;
  }>,
  claimId: string,
): Promise<GoalRecord> {
  if (!goal.resource.judge || !goal.judgeAgentId) {
    throw new GoalInvariantError(`Goal '${goal.id}' has no configured judge.`);
  }
  const judgeInput: ParticipantInput = {
    externalId: `${goal.id}:judge-input`,
    participantType: "human",
    name: "Goal transcript evaluator",
    metadata: goalMetadata(goal.id, "judge", goal.turn, goal.metadata),
  };
  const judgeAgent: ParticipantInput = {
    externalId: goal.judgeAgentId,
    participantType: "agent",
    agentId: goal.judgeAgentId,
    name: goal.judgeAgentId,
  };
  const judgeThread = await ensureThread(context, {
    id: `${goal.id}:judge`,
    participants: [judgeInput, judgeAgent],
    metadata: goalMetadata(goal.id, "judge", goal.turn, goal.metadata),
    operation: "judge",
    goalId: goal.id,
  });
  const [judgeSender, judge] = await Promise.all([
    participant(context, judgeInput),
    participant(context, judgeAgent),
  ]);
  const prompt = await prepareJudgePrompt(context, goal);
  return await createPhaseMessage(context, goal, {
    claimId,
    phase: "judge",
    turn: goal.turn,
    threadId: judgeThread.id,
    senderId: judgeSender.id,
    participantId: judge.id,
    content: prompt,
    pendingStatus: candidate.status,
    ...(candidate.reason ? { pendingReason: candidate.reason } : {}),
    ...(candidate.extraErrors ? { extraErrors: candidate.extraErrors } : {}),
    judgeThreadId: judgeThread.id,
    judgeInputParticipantId: judgeSender.id,
    judgeParticipantId: judge.id,
  });
}

export function stopActionInput(goal: GoalRecord): GoalStopActionInput {
  if (!goal.responseMessageId) {
    throw new GoalInvariantError(
      `Goal '${goal.id}' has no target response for its stop request.`,
    );
  }
  return Object.freeze({
    goalId: goal.id,
    turn: goal.turn,
    finalMessageId: goal.responseMessageId,
    resource: goal.resource,
    ...(goal.resource.stopPolicy === undefined
      ? {}
      : { policy: goal.resource.stopPolicy }),
  });
}

export function evaluationCandidate(goal: GoalRecord): Readonly<{
  status: Exclude<GoalTerminalStatus, "cancelled">;
  reason?: string;
}> {
  return Object.freeze(
    goal.pendingStatus
      ? {
        status: goal.pendingStatus,
        ...(goal.pendingReason ? { reason: goal.pendingReason } : {}),
      }
      : {
        status: "error" as const,
        reason: "Goal evaluation was requested without a terminal candidate.",
      },
  );
}

export function evaluationActionInput(
  goal: GoalRecord,
): GoalEvaluateActionInput {
  const candidate = evaluationCandidate(goal);
  return Object.freeze({
    goal: Object.freeze({
      id: goal.id,
      resource: goal.resource,
      turn: goal.turn,
      maxTurns: goal.maxTurns,
      threadId: goal.threadId,
      leadThreadId: goal.leadThreadId,
      ...(goal.judgeThreadId ? { judgeThreadId: goal.judgeThreadId } : {}),
      transcript: goal.transcript,
      pendingStatus: candidate.status,
      ...(candidate.reason ? { pendingReason: candidate.reason } : {}),
    }),
    ...(goal.finalMessageId ? { finalMessageId: goal.finalMessageId } : {}),
    ...(goal.judgeMessageId ? { judgeMessageId: goal.judgeMessageId } : {}),
    ...(goal.resource.evaluatePolicy === undefined
      ? {}
      : { policy: goal.resource.evaluatePolicy }),
  });
}

const STOP_OUTPUT_KEYS = new Set(["stop", "status", "reason"]);

export function normalizeStopOutput(value: unknown): GoalStopDecision {
  const item = exactDataRecord(
    value,
    STOP_OUTPUT_KEYS,
    "Goal stop Action output",
  );
  if (typeof item.stop !== "boolean") {
    throw new TypeError("Goal stop Action must return { stop: boolean }.");
  }
  const status = item.status === undefined ? undefined : exactRefText(
    item.status,
    "Goal stop Action status",
  ) as GoalStopActionOutput["status"];
  if (
    status && !["completed", "failed", "stopped", "error"].includes(status)
  ) {
    throw new TypeError(
      `Goal stop Action returned invalid status '${status}'.`,
    );
  }
  return Object.freeze({
    stop: item.stop,
    ...(status ? { status } : {}),
    ...(item.reason === undefined
      ? {}
      : { reason: exactRefText(item.reason, "Goal stop Action reason") }),
  });
}

const CONTENT_REF_KEYS = new Set([
  "assetId",
  "kind",
  "role",
  "mediaType",
  "name",
  "alt",
  "language",
  "disposition",
  "metadata",
]);

function exactDataRecord(
  value: unknown,
  keys: ReadonlySet<string>,
  label: string,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be a plain object.`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${label} must be a plain object.`);
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !keys.has(key)) {
      throw new TypeError(`${label} contains an unknown field.`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      !descriptor?.enumerable || !("value" in descriptor) ||
      descriptor.value === undefined
    ) {
      throw new TypeError(`${label}.${key} must be an enumerable data value.`);
    }
  }
  return value as Record<string, unknown>;
}

function exactArray(value: unknown, label: string): readonly unknown[] {
  if (
    !Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype
  ) {
    throw new TypeError(`${label} must be a plain array.`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    Object.keys(value).length !== value.length ||
    Reflect.ownKeys(value).some((key) =>
      key !== "length" &&
      (typeof key !== "string" || !/^(0|[1-9][0-9]*)$/.test(key) ||
        Number(key) >= value.length)
    )
  ) throw new TypeError(`${label} must be a dense array without extras.`);
  const result: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      throw new TypeError(`${label}[${index}] must be a data value.`);
    }
    result.push(descriptor.value);
  }
  return result;
}

function exactRefText(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim() || value !== value.trim()) {
    throw new TypeError(`${label} must be a canonical non-empty string.`);
  }
  return value;
}

function optionalRefText(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new TypeError(`${label} must be text.`);
  return value;
}

function contentRefs(value: unknown, label: string): ContentSequence {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value)) {
    throw new TypeError(`${label} must be ContentRefs.`);
  }
  return Object.freeze(
    exactArray(value, label).map((entry, index) => {
      const item = exactDataRecord(
        entry,
        CONTENT_REF_KEYS,
        `${label}[${index}]`,
      );
      const assetId = exactRefText(item.assetId, `${label}[${index}].assetId`);
      const kind = exactRefText(item.kind, `${label}[${index}].kind`);
      if (!["text", "json", "image", "audio", "video", "file"].includes(kind)) {
        throw new TypeError(`${label}[${index}].kind is invalid.`);
      }
      const role = exactRefText(item.role, `${label}[${index}].role`);
      const mediaType = exactRefText(
        item.mediaType,
        `${label}[${index}].mediaType`,
      );
      if (
        item.disposition !== undefined && item.disposition !== "inline" &&
        item.disposition !== "attachment"
      ) throw new TypeError(`${label}[${index}].disposition is invalid.`);
      let metadata: GoalAssessment["metadata"] | undefined;
      if (item.metadata !== undefined) {
        exactDataRecord(
          item.metadata,
          new Set(Object.keys(item.metadata as object)),
          `${label}[${index}].metadata`,
        );
        metadata = cloneGoalJson(
          item.metadata as never,
          `${label}[${index}].metadata`,
        ) as GoalAssessment["metadata"];
      }
      return Object.freeze({
        assetId,
        kind: kind as ContentRef["kind"],
        role,
        mediaType,
        ...(item.name === undefined
          ? {}
          : { name: optionalRefText(item.name, `${label}[${index}].name`)! }),
        ...(item.alt === undefined
          ? {}
          : { alt: optionalRefText(item.alt, `${label}[${index}].alt`)! }),
        ...(item.language === undefined ? {} : {
          language: optionalRefText(
            item.language,
            `${label}[${index}].language`,
          )!,
        }),
        ...(item.disposition === undefined
          ? {}
          : { disposition: item.disposition }),
        ...(metadata ? { metadata } : {}),
      }) as ContentRef;
    }),
  );
}

const ASSESSMENT_KEYS = new Set([
  "name",
  "status",
  "score",
  "report",
  "metadata",
]);
const EVALUATION_WRAPPER_KEYS = new Set([
  "assessments",
  "status",
  "reason",
  "score",
  "report",
]);

function assessment(value: unknown): GoalAssessment {
  const item = exactDataRecord(
    value,
    ASSESSMENT_KEYS,
    "Goal assessment",
  );
  const status = exactRefText(item.status, "Goal assessment status");
  if (!["completed", "failed", "warning"].includes(status)) {
    throw new TypeError(`Goal assessment has invalid status '${status}'.`);
  }
  if (
    item.score !== undefined &&
    (typeof item.score !== "number" || !Number.isFinite(item.score))
  ) {
    throw new TypeError("Goal assessment score must be finite.");
  }
  let metadata: GoalAssessment["metadata"] = Object.freeze({});
  if (item.metadata !== undefined) {
    exactDataRecord(
      item.metadata,
      new Set(Object.keys(item.metadata as object)),
      "Goal assessment metadata",
    );
    metadata = cloneGoalJson(
      item.metadata as never,
      "Goal assessment metadata",
    ) as GoalAssessment["metadata"];
  }
  return Object.freeze({
    ...(item.name === undefined
      ? {}
      : { name: exactRefText(item.name, "Goal assessment name") }),
    status: status as GoalAssessment["status"],
    ...(typeof item.score === "number" ? { score: item.score } : {}),
    report: contentRefs(item.report, "Goal assessment report"),
    metadata,
  });
}

export type GoalEvaluation = Readonly<{
  status: Exclude<GoalTerminalStatus, "cancelled">;
  reason?: string;
  score?: number;
  assessments: readonly GoalAssessment[];
  report: ContentSequence;
  extraErrors: number;
}>;

export function normalizeEvaluation(
  value: unknown,
  candidate: Readonly<{
    status: Exclude<GoalTerminalStatus, "cancelled">;
    reason?: string;
  }>,
): GoalEvaluation {
  let rawAssessments: readonly unknown[] = [];
  let explicitStatus: Exclude<GoalTerminalStatus, "cancelled"> | undefined;
  let reason = candidate.reason;
  let explicitScore: number | undefined;
  let topReport: ContentSequence = Object.freeze([]);
  if (Array.isArray(value)) {
    rawAssessments = exactArray(value, "Goal assessments");
  } else if (value !== undefined && value !== null) {
    const candidateObject = exactDataRecord(
      value,
      Object.hasOwn(value as object, "assessments")
        ? EVALUATION_WRAPPER_KEYS
        : ASSESSMENT_KEYS,
      "Goal evaluation output",
    );
    const item = candidateObject;
    if (Object.hasOwn(item, "assessments")) {
      rawAssessments = Array.isArray(item.assessments)
        ? exactArray(item.assessments, "Goal assessments")
        : [item.assessments];
      const status = item.status === undefined
        ? undefined
        : exactRefText(item.status, "Goal evaluation status");
      if (status) {
        if (
          ![
            "completed",
            "failed",
            "stopped",
            "error",
          ].includes(status)
        ) {
          throw new TypeError(`Goal evaluation status '${status}' is invalid.`);
        }
        explicitStatus = status as Exclude<GoalTerminalStatus, "cancelled">;
      }
      if (item.reason !== undefined) {
        reason = exactRefText(item.reason, "Goal evaluation reason");
      }
      if (item.score !== undefined) {
        if (typeof item.score !== "number" || !Number.isFinite(item.score)) {
          throw new TypeError("Goal evaluation score must be finite.");
        }
        explicitScore = item.score;
      }
      topReport = contentRefs(item.report, "Goal evaluation report");
    } else {
      rawAssessments = [item];
    }
  }
  const normalized = Object.freeze(rawAssessments.map(assessment));
  const scores = normalized.flatMap((item) =>
    item.score === undefined ? [] : [item.score]
  );
  const report = Object.freeze([
    ...topReport,
    ...normalized.flatMap((item) => [...item.report]),
  ]);
  const hasEvaluation = normalized.length > 0 || explicitScore !== undefined ||
    topReport.length > 0;
  const status = normalized.some((item) => item.status === "failed")
    ? "failed"
    : explicitStatus ?? (hasEvaluation ? "completed" : candidate.status);
  return Object.freeze({
    status,
    ...(reason ? { reason } : {}),
    ...(explicitScore !== undefined
      ? { score: explicitScore }
      : scores.length
      ? { score: scores.reduce((sum, score) => sum + score, 0) / scores.length }
      : {}),
    assessments: normalized,
    report,
    extraErrors: 0,
  });
}

type TerminalCandidate = Readonly<{
  status: Exclude<GoalTerminalStatus, "cancelled">;
  reason?: string;
  extraErrors?: number;
  bypassEvaluation?: boolean;
}>;

export function evaluationError(reason: string): GoalEvaluation {
  return Object.freeze({
    status: "error",
    reason,
    assessments: Object.freeze([]),
    report: Object.freeze([]),
    extraErrors: 1,
  });
}

async function commitSettlement(
  context: ActionContext,
  goal: GoalRecord,
  evaluation: GoalEvaluation,
  ownership: Readonly<{
    transitionClaimId?: string;
    evaluationRequestId?: string;
  }>,
  extraErrors = 0,
): Promise<GoalRecord> {
  const finishedAt = context.now().toISOString();
  const startedAtMs = new Date(goal.startedAt).getTime();
  const metrics: GoalMetrics = {
    ...goal.metrics,
    durationMs: Math.max(0, new Date(finishedAt).getTime() - startedAtMs),
    errors: goal.metrics.errors + extraErrors + evaluation.extraErrors,
  };
  try {
    const updated = await context.collections.goal.commands.settle({
      id: goal.id,
      ...ownership,
      expectedPhase: goal.phase,
      expectedTurn: goal.turn,
      expectedResponseMessageId: goal.responseMessageId,
      status: evaluation.status,
      ...(evaluation.reason ? { reason: evaluation.reason } : {}),
      ...(evaluation.score === undefined ? {} : { score: evaluation.score }),
      assessments: evaluation.assessments,
      resultContent: evaluation.report,
      metrics,
      finishedAt,
    }, {
      operationKey: `goal:${goal.id}:settle:${goal.phase}:${goal.turn}:${
        goal.responseMessageId ?? "failure"
      }`,
      visibility: { kind: "internal" },
      identity: { correlationId: goal.correlationId },
    });
    return asGoalRecord(updated);
  } catch (error) {
    const latestValue = await context.collections.goal.get({ id: goal.id });
    if (!latestValue) throw error;
    const latest = asGoalRecord(latestValue);
    if (latest.status !== "running") return latest;
    if (
      ownership.transitionClaimId &&
      latest.transitionClaimId === ownership.transitionClaimId
    ) {
      await releaseTransition(context, latest, ownership.transitionClaimId);
    }
    throw error;
  }
}

async function requestEvaluation(
  context: ActionContext,
  goal: GoalRecord,
  candidate: TerminalCandidate,
  claimId: string,
): Promise<GoalRecord> {
  const requestId = `goal:${goal.id}:evaluation:${goal.phase}:${goal.turn}:${
    goal.responseMessageId ?? "failure"
  }:attempt:1`;
  const updated = await context.collections.goal.commands.requestEvaluation({
    id: goal.id,
    claimId,
    expectedPhase: goal.phase,
    expectedTurn: goal.turn,
    expectedResponseMessageId: goal.responseMessageId,
    requestId,
    status: candidate.status,
    ...(candidate.reason ? { reason: candidate.reason } : {}),
    extraErrors: candidate.extraErrors ?? 0,
  }, {
    operationKey: `goal:${goal.id}:evaluation-request:${requestId}`,
    visibility: { kind: "internal" },
    identity: { correlationId: goal.correlationId },
  });
  return asGoalRecord(updated);
}

async function releaseTransition(
  context: ActionContext,
  goal: GoalRecord,
  claimId: string,
): Promise<void> {
  await context.collections.goal.commands.releaseTransition({
    id: goal.id,
    claimId,
  }, {
    operationKey: `goal:${goal.id}:transition-release:${claimId}`,
    visibility: { kind: "internal" },
    identity: { correlationId: goal.correlationId },
  });
}

async function settleWithoutEvaluation(
  context: ActionContext,
  goal: GoalRecord,
  candidate: TerminalCandidate,
  claimId: string,
): Promise<GoalRecord> {
  return await commitSettlement(
    context,
    goal,
    normalizeEvaluation(undefined, candidate),
    { transitionClaimId: claimId },
    candidate.extraErrors ?? 0,
  );
}

async function terminalCandidate(
  context: ActionContext,
  goal: GoalRecord,
  candidate: TerminalCandidate,
  claimId: string,
): Promise<GoalRecord> {
  if (candidate.bypassEvaluation) {
    return await settleWithoutEvaluation(context, goal, candidate, claimId);
  }
  if (goal.resource.judge && goal.phase !== "judge") {
    return await startJudge(context, goal, candidate, claimId);
  }
  if (goal.resource.evaluateAction) {
    return await requestEvaluation(context, goal, candidate, claimId);
  }
  return await settleWithoutEvaluation(context, goal, candidate, claimId);
}

async function targetCandidate(
  context: ActionContext,
  goal: GoalRecord,
  claimId: string,
): Promise<
  | Readonly<{
    status: Exclude<GoalTerminalStatus, "cancelled">;
    reason?: string;
    extraErrors?: number;
  }>
  | "requested"
  | null
> {
  if (goal.pendingStatus === "error") {
    return { status: "error", reason: goal.pendingReason ?? undefined };
  }
  if (!goal.responseMessageId) {
    return { status: "error", reason: "Target produced no final Message." };
  }
  let decision: GoalStopDecision = { stop: false };
  if (goal.resource.stopAction) {
    if (goal.stopStatus === "idle") {
      const requestId =
        `goal:${goal.id}:stop:${goal.turn}:${goal.responseMessageId}:attempt:1`;
      await context.collections.goal.commands.requestStop({
        id: goal.id,
        claimId,
        expectedTurn: goal.turn,
        expectedResponseMessageId: goal.responseMessageId,
        requestId,
      }, {
        operationKey: `goal:${goal.id}:stop-request:${requestId}`,
        visibility: { kind: "internal" },
        identity: { correlationId: goal.correlationId },
      });
      return "requested";
    }
    if (goal.stopStatus === "requested") return "requested";
    if (!goal.stopDecision) {
      return {
        status: "error",
        reason: "Goal stop Action resolved without a durable decision.",
        extraErrors: 1,
      };
    }
    decision = goal.stopDecision;
  }
  if (decision.stop) {
    return {
      status: decision.status ?? "stopped",
      ...(decision.reason ? { reason: decision.reason } : {}),
      ...(decision.operationalError ? { bypassEvaluation: true } : {}),
    };
  }
  if (goal.turn >= goal.maxTurns) {
    return {
      status: "stopped",
      reason: `Maximum turns reached (${goal.maxTurns}).`,
    };
  }
  return null;
}

async function recoverTransitionFailure(
  context: ActionContext,
  goal: GoalRecord,
  claimId: string,
  error: unknown,
): Promise<GoalRecord> {
  const latestValue = await context.collections.goal.get({ id: goal.id });
  if (!latestValue) {
    throw new Error(`Goal '${goal.id}' disappeared during recovery.`);
  }
  const latest = asGoalRecord(latestValue);
  if (latest.status !== "running" || latest.transitionClaimId !== claimId) {
    return latest;
  }
  if (
    !isSettledActionError(error) && !(error instanceof TypeError) &&
    !(error instanceof GoalInvariantError)
  ) {
    await releaseTransition(context, latest, claimId);
    throw error;
  }
  const candidate: TerminalCandidate = {
    status: "error",
    reason: `Goal transition failed: ${errorMessage(error)}`,
    extraErrors: 1,
  };
  // A judge transition may itself be the failed side effect. Recovery therefore
  // bypasses judge creation but still uses the configured durable evaluation.
  return latest.resource.evaluateAction
    ? await requestEvaluation(context, latest, candidate, claimId)
    : await settleWithoutEvaluation(context, latest, candidate, claimId);
}

async function executeAdvanceGoal(
  input: GoalAdvanceInput,
  context: ActionContext,
): Promise<GoalAdvanceOutput> {
  const goalId = text(input.goalId, "Goal ID");
  const value = await context.collections.goal.get({ id: goalId });
  if (!value) throw new Error(`Goal '${goalId}' was not found.`);
  let goal = asGoalRecord(value);
  if (goal.status !== "running" || goal.phase === "done") {
    return { goalId, status: goal.status, phase: goal.phase };
  }
  if (!goal.responseMessageId && goal.pendingStatus !== "error") {
    return { goalId, status: goal.status, phase: goal.phase };
  }
  if (goal.evaluationStatus !== "idle") {
    return { goalId, status: goal.status, phase: goal.phase };
  }

  const claimId = context.action.runId;
  goal = asGoalRecord(
    await context.collections.goal.commands.claimTransition({
      id: goalId,
      claimId,
      expectedPhase: goal.phase,
      expectedTurn: goal.turn,
      expectedResponseMessageId: goal.responseMessageId,
    }, {
      operationKey:
        `goal:${goalId}:transition-claim:${goal.phase}:${goal.turn}:${
          goal.responseMessageId ?? "failure"
        }:${claimId}`,
      visibility: { kind: "internal" },
      identity: { correlationId: goal.correlationId },
    }),
  );
  if (goal.status !== "running" || goal.transitionClaimId !== claimId) {
    return { goalId, status: goal.status, phase: goal.phase };
  }

  try {
    if (goal.phase === "target") {
      const candidate = await targetCandidate(context, goal, claimId);
      if (candidate === "requested") {
        return { goalId, status: goal.status, phase: goal.phase };
      }
      if (candidate) {
        const updated = await terminalCandidate(
          context,
          goal,
          candidate,
          claimId,
        );
        return { goalId, status: updated.status, phase: updated.phase };
      }
      const response = await requiredMessage(context, goal.responseMessageId!);
      const updated = await createPhaseMessage(context, goal, {
        claimId,
        phase: "lead",
        turn: goal.turn,
        threadId: goal.leadThreadId,
        senderId: goal.leadInputParticipantId,
        participantId: goal.leadParticipantId,
        // Exact accepted final Message refs; no tool/reasoning event projection.
        content: messageContent(response),
      });
      return { goalId, status: updated.status, phase: updated.phase };
    }

    if (goal.phase === "lead") {
      if (goal.pendingStatus === "error" || !goal.responseMessageId) {
        const updated = await terminalCandidate(context, goal, {
          status: "error",
          reason: goal.pendingReason ?? "Lead produced no final Message.",
        }, claimId);
        return { goalId, status: updated.status, phase: updated.phase };
      }
      const response = await requiredMessage(context, goal.responseMessageId);
      const updated = await createPhaseMessage(context, goal, {
        claimId,
        phase: "target",
        turn: goal.turn + 1,
        threadId: goal.threadId,
        senderId: goal.senderParticipantId,
        participantId: goal.targetParticipantId,
        // Exact accepted final Message refs; no re-preparation or body copy.
        content: messageContent(response),
      });
      return { goalId, status: updated.status, phase: updated.phase };
    }

    const candidate = goal.pendingStatus
      ? {
        status: goal.pendingStatus,
        ...(goal.pendingReason ? { reason: goal.pendingReason } : {}),
      }
      : { status: "completed" as const };
    const updated = await terminalCandidate(context, goal, candidate, claimId);
    return { goalId, status: updated.status, phase: updated.phase };
  } catch (error) {
    if (interrupted(error, context.signal)) {
      await releaseTransition(context, goal, claimId);
      throw error;
    }
    const updated = await recoverTransitionFailure(
      context,
      goal,
      claimId,
      error,
    );
    return { goalId, status: updated.status, phase: updated.phase };
  }
}

const advanceInputSchema = {
  type: "object",
  additionalProperties: false,
  properties: { goalId: { type: "string" } },
  required: ["goalId"],
} as const;

const startInputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    goal: { type: "string" },
    content: {},
    sender: { type: "object" },
    thread: { anyOf: [{ type: "string" }, { type: "object" }] },
    id: { type: "string" },
    metadata: { type: "object" },
  },
  required: ["goal", "content", "sender"],
} as const;

const idInputSchema = {
  type: "object",
  additionalProperties: false,
  properties: { messageId: { type: "string" } },
  required: ["messageId"],
} as const;

const failInputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    triggerMessageId: { type: "string" },
    threadId: { type: "string" },
    participantId: { type: "string" },
    agentId: { type: "string" },
    status: { type: "string", enum: ["failed", "cancelled"] },
    reason: { type: "string" },
  },
  required: [
    "triggerMessageId",
    "threadId",
    "participantId",
    "agentId",
    "status",
  ],
} as const;

const cancelInputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    goalId: { type: "string" },
    reason: { type: "string" },
  },
  required: ["goalId"],
} as const;

export const startGoalAction: ActionDefinition<
  GoalStartInput,
  GoalStartOutput,
  ActionContext,
  typeof startInputSchema,
  undefined
> = defineAction({
  id: START_GOAL_ACTION_ID,
  inputSchema: startInputSchema,
  execute: executeStartGoal,
});

export const acceptGoalMessageAction: ActionDefinition<
  GoalMessageAcceptanceInput,
  GoalMessageAcceptance,
  ActionContext,
  typeof idInputSchema,
  undefined
> = defineAction({
  id: ACCEPT_GOAL_MESSAGE_ACTION_ID,
  inputSchema: idInputSchema,
  execute: executeAcceptGoalMessage,
});

export const failGoalAwaitedAction: ActionDefinition<
  GoalAwaitedFailureInput,
  GoalAwaitedFailureOutput,
  ActionContext,
  typeof failInputSchema,
  undefined
> = defineAction({
  id: FAIL_GOAL_AWAITED_ACTION_ID,
  inputSchema: failInputSchema,
  execute: executeFailGoalAwaited,
});

export const advanceGoalAction: ActionDefinition<
  GoalAdvanceInput,
  GoalAdvanceOutput,
  ActionContext,
  typeof advanceInputSchema,
  undefined
> = defineAction({
  id: ADVANCE_GOAL_ACTION_ID,
  inputSchema: advanceInputSchema,
  execute: executeAdvanceGoal,
});

export const cancelGoalAction: ActionDefinition<
  GoalCancelInput,
  GoalCancelOutput,
  ActionContext,
  typeof cancelInputSchema,
  undefined
> = defineAction({
  id: CANCEL_GOAL_ACTION_ID,
  inputSchema: cancelInputSchema,
  execute: executeCancelGoal,
});
