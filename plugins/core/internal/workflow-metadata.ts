import type { WorkflowPipelineMetadata } from "@copilotz/copilotz/tools";

const WORKFLOW_METADATA_KEY = "copilotzWorkflow";
const AGENT_ASK_METADATA_KEY = "copilotzAsk";
export const CORE_LLM_CALL_METADATA_SCHEMA = "copilotz.core.llm-call.v1";

export type AgentAskPhase = "question" | "progress" | "answer";

/** Public causal metadata shared by every message in one agent ask. */
export type AgentAskMetadata = Readonly<{
  schema: "copilotz.ask.v1";
  askId: string;
  phase: AgentAskPhase;
  toolExecutionId: string;
  toolCallId?: string;
  toolInvocation?: Readonly<Record<string, unknown>>;
  questionMessageId: string;
  askingParticipantId: string;
  askingAgentId: string;
  askedParticipantId: string;
  askedAgentId: string;
  callingAttemptId?: string;
  answerAttemptId?: string;
  parentAskId?: string;
  parentAsk?: AgentAskMetadata;
  depth: number;
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
  parentActionRunId?: string;
  ask?: AgentAskMetadata;
}>;

export type WorkflowMetadata = Readonly<{
  kind:
    | "agent_output"
    | "tool_action"
    | "tool_result"
    | "provider_attempt"
    | "memory_consolidation"
    | "realtime_message";
  continuation?: "text" | "realtime" | "none";
  realtimeStreamId?: string;
  llmAttemptId?: string;
  parentLlmAttemptId?: string;
  toolExecutionId?: string;
  toolCallId?: string;
  batchId?: string;
  batchSize?: number;
  batchIndex?: number;
  sourceMessageId?: string;
  agentParticipantId?: string;
  pipeline?: WorkflowPipelineMetadata;
  pipelineFailure?: Readonly<{ stageIndex: number; message: string }>;
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
    kind !== "tool_action" && kind !== "provider_attempt" &&
    kind !== "memory_consolidation" && kind !== "realtime_message"
  ) return null;
  return candidate as WorkflowMetadata;
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
function validAgentAsk(
  candidate: Record<string, unknown>,
): AgentAskMetadata | null {
  if (
    candidate.schema !== "copilotz.ask.v1" ||
    (candidate.phase !== "question" && candidate.phase !== "progress" &&
      candidate.phase !== "answer") ||
    !Number.isSafeInteger(candidate.depth) || Number(candidate.depth) < 1
  ) return null;
  const required = [
    "askId",
    "toolExecutionId",
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
      "toolCallId",
    ] as const
  ) {
    if (candidate[key] !== undefined && !optionalMetadataText(candidate[key])) {
      return null;
    }
  }
  if (
    candidate.parentAsk !== undefined &&
    !validAgentAsk(record(candidate.parentAsk))
  ) {
    return null;
  }
  return candidate as AgentAskMetadata;
}

export function agentAskMetadata(value: unknown): AgentAskMetadata | null {
  return validAgentAsk(record(record(value)[AGENT_ASK_METADATA_KEY]));
}

/** Reads the self-contained provenance of a Core-owned `llm.call`. */
export function coreLlmCallMetadata(
  value: unknown,
): CoreLlmCallMetadata | null {
  const candidate = record(value);
  if (candidate.schema !== CORE_LLM_CALL_METADATA_SCHEMA) return null;
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
    !Array.isArray(candidate.availableToolIds) ||
    candidate.availableToolIds.some((value) => !optionalMetadataText(value)) ||
    new Set(candidate.availableToolIds).size !==
      candidate.availableToolIds.length
  ) return null;
  if (
    candidate.ask !== undefined &&
    !validAgentAsk(record(candidate.ask))
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
    ...(validated.ask ? { ask: Object.freeze(validated.ask) } : {}),
  });
}

export function providerAttemptEventMetadata(value: unknown): boolean {
  return workflowMetadata(value)?.kind === "provider_attempt";
}

export function textWorkflowAttemptEventMetadata(value: unknown): boolean {
  const kind = workflowMetadata(value)?.kind;
  return kind !== "provider_attempt" && kind !== "memory_consolidation";
}
