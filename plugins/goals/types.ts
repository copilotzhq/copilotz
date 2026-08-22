import type { CollectionRuntime } from "@copilotz/copilotz/collections";
import type {
  ContentInput,
  ContentResolver,
  ContentSequence,
} from "@copilotz/copilotz/content";
import type {
  ConversationThread,
  Participant,
  ParticipantInput,
} from "@copilotz/copilotz/domain";
import type { CopilotzEvent } from "@copilotz/copilotz/events";
import type { PluginRegistry } from "@copilotz/copilotz/plugins";
import type { FeatureHostContext } from "@copilotz/copilotz/features";
import type {
  ApplicationSendHandle,
  ApplicationSendInput,
} from "@copilotz/copilotz/application";

export type GoalStatus =
  | "completed"
  | "failed"
  | "stopped"
  | "cancelled"
  | "error";

export type GoalPhase = "target" | "lead" | "judge";

/** Human identity used in the tested thread plus its declared simulator agent. */
export type GoalSenderInput = Readonly<{
  usingAgent: string;
  id?: string;
  externalId?: string;
  name?: string;
  email?: string;
  metadata?: Record<string, unknown>;
}>;

/** Descriptor used when the goal should create its tested thread. */
export type GoalThreadInput = Readonly<{
  id?: string;
  externalId?: string;
  parentThreadId?: string;
  metadata?: Record<string, unknown>;
}>;

export type GoalThreadRef = string | ConversationThread | GoalThreadInput;

/** One canonical message observed while running a goal phase. */
export type GoalTranscriptMessage = Readonly<{
  messageId: string;
  threadId: string;
  turn: number;
  phase: GoalPhase;
  sender: Participant;
  content: ContentSequence;
  /** Text/JSON projection for stop rules, reports, and simple assertions. */
  text: string;
  metadata: Readonly<Record<string, unknown>>;
  createdAt: string;
}>;

/** Projection that adds goal coordinates without rewriting the canonical event. */
export type GoalObservedEvent = Readonly<{
  type: "goal.event";
  payload: Readonly<{
    goalId: string;
    turn: number;
    phase: GoalPhase;
    event: CopilotzEvent;
  }>;
}>;

export type GoalStopContext = Readonly<{
  id: string;
  turns: number;
  threadId: string;
  leadThreadId: string;
  transcript: readonly GoalTranscriptMessage[];
  events: readonly GoalObservedEvent[];
  lastMessage?: GoalTranscriptMessage;
  signal: AbortSignal;
}>;

export type GoalStopResult = Readonly<{
  stop: boolean;
  status?: GoalStatus;
  reason?: string;
}>;

export type GoalStopCallback = (
  context: GoalStopContext,
) =>
  | boolean
  | GoalStopResult
  | Promise<boolean | GoalStopResult>;

export type GoalAssessment = Readonly<{
  name?: string;
  status: "completed" | "failed" | "warning";
  score?: number;
  report?: string;
  metadata?: Record<string, unknown>;
}>;

/** Isolated judge invocation created through the same event-native run path. */
export type GoalJudgeRunInput = Readonly<{
  content: ContentInput | readonly ContentInput[];
  target: string;
  sender?: ParticipantInput;
  thread?: GoalThreadRef;
  correlationId?: string;
  metadata?: Record<string, unknown>;
}>;

export type GoalRunResult = Readonly<{
  handle: ApplicationSendHandle;
  events: readonly GoalObservedEvent[];
  finalMessage?: GoalTranscriptMessage;
  text: string;
}>;

export type GoalEvaluateContext = Readonly<{
  id: string;
  threadId: string;
  leadThreadId: string;
  turns: number;
  transcript: readonly GoalTranscriptMessage[];
  events: readonly GoalObservedEvent[];
  signal: AbortSignal;
  run(input: GoalJudgeRunInput): Promise<GoalRunResult>;
}>;

export type GoalEvaluateCallback = (
  context: GoalEvaluateContext,
) =>
  | GoalAssessment
  | readonly GoalAssessment[]
  | undefined
  | Promise<GoalAssessment | readonly GoalAssessment[] | undefined>;

export type GoalInput = Readonly<{
  namespace?: string;
  databaseSchema?: string;
  content: ContentInput | readonly ContentInput[];
  sender: GoalSenderInput;
  /** Stable ID of the declared agent resource under test. */
  target: string;
  /** Existing tested thread or a descriptor for a new one. */
  thread?: GoalThreadRef;
  maxTurns?: number;
  stop?: GoalStopCallback;
  evaluate?: GoalEvaluateCallback;
  metadata?: Record<string, unknown>;
  signal?: AbortSignal;
}>;

export type GoalStoppedEvent = Readonly<{
  type: "goal.stopped";
  payload: Readonly<{
    goalId: string;
    threadId: string;
    leadThreadId: string;
    turn: number;
    status: GoalStatus;
    reason?: string;
  }>;
}>;

export type GoalMetrics = Readonly<{
  durationMs: number;
  targetRuns: number;
  leadRuns: number;
  judgeRuns: number;
  messages: number;
  toolCalls: number;
  errors: number;
}>;

export type GoalResult = Readonly<{
  id: string;
  status: GoalStatus;
  score?: number;
  report?: string;
  reason?: string;
  threadId: string;
  leadThreadId: string;
  turns: number;
  transcript: readonly GoalTranscriptMessage[];
  events: readonly GoalObservedEvent[];
  assessments: readonly GoalAssessment[];
  metrics: GoalMetrics;
}>;

export type GoalResultEvent = Readonly<{
  type: "goal.result";
  payload: GoalResult;
}>;

export type GoalStreamEvent =
  | GoalObservedEvent
  | GoalStoppedEvent
  | GoalResultEvent;

export type GoalHandle = Readonly<{
  id: string;
  threadId: string;
  leadThreadId: string;
  status: "running";
  events: ReadableStream<GoalStreamEvent>;
  done: Promise<GoalResult>;
  cancel(reason?: string): Promise<void>;
}>;

export type GoalRuntime = Readonly<{
  goal(input: GoalInput): Promise<GoalHandle>;
  shutdown(reason?: string): Promise<void>;
}>;

export type CreateGoalRuntimeOptions = Readonly<{
  registry: Pick<PluginRegistry, "context">;
  collectionRuntime: CollectionRuntime;
  features(namespace: string): FeatureHostContext;
  resolver: Pick<ContentResolver, "getMany">;
  send(input: ApplicationSendInput): Promise<ApplicationSendHandle>;
  defaultNamespace?: string;
  defaultDatabaseSchema?: string;
  createId?: () => string;
  now?: () => Date;
}>;
