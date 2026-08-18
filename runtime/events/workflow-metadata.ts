import type { WorkflowPipelineMetadata } from "../tools/types.ts";

const WORKFLOW_METADATA_KEY = "copilotzWorkflow";
const AGENT_ASK_METADATA_KEY = "copilotzAsk";

export type AgentAskPhase = "question" | "progress" | "answer";

/** Public causal metadata shared by every message in one agent ask. */
export type AgentAskMetadata = Readonly<{
  schema: "copilotz.ask.v1";
  askId: string;
  phase: AgentAskPhase;
  toolExecutionId: string;
  questionMessageId: string;
  askingParticipantId: string;
  askingAgentId: string;
  askedParticipantId: string;
  askedAgentId: string;
  callingAttemptId?: string;
  answerAttemptId?: string;
  parentAskId?: string;
  depth: number;
}>;

export type WorkflowMetadata = Readonly<{
  kind:
    | "agent_output"
    | "tool_execution"
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
    kind !== "tool_execution" && kind !== "provider_attempt" &&
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
export function agentAskMetadata(value: unknown): AgentAskMetadata | null {
  const outer = record(value);
  const candidate = record(outer[AGENT_ASK_METADATA_KEY]);
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
    ] as const
  ) {
    if (candidate[key] !== undefined && !optionalMetadataText(candidate[key])) {
      return null;
    }
  }
  return candidate as AgentAskMetadata;
}

export function providerAttemptEventMetadata(value: unknown): boolean {
  return workflowMetadata(value)?.kind === "provider_attempt";
}

export function textWorkflowAttemptEventMetadata(value: unknown): boolean {
  const kind = workflowMetadata(value)?.kind;
  return kind !== "provider_attempt" && kind !== "memory_consolidation";
}
