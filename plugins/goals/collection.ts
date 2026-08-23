import {
  type CollectionDefinition,
  defineCollection,
} from "@copilotz/copilotz/collections";
import type {
  GoalAssessment,
  GoalMetrics,
  GoalPlanCursor,
  GoalRecord,
  GoalResult,
  GoalStopDecision,
  GoalTerminalStatus,
  GoalTranscriptCoordinate,
} from "./types.ts";

export const GOAL_COLLECTION = "goal";
export const GOAL_RESPONSE_RECORDED_EVENT = "goal.response-recorded";
export const GOAL_STOP_REQUESTED_EVENT = "goal.stop-requested";
export const GOAL_EVALUATION_REQUESTED_EVENT = "goal.evaluation-requested";

type Anchor = Readonly<{
  awaitingMessageId: string;
  planId: string | null;
}>;

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function text(value: unknown): string {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function integer(value: unknown): number {
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : -1;
}

function anchors(value: unknown): readonly Anchor[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const item = object(entry);
    const awaitingMessageId = text(item.awaitingMessageId);
    const planId = item.planId === null ? null : text(item.planId);
    return awaitingMessageId && (planId === null || planId)
      ? [{ awaitingMessageId, planId }]
      : [];
  });
}

function matchesAnchor(
  current: Readonly<Record<string, unknown>>,
  value: unknown,
): boolean {
  const awaitingMessageId = text(current.awaitingMessageId);
  const currentPlan = object(current.plan);
  const currentPlanId = text(currentPlan.planId) || null;
  return anchors(value).some((anchor) =>
    anchor.awaitingMessageId === awaitingMessageId &&
    anchor.planId === currentPlanId
  );
}

function plan(value: unknown): GoalPlanCursor {
  const item = object(value);
  const result: GoalPlanCursor = {
    planId: text(item.planId),
    planMessageId: text(item.planMessageId),
    triggerMessageId: text(item.triggerMessageId),
    planSize: integer(item.planSize),
  };
  if (
    !result.planId || !result.planMessageId || !result.triggerMessageId ||
    result.planSize < 1
  ) throw new TypeError("Goal plan cursor is invalid.");
  return result;
}

function transcript(value: unknown): GoalTranscriptCoordinate[] {
  return Array.isArray(value)
    ? structuredClone(value) as GoalTranscriptCoordinate[]
    : [];
}

function assessments(value: unknown): readonly GoalAssessment[] {
  return Array.isArray(value)
    ? structuredClone(value) as readonly GoalAssessment[]
    : [];
}

function stopDecision(value: unknown): GoalStopDecision {
  const item = object(value);
  if (typeof item.stop !== "boolean") {
    throw new TypeError("Goal stop decision must contain a boolean stop.");
  }
  const status = text(item.status);
  if (status && !["completed", "failed", "stopped", "error"].includes(status)) {
    throw new TypeError("Goal stop decision status is invalid.");
  }
  if (
    item.operationalError !== undefined &&
    typeof item.operationalError !== "boolean"
  ) throw new TypeError("Goal stop operational-error marker is invalid.");
  return {
    stop: item.stop,
    ...(status ? { status: status as GoalStopDecision["status"] } : {}),
    ...(text(item.reason) ? { reason: text(item.reason) } : {}),
    ...(item.operationalError === true ? { operationalError: true } : {}),
  };
}

function metrics(value: unknown): GoalMetrics {
  const item = object(value);
  return {
    durationMs: Math.max(0, Number(item.durationMs ?? 0)),
    targetRuns: Math.max(0, integer(item.targetRuns)),
    leadRuns: Math.max(0, integer(item.leadRuns)),
    judgeRuns: Math.max(0, integer(item.judgeRuns)),
    messages: Math.max(0, integer(item.messages)),
    errors: Math.max(0, integer(item.errors)),
  };
}

function immutableClone<T>(value: T): T {
  const copy = structuredClone(value);
  const freeze = (candidate: unknown): void => {
    if (
      !candidate || typeof candidate !== "object" || Object.isFrozen(candidate)
    ) {
      return;
    }
    for (const key of Reflect.ownKeys(candidate)) {
      freeze((candidate as Record<PropertyKey, unknown>)[key]);
    }
    Object.freeze(candidate);
  };
  freeze(copy);
  return copy;
}

function running(current: Readonly<Record<string, unknown>>): boolean {
  return current.status === "running";
}

function expectedOwner(
  current: Readonly<Record<string, unknown>>,
  input: Readonly<Record<string, unknown>>,
): boolean {
  return text(current.expectedThreadId) === text(input.threadId) &&
    text(current.expectedParticipantId) === text(input.participantId);
}

const contentSchema = {
  type: "array",
  items: { type: "object", additionalProperties: true },
} as const;

const metricsSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    durationMs: { type: "number" },
    targetRuns: { type: "integer" },
    leadRuns: { type: "integer" },
    judgeRuns: { type: "integer" },
    messages: { type: "integer" },
    errors: { type: "integer" },
  },
  required: [
    "durationMs",
    "targetRuns",
    "leadRuns",
    "judgeRuns",
    "messages",
    "errors",
  ],
} as const;

const goalSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    id: { type: "string" },
    namespace: { type: "string" },
    resourceAlias: { type: "string" },
    resource: { type: "object", additionalProperties: true },
    status: {
      type: "string",
      enum: [
        "running",
        "completed",
        "failed",
        "stopped",
        "cancelled",
        "error",
      ],
    },
    phase: { type: "string", enum: ["target", "lead", "judge", "done"] },
    turn: { type: "integer" },
    maxTurns: { type: "integer" },
    correlationId: { type: "string" },
    threadId: { type: "string" },
    leadThreadId: { type: "string" },
    judgeThreadId: { type: ["string", "null"] },
    senderParticipantId: { type: "string" },
    targetAgentId: { type: "string" },
    targetParticipantId: { type: "string" },
    leadAgentId: { type: "string" },
    leadInputParticipantId: { type: "string" },
    leadParticipantId: { type: "string" },
    judgeInputParticipantId: { type: ["string", "null"] },
    judgeAgentId: { type: ["string", "null"] },
    judgeParticipantId: { type: ["string", "null"] },
    expectedThreadId: { type: ["string", "null"] },
    expectedParticipantId: { type: ["string", "null"] },
    awaitingMessageId: { type: ["string", "null"] },
    responseMessageId: { type: ["string", "null"] },
    plan: { type: ["object", "null"], additionalProperties: true },
    transcript: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          phase: { type: "string", enum: ["target", "lead", "judge"] },
          turn: { type: "integer" },
          inputMessageId: { type: "string" },
          outputMessageId: { type: "string" },
        },
        required: ["phase", "turn", "inputMessageId"],
      },
    },
    finalMessageId: { type: ["string", "null"] },
    judgeMessageId: { type: ["string", "null"] },
    pendingStatus: {
      type: ["string", "null"],
      enum: ["completed", "failed", "stopped", "error", null],
    },
    pendingReason: { type: ["string", "null"] },
    transitionClaimId: { type: ["string", "null"] },
    stopStatus: {
      type: "string",
      enum: ["idle", "requested", "resolved"],
    },
    stopRequestId: { type: ["string", "null"] },
    stopAttempt: { type: "integer" },
    stopDecision: { type: ["object", "null"], additionalProperties: true },
    evaluationStatus: {
      type: "string",
      enum: ["idle", "requested"],
    },
    evaluationRequestId: { type: ["string", "null"] },
    evaluationAttempt: { type: "integer" },
    inputContent: contentSchema,
    assessments: { type: "array", items: { type: "object" } },
    resultContent: contentSchema,
    score: { type: ["number", "null"] },
    metrics: metricsSchema,
    metadata: { type: "object", additionalProperties: true },
    startedAt: { type: "string" },
    finishedAt: { type: ["string", "null"] },
    createdAt: { type: "string" },
    updatedAt: { type: "string" },
  },
  required: [
    "resourceAlias",
    "resource",
    "status",
    "phase",
    "turn",
    "maxTurns",
    "correlationId",
    "threadId",
    "leadThreadId",
    "judgeThreadId",
    "senderParticipantId",
    "targetAgentId",
    "targetParticipantId",
    "leadAgentId",
    "leadInputParticipantId",
    "leadParticipantId",
    "judgeInputParticipantId",
    "judgeAgentId",
    "judgeParticipantId",
    "expectedThreadId",
    "expectedParticipantId",
    "awaitingMessageId",
    "responseMessageId",
    "plan",
    "transcript",
    "finalMessageId",
    "judgeMessageId",
    "pendingStatus",
    "pendingReason",
    "transitionClaimId",
    "stopStatus",
    "stopRequestId",
    "stopAttempt",
    "stopDecision",
    "evaluationStatus",
    "evaluationRequestId",
    "evaluationAttempt",
    "inputContent",
    "assessments",
    "resultContent",
    "score",
    "metrics",
    "metadata",
    "startedAt",
    "finishedAt",
  ],
} as const;

const commandInput = {
  type: "object",
  additionalProperties: true,
} as const;

export const goalCollection: CollectionDefinition<typeof goalSchema> =
  defineCollection({
    name: GOAL_COLLECTION,
    schema: goalSchema,
    content: { fields: ["inputContent", "resultContent"] },
    indexes: [
      "awaitingMessageId",
      "status",
      "resourceAlias",
      ["status", "phase"],
    ],
    queries: {
      byAwaitingMessageId: {
        query({ input }) {
          return {
            where: { awaitingMessageId: String(input.awaitingMessageId ?? "") },
            limit: 4,
          };
        },
      },
      byStatus: {
        filter({ input }) {
          return { status: String(input.status ?? "") };
        },
      },
      byResourceAlias: {
        filter({ input }) {
          return { resourceAlias: String(input.resourceAlias ?? "") };
        },
      },
    },
    commands: {
      claimTransition: {
        event: "goal.transition-claimed",
        input: commandInput,
        mutate({ current, input }) {
          const data = object(input);
          if (!running(current)) return;
          if (current.evaluationStatus !== "idle") return;
          if (current.stopStatus === "requested") return;
          const claimId = text(data.claimId);
          if (!claimId) {
            throw new TypeError("Goal transition claim ID is required.");
          }
          if (text(current.transitionClaimId) === claimId) return;
          if (text(current.transitionClaimId)) return;
          if (
            current.phase !== data.expectedPhase ||
            integer(current.turn) !== integer(data.expectedTurn) ||
            (text(current.responseMessageId) || null) !==
              (text(data.expectedResponseMessageId) || null)
          ) return;
          return { set: { transitionClaimId: claimId } };
        },
      },
      releaseTransition: {
        event: GOAL_RESPONSE_RECORDED_EVENT,
        input: commandInput,
        mutate({ current, input }) {
          const data = object(input);
          const claimId = text(data.claimId);
          if (
            !running(current) || !claimId ||
            text(current.transitionClaimId) !== claimId
          ) return;
          return { set: { transitionClaimId: null } };
        },
      },
      recordPlan: {
        event: "goal.plan-recorded",
        input: commandInput,
        mutate({ current, input }) {
          const data = object(input);
          if (!running(current) || !expectedOwner(current, data)) return;
          if (!matchesAnchor(current, data.anchors)) return;
          const nextPlan = plan(data.plan);
          if (
            text(current.awaitingMessageId) === nextPlan.triggerMessageId &&
            text(object(current.plan).planId) === nextPlan.planId
          ) return;
          return {
            set: {
              awaitingMessageId: nextPlan.triggerMessageId,
              plan: nextPlan,
            },
          };
        },
      },
      advanceToolCursor: {
        event: "goal.awaiting-advanced",
        input: commandInput,
        mutate({ current, input }) {
          const data = object(input);
          if (!running(current) || !expectedOwner(current, data)) return;
          if (!matchesAnchor(current, data.anchors)) return;
          const nextPlan = plan(data.plan);
          const toolResultMessageId = text(data.toolResultMessageId);
          if (!toolResultMessageId) {
            throw new TypeError("Tool result Message ID must be non-empty.");
          }
          if (text(current.awaitingMessageId) === toolResultMessageId) return;
          return {
            set: { awaitingMessageId: toolResultMessageId, plan: nextPlan },
          };
        },
      },
      recordResponse: {
        event: GOAL_RESPONSE_RECORDED_EVENT,
        input: commandInput,
        mutate({ current, input }) {
          const data = object(input);
          if (!running(current) || !expectedOwner(current, data)) return;
          if (!matchesAnchor(current, data.anchors)) return;
          const messageId = text(data.messageId);
          if (!messageId) {
            throw new TypeError("Response Message ID is required.");
          }
          const coordinates = transcript(current.transcript);
          const last = coordinates.at(-1);
          if (
            !last || last.phase !== current.phase ||
            last.turn !== current.turn ||
            last.outputMessageId
          ) return;
          coordinates[coordinates.length - 1] = {
            ...last,
            outputMessageId: messageId,
          };
          const currentMetrics = metrics(current.metrics);
          return {
            set: {
              awaitingMessageId: null,
              responseMessageId: messageId,
              plan: null,
              transcript: coordinates,
              ...(current.phase === "target"
                ? { finalMessageId: messageId }
                : {}),
              ...(current.phase === "judge"
                ? { judgeMessageId: messageId }
                : {}),
              metrics: {
                ...currentMetrics,
                messages: currentMetrics.messages + 1,
              },
            },
          };
        },
      },
      failAwaited: {
        event: GOAL_RESPONSE_RECORDED_EVENT,
        input: commandInput,
        mutate({ current, input }) {
          const data = object(input);
          if (!running(current) || !expectedOwner(current, data)) return;
          if (!matchesAnchor(current, data.anchors)) return;
          const currentMetrics = metrics(current.metrics);
          return {
            set: {
              awaitingMessageId: null,
              responseMessageId: null,
              plan: null,
              pendingStatus: "error",
              pendingReason: text(data.reason) ||
                "The awaited model call failed.",
              metrics: {
                ...currentMetrics,
                errors: currentMetrics.errors + 1,
              },
            },
          };
        },
      },
      advance: {
        event: "goal.advanced",
        input: commandInput,
        mutate({ current, input }) {
          const data = object(input);
          if (!running(current)) {
            throw new Error(`Goal '${current.id}' is no longer running.`);
          }
          const claimId = text(data.claimId);
          if (!claimId || text(current.transitionClaimId) !== claimId) {
            throw new Error(`Goal '${current.id}' transition is not owned.`);
          }
          if (
            current.phase !== data.expectedPhase ||
            integer(current.turn) !== integer(data.expectedTurn) ||
            (text(current.responseMessageId) || null) !==
              (text(data.expectedResponseMessageId) || null)
          ) {
            throw new Error(`Goal '${current.id}' advance is stale.`);
          }
          const nextPhase = text(data.phase);
          const nextTurn = integer(data.turn);
          const inputMessageId = text(data.inputMessageId);
          const threadId = text(data.threadId);
          const participantId = text(data.participantId);
          if (
            !["target", "lead", "judge"].includes(nextPhase) || nextTurn < 1 ||
            !inputMessageId || !threadId || !participantId
          ) throw new TypeError("Goal advance command is invalid.");
          const coordinates = transcript(current.transcript);
          coordinates.push({
            phase: nextPhase as "target" | "lead" | "judge",
            turn: nextTurn,
            inputMessageId,
          });
          const currentMetrics = metrics(current.metrics);
          return {
            set: {
              phase: nextPhase,
              turn: nextTurn,
              expectedThreadId: threadId,
              expectedParticipantId: participantId,
              awaitingMessageId: inputMessageId,
              responseMessageId: null,
              plan: null,
              transcript: coordinates,
              ...(text(data.judgeThreadId)
                ? { judgeThreadId: text(data.judgeThreadId) }
                : {}),
              ...(text(data.judgeInputParticipantId)
                ? {
                  judgeInputParticipantId: text(
                    data.judgeInputParticipantId,
                  ),
                }
                : {}),
              ...(text(data.judgeParticipantId)
                ? { judgeParticipantId: text(data.judgeParticipantId) }
                : {}),
              pendingStatus: data.pendingStatus ?? current.pendingStatus,
              pendingReason: data.pendingReason ?? current.pendingReason,
              transitionClaimId: null,
              stopStatus: "idle",
              stopRequestId: null,
              stopAttempt: 0,
              stopDecision: null,
              metrics: {
                ...currentMetrics,
                targetRuns: currentMetrics.targetRuns +
                  (nextPhase === "target" ? 1 : 0),
                leadRuns: currentMetrics.leadRuns +
                  (nextPhase === "lead" ? 1 : 0),
                judgeRuns: currentMetrics.judgeRuns +
                  (nextPhase === "judge" ? 1 : 0),
                errors: currentMetrics.errors +
                  Math.max(0, integer(data.extraErrors)),
              },
            },
          };
        },
      },
      requestStop: {
        event: GOAL_STOP_REQUESTED_EVENT,
        input: commandInput,
        mutate({ current, input }) {
          const data = object(input);
          if (!running(current) || current.stopStatus !== "idle") return;
          const claimId = text(data.claimId);
          const requestId = text(data.requestId);
          if (
            !claimId || text(current.transitionClaimId) !== claimId ||
            !requestId || current.phase !== "target" ||
            integer(current.turn) !== integer(data.expectedTurn) ||
            text(current.responseMessageId) !==
              text(data.expectedResponseMessageId)
          ) return;
          return {
            set: {
              transitionClaimId: null,
              stopStatus: "requested",
              stopRequestId: requestId,
              stopAttempt: 1,
              stopDecision: null,
            },
          };
        },
      },
      retryStop: {
        event: GOAL_STOP_REQUESTED_EVENT,
        input: commandInput,
        mutate({ current, input }) {
          const data = object(input);
          const requestId = text(data.requestId);
          const nextRequestId = text(data.nextRequestId);
          if (
            !running(current) || current.stopStatus !== "requested" ||
            !requestId || text(current.stopRequestId) !== requestId ||
            !nextRequestId || nextRequestId === requestId
          ) return;
          return {
            set: {
              stopRequestId: nextRequestId,
              stopAttempt: Math.max(1, integer(current.stopAttempt)) + 1,
            },
          };
        },
      },
      resolveStop: {
        event: GOAL_RESPONSE_RECORDED_EVENT,
        input: commandInput,
        mutate({ current, input }) {
          const data = object(input);
          const requestId = text(data.requestId);
          if (
            !running(current) || current.stopStatus !== "requested" ||
            !requestId || text(current.stopRequestId) !== requestId ||
            current.phase !== "target"
          ) return;
          const decision = stopDecision(data.decision);
          const currentMetrics = metrics(current.metrics);
          return {
            set: {
              stopStatus: "resolved",
              stopDecision: decision,
              metrics: {
                ...currentMetrics,
                errors: currentMetrics.errors +
                  Math.max(0, integer(data.extraErrors)),
              },
            },
          };
        },
      },
      requestEvaluation: {
        event: GOAL_EVALUATION_REQUESTED_EVENT,
        input: commandInput,
        mutate({ current, input }) {
          const data = object(input);
          if (!running(current)) return;
          if (current.evaluationStatus !== "idle") return;
          const claimId = text(data.claimId);
          if (!claimId || text(current.transitionClaimId) !== claimId) return;
          if (
            current.phase !== data.expectedPhase ||
            integer(current.turn) !== integer(data.expectedTurn) ||
            (text(current.responseMessageId) || null) !==
              (text(data.expectedResponseMessageId) || null)
          ) return;
          const status = text(data.status);
          const requestId = text(data.requestId);
          if (!requestId) {
            throw new TypeError("Goal evaluation request ID is required.");
          }
          if (!["completed", "failed", "stopped", "error"].includes(status)) {
            throw new TypeError("Goal evaluation candidate status is invalid.");
          }
          const currentMetrics = metrics(current.metrics);
          return {
            set: {
              pendingStatus: status,
              pendingReason: text(data.reason) || null,
              evaluationStatus: "requested",
              evaluationRequestId: requestId,
              evaluationAttempt: 1,
              transitionClaimId: null,
              metrics: {
                ...currentMetrics,
                errors: currentMetrics.errors +
                  Math.max(0, integer(data.extraErrors)),
              },
            },
          };
        },
      },
      retryEvaluation: {
        event: GOAL_EVALUATION_REQUESTED_EVENT,
        input: commandInput,
        mutate({ current, input }) {
          const data = object(input);
          const requestId = text(data.requestId);
          const nextRequestId = text(data.nextRequestId);
          if (
            !running(current) || current.evaluationStatus !== "requested" ||
            !requestId || text(current.evaluationRequestId) !== requestId ||
            !nextRequestId || nextRequestId === requestId
          ) return;
          return {
            set: {
              evaluationRequestId: nextRequestId,
              evaluationAttempt:
                Math.max(1, integer(current.evaluationAttempt)) + 1,
            },
          };
        },
      },
      settle: {
        event: "goal.settled",
        input: commandInput,
        mutate({ current, input }) {
          const data = object(input);
          if (!running(current)) return;
          const evaluationRequestId = text(data.evaluationRequestId);
          const transitionClaimId = text(data.transitionClaimId);
          if (Boolean(evaluationRequestId) === Boolean(transitionClaimId)) {
            return;
          }
          if (
            evaluationRequestId &&
            (current.evaluationStatus !== "requested" ||
              text(current.evaluationRequestId) !== evaluationRequestId)
          ) return;
          if (!evaluationRequestId && current.evaluationStatus !== "idle") {
            return;
          }
          if (
            transitionClaimId &&
            text(current.transitionClaimId) !== transitionClaimId
          ) return;
          if (
            current.phase !== data.expectedPhase ||
            integer(current.turn) !== integer(data.expectedTurn) ||
            (text(current.responseMessageId) || null) !==
              (text(data.expectedResponseMessageId) || null)
          ) return;
          const status = text(data.status) as GoalTerminalStatus;
          if (
            !["completed", "failed", "stopped", "error"].includes(status)
          ) throw new TypeError("Goal terminal status is invalid.");
          const finishedAt = text(data.finishedAt);
          if (!finishedAt) throw new TypeError("Goal finishedAt is required.");
          return {
            set: {
              status,
              phase: "done",
              expectedThreadId: null,
              expectedParticipantId: null,
              awaitingMessageId: null,
              responseMessageId: null,
              plan: null,
              pendingStatus: status,
              pendingReason: text(data.reason) || null,
              evaluationStatus: "idle",
              evaluationRequestId: null,
              evaluationAttempt: 0,
              transitionClaimId: null,
              stopStatus: "idle",
              stopRequestId: null,
              stopAttempt: 0,
              stopDecision: null,
              assessments: assessments(data.assessments),
              resultContent: Array.isArray(data.resultContent)
                ? structuredClone(data.resultContent)
                : [],
              score:
                typeof data.score === "number" && Number.isFinite(data.score)
                  ? data.score
                  : null,
              metrics: metrics(data.metrics),
              finishedAt,
            },
          };
        },
      },
      cancelAwaited: {
        event: "goal.awaited-cancelled",
        input: commandInput,
        mutate({ current, input }) {
          if (!running(current)) return;
          const data = object(input);
          if (
            current.evaluationStatus !== "idle" ||
            current.stopStatus === "requested" ||
            text(current.transitionClaimId)
          ) return;
          if (
            !Array.isArray(data.anchors) || data.anchors.length === 0 ||
            !expectedOwner(current, data) ||
            !matchesAnchor(current, data.anchors)
          ) return;
          const finishedAt = text(data.finishedAt);
          if (!finishedAt) {
            throw new TypeError("Goal cancellation time is required.");
          }
          const currentMetrics = metrics(current.metrics);
          return {
            set: {
              status: "cancelled",
              phase: "done",
              expectedThreadId: null,
              expectedParticipantId: null,
              awaitingMessageId: null,
              responseMessageId: null,
              plan: null,
              pendingStatus: null,
              pendingReason: text(data.reason) || null,
              evaluationStatus: "idle",
              evaluationRequestId: null,
              evaluationAttempt: 0,
              transitionClaimId: null,
              stopStatus: "idle",
              stopRequestId: null,
              stopAttempt: 0,
              stopDecision: null,
              assessments: [],
              resultContent: [],
              score: null,
              metrics: {
                ...currentMetrics,
                durationMs: Math.max(
                  0,
                  new Date(finishedAt).getTime() -
                    new Date(text(current.startedAt)).getTime(),
                ),
              },
              finishedAt,
            },
          };
        },
      },
      cancel: {
        event: "goal.cancelled",
        input: commandInput,
        mutate({ current, input }) {
          if (!running(current)) return;
          const data = object(input);
          const finishedAt = text(data.finishedAt);
          if (!finishedAt) {
            throw new TypeError("Goal cancellation time is required.");
          }
          const currentMetrics = metrics(current.metrics);
          return {
            set: {
              status: "cancelled",
              phase: "done",
              expectedThreadId: null,
              expectedParticipantId: null,
              awaitingMessageId: null,
              responseMessageId: null,
              plan: null,
              pendingStatus: null,
              pendingReason: text(data.reason) || null,
              evaluationStatus: "idle",
              evaluationRequestId: null,
              evaluationAttempt: 0,
              transitionClaimId: null,
              stopStatus: "idle",
              stopRequestId: null,
              stopAttempt: 0,
              stopDecision: null,
              assessments: [],
              resultContent: [],
              score: null,
              metrics: {
                ...currentMetrics,
                durationMs: Math.max(
                  0,
                  new Date(finishedAt).getTime() -
                    new Date(text(current.startedAt)).getTime(),
                ),
              },
              finishedAt,
            },
          };
        },
      },
    },
  });

/** Immutable public projection of one terminal Goal Collection record. */
export function goalResult(record: GoalRecord): GoalResult {
  if (
    record.status === "running" || record.phase !== "done" || !record.finishedAt
  ) {
    throw new Error(`Goal '${record.id}' is not terminal.`);
  }
  return Object.freeze({
    goalId: record.id,
    status: record.status,
    phase: "done",
    turns: record.turn,
    ...(record.finalMessageId ? { finalMessageId: record.finalMessageId } : {}),
    ...(record.judgeMessageId ? { judgeMessageId: record.judgeMessageId } : {}),
    ...(record.pendingReason ? { reason: record.pendingReason } : {}),
    ...(record.score === null ? {} : { score: record.score }),
    assessments: immutableClone(record.assessments),
    report: immutableClone(record.resultContent),
    metrics: immutableClone(record.metrics),
    startedAt: record.startedAt,
    finishedAt: record.finishedAt,
  });
}

export function asGoalRecord(value: unknown): GoalRecord {
  return value as GoalRecord;
}
