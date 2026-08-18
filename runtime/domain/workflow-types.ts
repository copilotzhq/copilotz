import type {
  ContentSequence,
  DatabaseAssetRepository,
  DurableContentInput,
} from "../content/index.ts";
import {
  LLM_CONTENT_ROLE,
  llmAttemptContent,
  TOOL_CONTENT_ROLE,
  toolExecutionContent,
} from "../content/roles.ts";
import type {
  CoordinatedMutationResult,
  EventCoordinator,
  EventStore,
  EventVisibility,
  SqlExecutor,
} from "../events/index.ts";
import type { MutationIdentity } from "./types.ts";

export {
  LLM_CONTENT_ROLE,
  llmAttemptContent,
  TOOL_CONTENT_ROLE,
  toolExecutionContent,
};

export type SafeWorkflowError = Readonly<{
  name?: string;
  message: string;
  code?: string;
  retryable?: boolean;
  metadata?: Readonly<Record<string, unknown>>;
}>;

export type ToolExecutionStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export type ToolExecution = Readonly<{
  id: string;
  namespace: string;
  threadId: string;
  messageId?: string;
  participantId?: string;
  agentId?: string;
  toolCallId: string;
  tool: Readonly<Record<string, unknown>>;
  status: ToolExecutionStatus;
  content: ContentSequence;
  historyVisibility?: string;
  safeError?: SafeWorkflowError;
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
  metadata: Readonly<Record<string, unknown>>;
  createdAt: string;
  updatedAt: string;
}>;

export type CreateToolExecutionInput = Readonly<{
  namespace: string;
  id?: string;
  threadId: string;
  messageId?: string;
  participantId?: string;
  agentId?: string;
  toolCallId: string;
  tool: Record<string, unknown>;
  arguments: DurableContentInput;
  attachments?: DurableContentInput;
  status?: Extract<ToolExecutionStatus, "pending" | "running">;
  startedAt?: string | Date;
  historyVisibility?: string;
  visibility?: EventVisibility;
  metadata?: Record<string, unknown>;
  identity?: MutationIdentity;
}>;

export type UpdateToolExecutionInput = Readonly<{
  namespace: string;
  id: string;
  status?: Extract<ToolExecutionStatus, "pending" | "running">;
  projectedOutput?: DurableContentInput;
  attachments?: DurableContentInput;
  historyVisibility?: string;
  metadataPatch?: Record<string, unknown>;
  visibility?: EventVisibility;
  identity?: MutationIdentity;
}>;

export type CompleteToolExecutionInput = Readonly<{
  namespace: string;
  id: string;
  output?: DurableContentInput;
  projectedOutput?: DurableContentInput;
  attachments?: DurableContentInput;
  historyVisibility?: string;
  finishedAt?: string | Date;
  durationMs?: number;
  metadataPatch?: Record<string, unknown>;
  visibility?: EventVisibility;
  identity?: MutationIdentity;
}>;

export type FailToolExecutionInput = Readonly<{
  namespace: string;
  id: string;
  safeError: SafeWorkflowError;
  errorDetail?: DurableContentInput;
  projectedOutput?: DurableContentInput;
  historyVisibility?: string;
  finishedAt?: string | Date;
  durationMs?: number;
  metadataPatch?: Record<string, unknown>;
  visibility?: EventVisibility;
  identity?: MutationIdentity;
}>;

export type CancelToolExecutionInput = Readonly<{
  namespace: string;
  id: string;
  reason?: string;
  errorDetail?: DurableContentInput;
  projectedOutput?: DurableContentInput;
  historyVisibility?: string;
  finishedAt?: string | Date;
  durationMs?: number;
  metadataPatch?: Record<string, unknown>;
  visibility?: EventVisibility;
  identity?: MutationIdentity;
}>;

export type ToolExecutionRepository = Readonly<{
  create(
    input: CreateToolExecutionInput,
  ): Promise<CoordinatedMutationResult<ToolExecution>>;
  update(
    input: UpdateToolExecutionInput,
  ): Promise<CoordinatedMutationResult<ToolExecution>>;
  complete(
    input: CompleteToolExecutionInput,
  ): Promise<CoordinatedMutationResult<ToolExecution>>;
  fail(
    input: FailToolExecutionInput,
  ): Promise<CoordinatedMutationResult<ToolExecution>>;
  cancel(
    input: CancelToolExecutionInput,
  ): Promise<CoordinatedMutationResult<ToolExecution>>;
  get(namespace: string, id: string): Promise<ToolExecution | null>;
  /** Returns the latest execution carrying this provider call label. */
  getByToolCallId(
    namespace: string,
    threadId: string,
    toolCallId: string,
  ): Promise<ToolExecution | null>;
  /** Returns the execution for one exact source message and provider call. */
  getByMessageToolCallId(
    namespace: string,
    threadId: string,
    messageId: string,
    toolCallId: string,
  ): Promise<ToolExecution | null>;
  list(
    namespace: string,
    threadId: string,
    options?: { after?: string; limit?: number },
  ): Promise<readonly ToolExecution[]>;
}>;

export type LlmAttemptStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "superseded";

export type LlmAttempt = Readonly<{
  id: string;
  namespace: string;
  threadId: string;
  messageId?: string;
  participantId?: string;
  initiatorParticipantId?: string;
  agentId?: string;
  provider?: string;
  model?: string;
  status: LlmAttemptStatus;
  attemptIndex: number;
  parentAttemptId?: string;
  inputMessageIds: readonly string[];
  availableToolIds: readonly string[];
  content: ContentSequence;
  finishReason?: string;
  usage?: Readonly<Record<string, unknown>>;
  cost?: Readonly<Record<string, unknown>>;
  safeError?: SafeWorkflowError;
  startedAt: string;
  finishedAt?: string;
  metricsFinalizedAt?: string;
  metadata: Readonly<Record<string, unknown>>;
  createdAt: string;
  updatedAt: string;
}>;

export type CreateLlmAttemptInput = Readonly<{
  namespace: string;
  id?: string;
  threadId: string;
  messageId?: string;
  participantId?: string;
  initiatorParticipantId?: string;
  agentId?: string;
  provider?: string;
  model?: string;
  status?: Extract<LlmAttemptStatus, "pending" | "running">;
  attemptIndex?: number;
  parentAttemptId?: string;
  inputMessageIds?: readonly string[];
  availableToolIds?: readonly string[];
  input?: DurableContentInput;
  toolDefinitions?: DurableContentInput;
  trace?: DurableContentInput;
  startedAt?: string | Date;
  visibility?: EventVisibility;
  metadata?: Record<string, unknown>;
  identity?: MutationIdentity;
}>;

export type UpdateLlmAttemptInput = Readonly<{
  namespace: string;
  id: string;
  provider?: string;
  model?: string;
  status?: Extract<LlmAttemptStatus, "pending" | "running" | "superseded">;
  usage?: Record<string, unknown>;
  cost?: Record<string, unknown>;
  metricsFinalizedAt?: string | Date;
  trace?: DurableContentInput;
  metadataPatch?: Record<string, unknown>;
  visibility?: EventVisibility;
  identity?: MutationIdentity;
}>;

export type CompleteLlmAttemptInput = Readonly<{
  namespace: string;
  id: string;
  answer?: DurableContentInput;
  reasoning?: DurableContentInput;
  toolCalls?: DurableContentInput;
  trace?: DurableContentInput;
  finishReason?: string;
  usage?: Record<string, unknown>;
  cost?: Record<string, unknown>;
  finishedAt?: string | Date;
  metricsFinalizedAt?: string | Date;
  metadataPatch?: Record<string, unknown>;
  visibility?: EventVisibility;
  identity?: MutationIdentity;
}>;

export type FailLlmAttemptInput = Readonly<{
  namespace: string;
  id: string;
  safeError: SafeWorkflowError;
  answer?: DurableContentInput;
  reasoning?: DurableContentInput;
  errorDetail?: DurableContentInput;
  trace?: DurableContentInput;
  finishReason?: string;
  usage?: Record<string, unknown>;
  cost?: Record<string, unknown>;
  finishedAt?: string | Date;
  metadataPatch?: Record<string, unknown>;
  visibility?: EventVisibility;
  identity?: MutationIdentity;
}>;

export type CancelLlmAttemptInput = Readonly<{
  namespace: string;
  id: string;
  reason?: string;
  trace?: DurableContentInput;
  usage?: Record<string, unknown>;
  cost?: Record<string, unknown>;
  finishedAt?: string | Date;
  metricsFinalizedAt?: string | Date;
  metadataPatch?: Record<string, unknown>;
  visibility?: EventVisibility;
  identity?: MutationIdentity;
}>;

export type LlmAttemptRepository = Readonly<{
  create(
    input: CreateLlmAttemptInput,
  ): Promise<CoordinatedMutationResult<LlmAttempt>>;
  update(
    input: UpdateLlmAttemptInput,
  ): Promise<CoordinatedMutationResult<LlmAttempt>>;
  complete(
    input: CompleteLlmAttemptInput,
  ): Promise<CoordinatedMutationResult<LlmAttempt>>;
  fail(
    input: FailLlmAttemptInput,
  ): Promise<CoordinatedMutationResult<LlmAttempt>>;
  cancel(
    input: CancelLlmAttemptInput,
  ): Promise<CoordinatedMutationResult<LlmAttempt>>;
  get(namespace: string, id: string): Promise<LlmAttempt | null>;
  list(
    namespace: string,
    threadId: string,
    options?: { after?: string; limit?: number },
  ): Promise<readonly LlmAttempt[]>;
}>;

type WorkflowRepositoryOptions = Readonly<{
  coordinator: EventCoordinator;
  session: SqlExecutor;
  eventStore: Pick<EventStore, "tables">;
  assets: Pick<
    DatabaseAssetRepository,
    "materialize" | "resolvePrepared" | "linkOwner" | "syncOwner"
  >;
  createId?: () => string;
  now?: () => Date;
}>;

export type CreateToolExecutionRepositoryOptions = WorkflowRepositoryOptions;
export type CreateLlmAttemptRepositoryOptions = WorkflowRepositoryOptions;
