import type { EventVisibility } from "@copilotz/copilotz/events";

const WORKFLOW_METADATA_KEY = "copilotzWorkflow";
const AGENT_ASK_METADATA_KEY = "copilotzAsk";
const AGENT_ASK_RESULT_METADATA_KEY = "copilotzAskResult";
const TOOL_PLAN_METADATA_KEY = "copilotzToolPlan";
const TOOL_ACTION_METADATA_KEY = "copilotzToolAction";
const TOOL_PLAN_RESULT_METADATA_KEY = "copilotzToolPlanResult";
const AGENT_TURN_METADATA_KEY = "copilotzAgentTurn";
export const CORE_LLM_CALL_METADATA_SCHEMA = "copilotz.core.llm-call.v1";
export const CORE_TOOL_ACTION_METADATA_SCHEMA = "copilotz.core.tool-action.v1";
export const CORE_TOOL_PLAN_METADATA_SCHEMA = "copilotz.core.tool-plan.v1";
export const CORE_LLM_STREAM_METADATA_SCHEMA = "copilotz.core.llm-stream.v1";

export type AgentAskPhase = "question" | "progress" | "answer";
export type AgentAskMode = "public" | "private";

/** Public causal metadata shared by every message in one agent ask. */
export type AgentAskMetadata = Readonly<{
  schema: "copilotz.ask.v1";
  askId: string;
  phase: AgentAskPhase;
  /** Missing only on pre-mode rows; readers treat it as public. */
  mode?: AgentAskMode;
  toolActionRunId: string;
  toolCallId?: string;
  toolInvocation?: Readonly<Record<string, unknown>>;
  questionMessageId: string;
  askingParticipantId: string;
  askingAgentId: string;
  /** Captured display name; omitted only by pre-display-metadata asks. */
  askingAgentName?: string;
  askedParticipantId: string;
  askedAgentId: string;
  /** Captured display name; omitted only by pre-display-metadata asks. */
  askedAgentName?: string;
  callingAttemptId?: string;
  answerAttemptId?: string;
  parentAskId?: string;
  parentQuestionMessageId?: string;
  origin: CoreToolActionOrigin;
  depth: number;
}>;

/** Receipt attached to a projected Ask Tool result.  The Answer Message owns content. */
export type AgentAskResultMetadata = Readonly<{
  schema: "copilotz.ask-result.v1";
  askId: string;
  status: "completed" | "failed" | "cancelled";
  askedParticipantId: string;
  askedAgentId: string;
  answerMessageId?: string;
}>;

/** Generic caller-owned control for one private Agent turn. */
export type CoreAgentTurnMetadata = Readonly<{
  schema: "copilotz.core.agent-turn.v1";
  /** Opaque private transcript scope. */
  id: string;
  /** Only this participant may satisfy `completeOn`. */
  ownerParticipantId: string;
  /** Successful matching Action stops this turn only. */
  completeOn?: Readonly<{ action: string }>;
}>;

/** Durable Core provenance attached to one provider-neutral `llm.call`. */
export type CoreLlmCallMetadata = Readonly<{
  schema: typeof CORE_LLM_CALL_METADATA_SCHEMA;
  threadId: string;
  triggerMessageId: string;
  agentId: string;
  agentParticipantId: string;
  initiatorParticipantId: string;
  availableToolIds: readonly string[];
  /** Audience baseline for the projected assistant response. */
  responseVisibility: EventVisibility;
  parentActionRunId?: string;
  ask?: AgentAskMetadata;
  agentTurn?: CoreAgentTurnMetadata;
  /** Optional opaque prompt-policy revision, never resolved instructions. */
  instructionRevision?: string;
}>;

/** Opaque Core hint attached to each progressive LLM output stream. */
export type CoreLlmStreamMetadata = Readonly<{
  schema: typeof CORE_LLM_STREAM_METADATA_SCHEMA;
  agent: Readonly<{ id: string; name: string }>;
  ask?: Readonly<{
    askId: string;
    phase: AgentAskPhase;
    questionMessageId: string;
    askingAgent: Readonly<{ id: string; name: string }>;
    askedAgent: Readonly<{ id: string; name: string }>;
  }>;
}>;

/** Stable plan cursor retained by an ask while another agent answers. */
export type CoreToolActionOrigin = Readonly<{
  schema: typeof CORE_TOOL_ACTION_METADATA_SCHEMA;
  planId: string;
  planMessageId: string;
  planIndex: number;
  stageIndex: number;
  /** Immutable number of stages in this root branch (tools and jq). */
  stageCount: number;
  planSize: number;
  toolCallId: string;
  action: string;
  threadId: string;
  triggerMessageId: string;
  agentId: string;
  agentParticipantId: string;
  initiatorParticipantId: string;
  availableToolIds: readonly string[];
  /** Original response audience retained across every Tool continuation. */
  responseVisibility: EventVisibility;
  parentLlmActionRunId: string;
  agentTurn?: CoreAgentTurnMetadata;
}>;

/** Core provenance attached directly to each ordinary Tool Action call. */
export type CoreToolActionMetadata =
  & CoreToolActionOrigin
  & Readonly<{
    ask?: AgentAskMetadata;
  }>;

/** Self-contained provider-order plan persisted on its assistant Message. */
export type CoreToolPlanMetadata = Readonly<{
  schema: typeof CORE_TOOL_PLAN_METADATA_SCHEMA;
  planId: string;
  planSize: number;
}>;

/** Tool cursor embedded in a Message after one terminal Action lifecycle. */
export type CoreToolActionMessageMetadata =
  & CoreToolActionMetadata
  & Readonly<{
    actionRunId: string;
  }>;

/** Branch-result provenance when no Action lifecycle exists (e.g. unavailable root). */
export type CoreToolPlanResultMetadata = Readonly<{
  schema: "copilotz.core.tool-plan-result.v1";
  resultKind: "unavailable" | "pipeline_failure";
  origin: CoreToolActionOrigin;
  failedStageIndex: number;
  failedAction: string;
  sourceAction?: Readonly<{ stageIndex: number; actionRunId: string }>;
  ask?: AgentAskMetadata;
}>;

export function withCoreToolPlanResultMetadata(
  metadata: Readonly<Record<string, unknown>> | undefined,
  value: CoreToolPlanResultMetadata,
): Record<string, unknown> {
  return {
    ...structuredClone(metadata ?? {}),
    [TOOL_PLAN_RESULT_METADATA_KEY]: structuredClone(value),
  };
}
export function coreToolPlanResultMetadata(
  value: unknown,
): CoreToolPlanResultMetadata | null {
  const candidate = record(record(value)[TOOL_PLAN_RESULT_METADATA_KEY]);
  const keys = Object.keys(candidate);
  if (
    keys.some((key) =>
      ![
        "schema",
        "resultKind",
        "origin",
        "failedStageIndex",
        "failedAction",
        "sourceAction",
        "ask",
      ].includes(key)
    ) || candidate.schema !== "copilotz.core.tool-plan-result.v1" ||
    (candidate.resultKind !== "unavailable" &&
      candidate.resultKind !== "pipeline_failure") ||
    !coreToolActionOrigin(candidate.origin) ||
    !Number.isSafeInteger(candidate.failedStageIndex) ||
    Number(candidate.failedStageIndex) < 0 ||
    Number(candidate.failedStageIndex) >=
      Number((candidate.origin as CoreToolActionOrigin).stageCount) ||
    !optionalMetadataText(candidate.failedAction) ||
    (candidate.ask !== undefined && !validAgentAsk(record(candidate.ask)))
  ) return null;
  if (candidate.sourceAction !== undefined) {
    const source = record(candidate.sourceAction);
    if (
      Object.keys(source).length !== 2 ||
      !Number.isSafeInteger(source.stageIndex) ||
      Number(source.stageIndex) < 0 ||
      Number(source.stageIndex) >=
        Number((candidate.origin as CoreToolActionOrigin).stageCount) ||
      !optionalMetadataText(source.actionRunId)
    ) return null;
  }
  return candidate as CoreToolPlanResultMetadata;
}
/** Common durable plan cursor for action-backed and no-source branch results. */
export function coreToolResultOrigin(
  value: unknown,
): CoreToolActionOrigin | null {
  return coreToolActionMessageMetadata(value) ??
    coreToolPlanResultMetadata(value)?.origin ?? null;
}

export type WorkflowMetadata = Readonly<{
  kind:
    | "agent_output"
    | "tool_result"
    | "provider_attempt"
    | "realtime_message";
  continuation?: "text" | "realtime" | "none";
  realtimeStreamId?: string;
  llmAttemptId?: string;
  parentLlmAttemptId?: string;
  sourceMessageId?: string;
  agentParticipantId?: string;
  initiatorParticipantId?: string;
}>;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function optionalMetadataText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function withWorkflowMetadata(
  metadata: Readonly<Record<string, unknown>> | undefined,
  workflow: WorkflowMetadata,
): Record<string, unknown> {
  return {
    ...structuredClone(metadata ?? {}),
    [WORKFLOW_METADATA_KEY]: structuredClone(workflow),
  };
}

export function workflowMetadata(value: unknown): WorkflowMetadata | null {
  const outer = record(value);
  const candidate = record(outer[WORKFLOW_METADATA_KEY]);
  const kind = candidate.kind;
  if (
    kind !== "agent_output" && kind !== "tool_result" &&
    kind !== "provider_attempt" && kind !== "realtime_message"
  ) return null;
  if (
    candidate.initiatorParticipantId !== undefined &&
    !optionalMetadataText(candidate.initiatorParticipantId)
  ) return null;
  return candidate as WorkflowMetadata;
}

const AGENT_TURN_KEYS = new Set([
  "schema",
  "id",
  "ownerParticipantId",
  "completeOn",
]);

function validCoreAgentTurnMetadata(
  value: unknown,
): CoreAgentTurnMetadata | null {
  const candidate = record(value);
  if (
    Object.keys(candidate).some((key) => !AGENT_TURN_KEYS.has(key)) ||
    candidate.schema !== "copilotz.core.agent-turn.v1" ||
    !optionalMetadataText(candidate.id) ||
    !optionalMetadataText(candidate.ownerParticipantId)
  ) return null;
  if (candidate.completeOn !== undefined) {
    const completeOn = record(candidate.completeOn);
    if (
      Object.keys(completeOn).length !== 1 ||
      !optionalMetadataText(completeOn.action)
    ) return null;
  }
  return candidate as CoreAgentTurnMetadata;
}

/** Attaches validated generic turn control without replacing plugin metadata. */
export function withCoreAgentTurnMetadata(
  metadata: Readonly<Record<string, unknown>> | undefined,
  agentTurn: CoreAgentTurnMetadata,
): Record<string, unknown> {
  const validated = validCoreAgentTurnMetadata(agentTurn);
  if (!validated) throw new TypeError("Invalid Core Agent turn metadata.");
  return {
    ...structuredClone(metadata ?? {}),
    [AGENT_TURN_METADATA_KEY]: structuredClone(validated),
  };
}

/** Reads validated generic turn control from a durable Message. */
export function coreAgentTurnMetadata(
  value: unknown,
): CoreAgentTurnMetadata | null {
  return validCoreAgentTurnMetadata(
    record(value)[AGENT_TURN_METADATA_KEY],
  );
}

/** Adds one public ask descriptor without replacing unrelated metadata. */
export function withAgentAskMetadata(
  metadata: Readonly<Record<string, unknown>> | undefined,
  ask: AgentAskMetadata,
): Record<string, unknown> {
  return {
    ...structuredClone(metadata ?? {}),
    [AGENT_ASK_METADATA_KEY]: structuredClone(ask),
  };
}

/** Reads validated ask metadata from a domain record or event. */
const AGENT_ASK_KEYS = new Set([
  "schema",
  "askId",
  "phase",
  "mode",
  "toolActionRunId",
  "toolCallId",
  "toolInvocation",
  "questionMessageId",
  "askingParticipantId",
  "askingAgentId",
  "askingAgentName",
  "askedParticipantId",
  "askedAgentId",
  "askedAgentName",
  "callingAttemptId",
  "answerAttemptId",
  "parentAskId",
  "parentQuestionMessageId",
  "origin",
  "depth",
]);

function validAgentAsk(
  candidate: Record<string, unknown>,
): AgentAskMetadata | null {
  if (
    Object.keys(candidate).some((key) => !AGENT_ASK_KEYS.has(key)) ||
    candidate.schema !== "copilotz.ask.v1" ||
    (candidate.phase !== "question" && candidate.phase !== "progress" &&
      candidate.phase !== "answer") ||
    !Number.isSafeInteger(candidate.depth) || Number(candidate.depth) < 1
  ) return null;
  if (
    candidate.mode !== undefined && candidate.mode !== "public" &&
    candidate.mode !== "private"
  ) return null;
  const required = [
    "askId",
    "toolActionRunId",
    "questionMessageId",
    "askingParticipantId",
    "askingAgentId",
    "askedParticipantId",
    "askedAgentId",
  ] as const;
  if (required.some((key) => !optionalMetadataText(candidate[key]))) {
    return null;
  }
  for (
    const key of [
      "callingAttemptId",
      "answerAttemptId",
      "parentAskId",
      "parentQuestionMessageId",
      "toolCallId",
      "askingAgentName",
      "askedAgentName",
    ] as const
  ) {
    if (candidate[key] !== undefined && !optionalMetadataText(candidate[key])) {
      return null;
    }
  }
  const hasParentAsk = candidate.parentAskId !== undefined;
  const hasParentQuestion = candidate.parentQuestionMessageId !== undefined;
  if (hasParentAsk !== hasParentQuestion) return null;
  if (Number(candidate.depth) === 1 && hasParentAsk) return null;
  if (Number(candidate.depth) > 1 && !hasParentAsk) return null;
  if (
    candidate.toolInvocation !== undefined &&
    (typeof candidate.toolInvocation !== "object" ||
      candidate.toolInvocation === null ||
      Array.isArray(candidate.toolInvocation))
  ) return null;
  if (!coreToolActionOrigin(candidate.origin)) return null;
  return candidate as AgentAskMetadata;
}

export function agentAskMetadata(value: unknown): AgentAskMetadata | null {
  return validAgentAsk(record(record(value)[AGENT_ASK_METADATA_KEY]));
}

export function withAgentAskResultMetadata(
  metadata: Readonly<Record<string, unknown>> | undefined,
  result: AgentAskResultMetadata,
): Record<string, unknown> {
  const validated = agentAskResultMetadata({
    [AGENT_ASK_RESULT_METADATA_KEY]: result,
  });
  if (!validated) throw new TypeError("Invalid Ask result metadata.");
  return {
    ...structuredClone(metadata ?? {}),
    [AGENT_ASK_RESULT_METADATA_KEY]: structuredClone(validated),
  };
}

export function agentAskResultMetadata(
  value: unknown,
): AgentAskResultMetadata | null {
  const candidate = record(record(value)[AGENT_ASK_RESULT_METADATA_KEY]);
  const allowed = new Set([
    "schema",
    "askId",
    "status",
    "askedParticipantId",
    "askedAgentId",
    "answerMessageId",
  ]);
  if (
    Object.keys(candidate).some((key) => !allowed.has(key)) ||
    candidate.schema !== "copilotz.ask-result.v1" ||
    (candidate.status !== "completed" && candidate.status !== "failed" &&
      candidate.status !== "cancelled") ||
    !optionalMetadataText(candidate.askId) ||
    !optionalMetadataText(candidate.askedParticipantId) ||
    !optionalMetadataText(candidate.askedAgentId)
  ) return null;
  if (
    candidate.answerMessageId !== undefined &&
    !optionalMetadataText(candidate.answerMessageId)
  ) return null;
  if (
    candidate.status === "completed" !==
      (candidate.answerMessageId !== undefined)
  ) {
    return null;
  }
  return candidate as AgentAskResultMetadata;
}

/**
 * Produces transport-safe, semantic stream hints without making streams a Core
 * primitive. The question itself remains the immutable Core Message referenced
 * by `questionMessageId`; reasoning and content remain distinct runtime lanes.
 */
export function coreLlmStreamMetadata(
  agent: Readonly<{ id: string; name: string }>,
  ask?: AgentAskMetadata,
): Readonly<{ copilotzCore: CoreLlmStreamMetadata }> {
  const agentId = optionalMetadataText(agent.id);
  const agentName = optionalMetadataText(agent.name);
  if (!agentId || !agentName) {
    throw new TypeError(
      "Core LLM stream metadata requires an agent ID and name.",
    );
  }
  const metadata: CoreLlmStreamMetadata = Object.freeze({
    schema: CORE_LLM_STREAM_METADATA_SCHEMA,
    agent: Object.freeze({ id: agentId, name: agentName }),
    ...(ask
      ? {
        ask: Object.freeze({
          askId: ask.askId,
          phase: ask.phase,
          questionMessageId: ask.questionMessageId,
          askingAgent: Object.freeze({
            id: ask.askingAgentId,
            name: ask.askingAgentName ?? ask.askingAgentId,
          }),
          askedAgent: Object.freeze({
            id: ask.askedAgentId,
            name: ask.askedAgentName ?? ask.askedAgentId,
          }),
        }),
      }
      : {}),
  });
  return Object.freeze({ copilotzCore: metadata });
}

const CORE_LLM_CALL_KEYS = new Set([
  "schema",
  "threadId",
  "triggerMessageId",
  "agentId",
  "agentParticipantId",
  "initiatorParticipantId",
  "availableToolIds",
  "responseVisibility",
  "parentActionRunId",
  "ask",
  "agentTurn",
  "instructionRevision",
]);

/** Reads the self-contained provenance of a Core-owned `llm.call`. */
export function coreLlmCallMetadata(
  value: unknown,
): CoreLlmCallMetadata | null {
  const candidate = record(value);
  if (candidate.schema !== CORE_LLM_CALL_METADATA_SCHEMA) return null;
  if (
    Reflect.ownKeys(candidate).some((key) =>
      typeof key !== "string" || !CORE_LLM_CALL_KEYS.has(key)
    )
  ) return null;
  const required = [
    "threadId",
    "triggerMessageId",
    "agentId",
    "agentParticipantId",
    "initiatorParticipantId",
  ] as const;
  if (required.some((key) => !optionalMetadataText(candidate[key]))) {
    return null;
  }
  if (
    candidate.parentActionRunId !== undefined &&
    !optionalMetadataText(candidate.parentActionRunId)
  ) return null;
  if (
    candidate.instructionRevision !== undefined &&
    !optionalMetadataText(candidate.instructionRevision)
  ) return null;
  if (
    !Array.isArray(candidate.availableToolIds) ||
    candidate.availableToolIds.some((value) => !optionalMetadataText(value)) ||
    new Set(candidate.availableToolIds).size !==
      candidate.availableToolIds.length
  ) return null;
  if (!coreEventVisibility(candidate.responseVisibility)) return null;
  if (
    candidate.ask !== undefined &&
    !validAgentAsk(record(candidate.ask))
  ) return null;
  const agentTurn = candidate.agentTurn === undefined
    ? undefined
    : validCoreAgentTurnMetadata(candidate.agentTurn);
  if (candidate.agentTurn !== undefined && !agentTurn) return null;
  if (
    agentTurn?.completeOn &&
    !candidate.availableToolIds.includes(agentTurn.completeOn.action)
  ) return null;
  return candidate as CoreLlmCallMetadata;
}

/** Validates and freezes ordinary Core LLM Action-call metadata. */
export function defineCoreLlmCallMetadata(
  value: CoreLlmCallMetadata,
): CoreLlmCallMetadata {
  const copy = structuredClone(value);
  const validated = coreLlmCallMetadata(copy);
  if (!validated) throw new TypeError("Invalid Core LLM call metadata.");
  return Object.freeze({
    ...validated,
    availableToolIds: Object.freeze([...validated.availableToolIds]),
    responseVisibility: freezeCoreEventVisibility(
      validated.responseVisibility,
    ),
    ...(validated.ask ? { ask: Object.freeze(validated.ask) } : {}),
    ...(validated.agentTurn
      ? { agentTurn: Object.freeze(structuredClone(validated.agentTurn)) }
      : {}),
  });
}

function coreEventVisibility(value: unknown): value is EventVisibility {
  const candidate = record(value);
  const keys = Object.keys(candidate).sort();
  if (candidate.kind === "public" || candidate.kind === "internal") {
    return keys.length === 1 && keys[0] === "kind";
  }
  if (candidate.kind === "participants") {
    return keys.length === 2 && keys[0] === "kind" &&
      keys[1] === "participantIds" &&
      validStringArray(candidate.participantIds);
  }
  return candidate.kind === "tool" && keys.length === 3 &&
    keys[0] === "kind" && keys[1] === "policy" &&
    keys[2] === "requesterId" &&
    (candidate.policy === "requester_only" ||
      candidate.policy === "public_status" || candidate.policy === "public") &&
    Boolean(optionalMetadataText(candidate.requesterId));
}

function freezeCoreEventVisibility(value: EventVisibility): EventVisibility {
  return value.kind === "participants"
    ? Object.freeze({
      kind: "participants",
      participantIds: Object.freeze([...value.participantIds]),
    })
    : Object.freeze({ ...value });
}

function validStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) &&
    value.every((entry) => Boolean(optionalMetadataText(entry))) &&
    new Set(value).size === value.length;
}

function validPlanPosition(candidate: Record<string, unknown>): boolean {
  return Number.isSafeInteger(candidate.planIndex) &&
    Number(candidate.planIndex) >= 0 &&
    Number.isSafeInteger(candidate.planSize) &&
    Number(candidate.planSize) > 0 &&
    Number(candidate.planIndex) < Number(candidate.planSize);
}

const TOOL_ACTION_ORIGIN_KEYS = new Set([
  "schema",
  "planId",
  "planMessageId",
  "planIndex",
  "stageIndex",
  "stageCount",
  "planSize",
  "toolCallId",
  "action",
  "threadId",
  "triggerMessageId",
  "agentId",
  "agentParticipantId",
  "initiatorParticipantId",
  "availableToolIds",
  "responseVisibility",
  "parentLlmActionRunId",
  "agentTurn",
]);

function validToolActionOrigin(
  candidate: Record<string, unknown>,
): CoreToolActionOrigin | null {
  if (candidate.schema !== CORE_TOOL_ACTION_METADATA_SCHEMA) return null;
  const required = [
    "planId",
    "planMessageId",
    "toolCallId",
    "action",
    "threadId",
    "triggerMessageId",
    "agentId",
    "agentParticipantId",
    "initiatorParticipantId",
    "parentLlmActionRunId",
  ] as const;
  if (
    required.some((key) => !optionalMetadataText(candidate[key])) ||
    !validPlanPosition(candidate) ||
    !Number.isSafeInteger(candidate.stageIndex) ||
    Number(candidate.stageIndex) < 0 ||
    !Number.isSafeInteger(candidate.stageCount) ||
    Number(candidate.stageCount) < 1 ||
    Number(candidate.stageIndex) >= Number(candidate.stageCount) ||
    !validStringArray(candidate.availableToolIds) ||
    !coreEventVisibility(candidate.responseVisibility)
  ) return null;
  const agentTurn = candidate.agentTurn === undefined
    ? undefined
    : validCoreAgentTurnMetadata(candidate.agentTurn);
  if (candidate.agentTurn !== undefined && !agentTurn) return null;
  if (
    agentTurn?.completeOn &&
    !candidate.availableToolIds.includes(agentTurn.completeOn.action)
  ) return null;
  return candidate as CoreToolActionOrigin;
}

/** Reads the non-recursive durable cursor of one Tool Action call. */
export function coreToolActionOrigin(
  value: unknown,
): CoreToolActionOrigin | null {
  const candidate = record(value);
  if (Object.keys(candidate).some((key) => !TOOL_ACTION_ORIGIN_KEYS.has(key))) {
    return null;
  }
  return validToolActionOrigin(candidate);
}

/** Reads validated Core Tool Action provenance from lifecycle data. */
export function coreToolActionMetadata(
  value: unknown,
): CoreToolActionMetadata | null {
  const candidate = record(value);
  if (
    Object.keys(candidate).some((key) =>
      key !== "ask" && !TOOL_ACTION_ORIGIN_KEYS.has(key)
    )
  ) return null;
  const origin = validToolActionOrigin(candidate);
  if (!origin) return null;
  if (
    candidate.ask !== undefined &&
    !validAgentAsk(record(candidate.ask))
  ) return null;
  return candidate as CoreToolActionMetadata;
}

/** Validates and freezes metadata before invoking a Tool Action. */
export function defineCoreToolActionMetadata(
  value: CoreToolActionMetadata,
): CoreToolActionMetadata {
  const copy = structuredClone(value);
  const validated = coreToolActionMetadata(copy);
  if (!validated) throw new TypeError("Invalid Core Tool Action metadata.");
  return Object.freeze({
    ...validated,
    availableToolIds: Object.freeze([...validated.availableToolIds]),
    responseVisibility: freezeCoreEventVisibility(
      validated.responseVisibility,
    ),
    ...(validated.ask ? { ask: Object.freeze(validated.ask) } : {}),
    ...(validated.agentTurn
      ? { agentTurn: Object.freeze(structuredClone(validated.agentTurn)) }
      : {}),
  });
}

/** Drops recursive ask state before retaining a plan cursor in an ask. */
export function coreToolActionOriginFrom(
  metadata: CoreToolActionMetadata,
): CoreToolActionOrigin {
  const { ask: _ask, ...origin } = metadata;
  return Object.freeze(structuredClone(origin));
}

/** Embeds one Tool plan cursor in a Core Message without changing its shape. */
export function withCoreToolActionMessageMetadata(
  metadata: Readonly<Record<string, unknown>> | undefined,
  value: CoreToolActionMetadata,
  actionRunId: string,
): Record<string, unknown> {
  const validated = coreToolActionMetadata(value);
  if (!validated) throw new TypeError("Invalid Core Tool Action metadata.");
  const runId = optionalMetadataText(actionRunId);
  if (!runId) throw new TypeError("Tool Action run ID must be non-empty.");
  return {
    ...structuredClone(metadata ?? {}),
    [TOOL_ACTION_METADATA_KEY]: {
      ...structuredClone(validated),
      actionRunId: runId,
    },
  };
}

/** Reads the Tool plan cursor embedded in a Core Message. */
export function coreToolActionMessageMetadata(
  value: unknown,
): CoreToolActionMessageMetadata | null {
  const candidate = record(record(value)[TOOL_ACTION_METADATA_KEY]);
  const actionRunId = optionalMetadataText(candidate.actionRunId);
  if (!actionRunId) return null;
  const { actionRunId: _actionRunId, ...rawMetadata } = candidate;
  const metadata = coreToolActionMetadata(rawMetadata);
  if (!metadata) return null;
  return candidate as CoreToolActionMessageMetadata;
}

/** Stores a complete immutable Tool plan on its assistant Message. */
export function withCoreToolPlanMetadata(
  metadata: Readonly<Record<string, unknown>> | undefined,
  plan: CoreToolPlanMetadata,
): Record<string, unknown> {
  const validated = validCoreToolPlanMetadata(record(plan));
  if (!validated) throw new TypeError("Invalid Core Tool plan metadata.");
  return {
    ...structuredClone(metadata ?? {}),
    [TOOL_PLAN_METADATA_KEY]: structuredClone(validated),
  };
}

/** Reads and validates the complete Tool plan persisted on a Message. */
export function coreToolPlanMetadata(
  value: unknown,
): CoreToolPlanMetadata | null {
  const candidate = record(record(value)[TOOL_PLAN_METADATA_KEY]);
  return validCoreToolPlanMetadata(candidate);
}

function validCoreToolPlanMetadata(
  candidate: Record<string, unknown>,
): CoreToolPlanMetadata | null {
  if (
    Object.keys(candidate).some((key) =>
      key !== "schema" && key !== "planId" && key !== "planSize"
    ) ||
    candidate.schema !== CORE_TOOL_PLAN_METADATA_SCHEMA ||
    !optionalMetadataText(candidate.planId) ||
    !Number.isSafeInteger(candidate.planSize) ||
    Number(candidate.planSize) < 1
  ) return null;
  return candidate as CoreToolPlanMetadata;
}

export function providerAttemptEventMetadata(value: unknown): boolean {
  return workflowMetadata(value)?.kind === "provider_attempt";
}

export function textWorkflowAttemptEventMetadata(value: unknown): boolean {
  const kind = workflowMetadata(value)?.kind;
  return kind !== "provider_attempt";
}
