import type {
  AssetOrigin,
  ContentInput,
  ContentRef,
  ContentSequence,
} from "@copilotz/copilotz/content";

export type GoalJsonPrimitive = string | number | boolean | null;
export type GoalJsonValue =
  | GoalJsonPrimitive
  | readonly GoalJsonValue[]
  | Readonly<{ [key: string]: GoalJsonValue }>;

export type GoalMetadata = Readonly<Record<string, GoalJsonValue>>;

/** JSON-safe counterpart of ContentInput for durable application ingress. */
export type GoalContentInput =
  | string
  | ContentRef
  | Readonly<{
    type: "text";
    text: string;
    role?: string;
    mediaType?: string;
    name?: string;
    language?: string;
    metadata?: GoalMetadata;
    origin?: AssetOrigin;
  }>
  | Readonly<{
    type: "json";
    value: GoalJsonValue;
    role?: string;
    mediaType?: string;
    name?: string;
    metadata?: GoalMetadata;
    origin?: AssetOrigin;
  }>
  | Readonly<{
    type: "image" | "audio" | "video" | "file";
    dataBase64: string;
    mediaType: string;
    role?: string;
    name?: string;
    alt?: string;
    language?: string;
    disposition?: "inline" | "attachment";
    metadata?: GoalMetadata;
    origin?: AssetOrigin;
  }>;

export type GoalSenderInput = Readonly<{
  id?: string;
  externalId?: string;
  name?: string;
  email?: string;
  metadata?: GoalMetadata;
}>;

export type GoalThreadInput = Readonly<{
  id?: string;
  externalId?: string;
  parentThreadId?: string;
}>;

export type GoalThreadRef = string | GoalThreadInput;

export type GoalJudgeResource = Readonly<{
  /** Alias in resources.agents. */
  agent: string;
  instructions?: string;
}>;

/** Immutable, data-only orchestration policy contributed under resources.goals. */
export type GoalResource = Readonly<{
  /** Alias in resources.agents. */
  target: string;
  /** Alias in resources.agents. */
  lead: string;
  judge?: GoalJudgeResource;
  maxTurns: number;
  /** Optional alias in the composed Action map. */
  stopAction?: string;
  /** Optional alias in the composed Action map. */
  evaluateAction?: string;
  stopPolicy?: GoalJsonValue;
  evaluatePolicy?: GoalJsonValue;
}>;

/** Canonical snapshot retained by a Goal so restarts never reread config. */
export type GoalResourceSnapshot =
  & GoalResource
  & Readonly<{
    alias: string;
  }>;

export type GoalStatus =
  | "running"
  | "completed"
  | "failed"
  | "stopped"
  | "cancelled"
  | "error";

export type GoalTerminalStatus = Exclude<GoalStatus, "running">;
export type GoalPhase = "target" | "lead" | "judge" | "done";
export type GoalActivePhase = Exclude<GoalPhase, "done">;
export type GoalStopStatus = "idle" | "requested" | "resolved";
export type GoalEvaluationStatus = "idle" | "requested";

export type GoalTranscriptCoordinate = Readonly<{
  phase: GoalActivePhase;
  turn: number;
  inputMessageId: string;
  outputMessageId?: string;
}>;

export type GoalPlanCursor = Readonly<{
  planId: string;
  planMessageId: string;
  triggerMessageId: string;
  planSize: number;
}>;

export type GoalAssessmentStatus = "completed" | "failed" | "warning";

/** JSON-safe result returned by a configured evaluate Action. */
export type GoalAssessmentInput = Readonly<{
  name?: string;
  status: GoalAssessmentStatus;
  score?: number;
  /** Canonical refs materialized by the configured evaluate Action. */
  report?: ContentSequence;
  metadata?: GoalMetadata;
}>;

/** Persisted assessment; report bodies live in the Goal's resultContent. */
export type GoalAssessment = Readonly<{
  name?: string;
  status: GoalAssessmentStatus;
  score?: number;
  report: ContentSequence;
  metadata: GoalMetadata;
}>;

export type GoalStopActionInput = Readonly<{
  goalId: string;
  turn: number;
  finalMessageId: string;
  resource: GoalResourceSnapshot;
  policy?: GoalJsonValue;
}>;

export type GoalStopActionOutput = Readonly<{
  stop: boolean;
  status?: "completed" | "failed" | "stopped" | "error";
  reason?: string;
}>;

/** Normalized durable result of one configured stop Action request. */
export type GoalStopDecision = Readonly<{
  stop: boolean;
  status?: "completed" | "failed" | "stopped" | "error";
  reason?: string;
  /** Goals-owned marker; never accepted from configured Action output. */
  operationalError?: boolean;
}>;

export type GoalEvaluateActionInput = Readonly<{
  goal: Readonly<{
    id: string;
    resource: GoalResourceSnapshot;
    turn: number;
    maxTurns: number;
    threadId: string;
    leadThreadId: string;
    judgeThreadId?: string;
    transcript: readonly GoalTranscriptCoordinate[];
    pendingStatus: Exclude<GoalTerminalStatus, "cancelled">;
    pendingReason?: string;
  }>;
  finalMessageId?: string;
  judgeMessageId?: string;
  policy?: GoalJsonValue;
}>;

export type GoalEvaluateActionOutput =
  | GoalAssessmentInput
  | readonly GoalAssessmentInput[]
  | Readonly<{
    assessments: GoalAssessmentInput | readonly GoalAssessmentInput[];
    status?: "completed" | "failed" | "stopped" | "error";
    reason?: string;
    score?: number;
    report?: ContentSequence;
  }>
  | undefined;

export type GoalResult = Readonly<{
  goalId: string;
  status: GoalTerminalStatus;
  phase: "done";
  turns: number;
  finalMessageId?: string;
  judgeMessageId?: string;
  reason?: string;
  score?: number;
  assessments: readonly GoalAssessment[];
  report: ContentSequence;
  metrics: GoalMetrics;
  startedAt: string;
  finishedAt: string;
}>;

export type GoalMetrics = Readonly<{
  durationMs: number;
  targetRuns: number;
  leadRuns: number;
  judgeRuns: number;
  messages: number;
  errors: number;
}>;

/** The one durable aggregate owned by the Goals plugin. */
export type GoalRecord = Readonly<{
  id: string;
  namespace: string;
  resourceAlias: string;
  resource: GoalResourceSnapshot;
  status: GoalStatus;
  phase: GoalPhase;
  turn: number;
  maxTurns: number;
  correlationId: string;
  threadId: string;
  leadThreadId: string;
  judgeThreadId: string | null;
  senderParticipantId: string;
  targetAgentId: string;
  targetParticipantId: string;
  leadAgentId: string;
  leadInputParticipantId: string;
  leadParticipantId: string;
  judgeInputParticipantId: string | null;
  judgeAgentId: string | null;
  judgeParticipantId: string | null;
  expectedThreadId: string | null;
  expectedParticipantId: string | null;
  awaitingMessageId: string | null;
  responseMessageId: string | null;
  plan: GoalPlanCursor | null;
  transcript: readonly GoalTranscriptCoordinate[];
  finalMessageId: string | null;
  judgeMessageId: string | null;
  pendingStatus: Exclude<GoalTerminalStatus, "cancelled"> | null;
  pendingReason: string | null;
  transitionClaimId: string | null;
  stopStatus: GoalStopStatus;
  stopRequestId: string | null;
  stopAttempt: number;
  stopDecision: GoalStopDecision | null;
  evaluationStatus: GoalEvaluationStatus;
  evaluationRequestId: string | null;
  evaluationAttempt: number;
  /** Canonical prepared refs for the Goal-owned start input. */
  inputContent: ContentSequence;
  assessments: readonly GoalAssessment[];
  resultContent: ContentSequence;
  score: number | null;
  metrics: GoalMetrics;
  metadata: GoalMetadata;
  startedAt: string;
  finishedAt: string | null;
  createdAt: string;
  updatedAt: string;
}>;

export type GoalStartInput = Readonly<{
  /** Alias in resources.goals. */
  goal: string;
  content: GoalContentInput | readonly GoalContentInput[];
  sender: GoalSenderInput;
  thread?: GoalThreadRef;
  id?: string;
  metadata?: GoalMetadata;
}>;

export type GoalStartRequest = Readonly<{
  /** Alias in resources.goals. */
  goal: string;
  /** Ergonomic ingress accepts bytes; startGoal lowers these to dataBase64. */
  content: ContentInput | readonly ContentInput[];
  sender: GoalSenderInput;
  thread?: GoalThreadRef;
  id?: string;
  metadata?: GoalMetadata;
  namespace?: string;
  databaseSchema?: string;
  correlationId?: string;
  causationId?: string;
  deduplicationId?: string;
}>;

export type GoalStartOutput = Readonly<{
  goalId: string;
  status: "running";
  phase: "target";
  turn: 1;
  awaitingMessageId: string;
}>;

export type GoalCancelInput = Readonly<{
  goalId: string;
  reason?: string;
}>;

export type GoalCancelRequest =
  & GoalCancelInput
  & Readonly<{
    namespace?: string;
    databaseSchema?: string;
    correlationId?: string;
    causationId?: string;
    deduplicationId?: string;
  }>;

export type GoalCancelOutput = Readonly<{
  goalId: string;
  status: GoalTerminalStatus;
}>;
