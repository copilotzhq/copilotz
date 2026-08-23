import {
  type ActionCaller,
  type ActionEventData,
  isSettledActionError,
  parseActionLifecycleEvent,
  type RuntimeActionCallers,
  sameActionValue,
} from "@copilotz/copilotz/actions";
import type { CollectionRecord } from "@copilotz/copilotz/collections";
import { isContentError } from "@copilotz/copilotz/content";
import {
  CORE_LLM_CALL_METADATA_SCHEMA,
  coreLlmCallMetadata,
  workflowMetadata,
} from "@copilotz/copilotz/core";
import {
  defineProcessor,
  type Processor,
  type ProcessorContext,
} from "@copilotz/copilotz/plugins";
import {
  type acceptGoalMessageAction,
  advanceGoalAction,
  type cancelGoalAction,
  evaluationActionInput,
  evaluationCandidate,
  evaluationError,
  type failGoalAwaitedAction,
  type GoalEvaluation,
  normalizeEvaluation,
  normalizeStopOutput,
  type startGoalAction,
  stopActionInput,
} from "./actions.ts";
import {
  asGoalRecord,
  GOAL_EVALUATION_REQUESTED_EVENT,
  GOAL_RESPONSE_RECORDED_EVENT,
  GOAL_STOP_REQUESTED_EVENT,
} from "./collection.ts";
import { GOAL_CANCEL_INPUT_EVENT, GOAL_START_INPUT_EVENT } from "./input.ts";
import type {
  GoalCancelInput,
  GoalMetrics,
  GoalRecord,
  GoalStartInput,
  GoalStopDecision,
} from "./types.ts";

type GoalsProcessorContext =
  & Omit<ProcessorContext, "actions">
  & Readonly<{
    actions:
      & RuntimeActionCallers
      & Readonly<{
        startGoal: ActionCaller<typeof startGoalAction>;
        acceptGoalMessage: ActionCaller<typeof acceptGoalMessageAction>;
        advanceGoal: ActionCaller<typeof advanceGoalAction>;
        failGoalAwaited: ActionCaller<typeof failGoalAwaitedAction>;
        cancelGoal: ActionCaller<typeof cancelGoalAction>;
      }>;
  }>;

const GOAL_ACTION_METADATA_KEY = "copilotzGoalAction";
const GOAL_ACTION_METADATA_SCHEMA = "copilotz.goal.action.v1";

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function text(value: unknown): string {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function collectionRecord(
  event: Readonly<{ data?: unknown }>,
): CollectionRecord {
  return record(record(event.data).record) as CollectionRecord;
}

async function settled(operation: () => Promise<unknown>): Promise<void> {
  try {
    await operation();
  } catch (error) {
    if (!isSettledActionError(error)) throw error;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type GoalActionKind = "stop" | "evaluate";
type GoalActionDescriptor = Readonly<{
  schema: typeof GOAL_ACTION_METADATA_SCHEMA;
  kind: GoalActionKind;
  goalId: string;
  requestId: string;
  actionAlias: string;
}>;

function actionDescriptor(
  kind: GoalActionKind,
  goalId: string,
  requestId: string,
  actionAlias: string,
): GoalActionDescriptor {
  return Object.freeze({
    schema: GOAL_ACTION_METADATA_SCHEMA,
    kind,
    goalId,
    requestId,
    actionAlias,
  });
}

function exactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const own = Reflect.ownKeys(value);
  return own.length === keys.length &&
    own.every((key) =>
      typeof key === "string" && keys.includes(key) &&
      Object.getOwnPropertyDescriptor(value, key)?.enumerable === true &&
      "value" in Object.getOwnPropertyDescriptor(value, key)!
    );
}

function parseActionDescriptor(value: unknown): GoalActionDescriptor | null {
  const metadata = record(value);
  if (!exactKeys(metadata, [GOAL_ACTION_METADATA_KEY])) return null;
  const item = record(metadata[GOAL_ACTION_METADATA_KEY]);
  const kind = text(item.kind);
  const goalId = text(item.goalId);
  const requestId = text(item.requestId);
  const actionAlias = text(item.actionAlias);
  if (
    !exactKeys(item, [
      "schema",
      "kind",
      "goalId",
      "requestId",
      "actionAlias",
    ]) ||
    item.schema !== GOAL_ACTION_METADATA_SCHEMA ||
    (kind !== "stop" && kind !== "evaluate") || !goalId || !requestId ||
    !actionAlias
  ) return null;
  return actionDescriptor(kind, goalId, requestId, actionAlias);
}

function terminalLifecycle(
  event: Readonly<{
    durable: unknown;
    type: string;
    subject?: Readonly<{ type: string; id: string }>;
    metadata: Readonly<Record<string, unknown>>;
    data?: unknown;
  }>,
  expectedActionId?: string,
):
  | Extract<ActionEventData, { status: "completed" | "failed" | "cancelled" }>
  | null {
  const lifecycle = parseActionLifecycleEvent(event, {
    ...(expectedActionId ? { actionId: expectedActionId } : {}),
    statuses: ["completed", "failed", "cancelled"],
    requireRoot: true,
  });
  if (!lifecycle) return null;
  return lifecycle as Extract<
    ActionEventData,
    { status: "completed" | "failed" | "cancelled" }
  >;
}

async function currentGoal(
  context: GoalsProcessorContext,
  goalId: string,
): Promise<GoalRecord | null> {
  const value = await context.collections.goal.get({ id: goalId });
  return value ? asGoalRecord(value) : null;
}

async function invokeConfigured(
  context: GoalsProcessorContext,
  event: Readonly<{
    id: string;
    correlationId: string;
  }>,
  alias: string,
  input: unknown,
  descriptor: GoalActionDescriptor,
): Promise<void> {
  const caller = Object.hasOwn(context.actions, alias)
    ? context.actions[alias]
    : undefined;
  if (typeof caller !== "function") {
    throw new TypeError(`Required Action alias '${alias}' is not composed.`);
  }
  try {
    await caller(input, {
      operationKey: `goal:${descriptor.kind}:${descriptor.requestId}`,
      metadata: { [GOAL_ACTION_METADATA_KEY]: descriptor },
      identity: {
        causationId: event.id,
        correlationId: event.correlationId,
        settlementScopeId: context.identity.settlementScopeId,
      },
      signal: context.signal,
    });
  } catch (error) {
    // A settled configured-Action failure/cancellation has its own durable
    // lifecycle fact. The lifecycle Processor owns the semantic transition.
    if (!isSettledActionError(error)) throw error;
  }
}

function nextRequestId(
  kind: GoalActionKind,
  goal: GoalRecord,
  attempt: number,
): string {
  return `goal:${goal.id}:${kind}:${goal.phase}:${goal.turn}:${
    goal.responseMessageId ?? "failure"
  }:attempt:${attempt}`;
}

function updatedMetrics(
  goal: GoalRecord,
  evaluation: GoalEvaluation,
  finishedAt: string,
): GoalMetrics {
  return {
    ...goal.metrics,
    durationMs: Math.max(
      0,
      new Date(finishedAt).getTime() - new Date(goal.startedAt).getTime(),
    ),
    errors: goal.metrics.errors + evaluation.extraErrors,
  };
}

async function validEvaluationContent(
  context: GoalsProcessorContext,
  evaluation: GoalEvaluation,
): Promise<void> {
  if (evaluation.report.length === 0) return;
  const assets = await context.content.getMany(
    evaluation.report.map((ref) => ref.assetId),
  );
  if (assets.length !== evaluation.report.length) {
    throw new TypeError("Goal evaluation report Assets are incomplete.");
  }
  for (const [index, ref] of evaluation.report.entries()) {
    const asset = assets[index];
    if (
      asset.id !== ref.assetId || asset.state !== "ready" ||
      asset.mediaType !== ref.mediaType
    ) {
      throw new TypeError(
        `Goal evaluation report Asset '${ref.assetId}' is not a matching ready Asset.`,
      );
    }
  }
}

function deterministicContentError(error: unknown): boolean {
  return error instanceof TypeError ||
    (isContentError(error) && error.code !== "asset_storage_unavailable");
}

async function settleEvaluation(
  context: GoalsProcessorContext,
  event: Readonly<{ id: string; createdAt: string }>,
  goal: GoalRecord,
  requestId: string,
  input: GoalEvaluation,
): Promise<void> {
  let evaluation = input;
  try {
    await validEvaluationContent(context, evaluation);
  } catch (error) {
    if (!deterministicContentError(error)) throw error;
    evaluation = evaluationError(
      `Goal evaluate Action returned invalid report content: ${
        errorMessage(error)
      }`,
    );
  }
  const finishedAt = event.createdAt;
  const settle = async (result: GoalEvaluation, suffix: string) => {
    await context.collections.goal.commands.settle({
      id: goal.id,
      evaluationRequestId: requestId,
      expectedPhase: goal.phase,
      expectedTurn: goal.turn,
      expectedResponseMessageId: goal.responseMessageId,
      status: result.status,
      ...(result.reason ? { reason: result.reason } : {}),
      ...(result.score === undefined ? {} : { score: result.score }),
      assessments: result.assessments,
      resultContent: result.report,
      metrics: updatedMetrics(goal, result, finishedAt),
      finishedAt,
    }, {
      operationKey: `goal:${goal.id}:evaluation-settle:${requestId}:${suffix}`,
      visibility: { kind: "internal" },
      identity: { correlationId: goal.correlationId },
    });
  };
  try {
    await settle(evaluation, "result");
  } catch (error) {
    if (!deterministicContentError(error)) throw error;
    const invalid = evaluationError(
      `Goal evaluation report could not be persisted: ${errorMessage(error)}`,
    );
    await settle(invalid, "invalid-content");
  }
}

export const goalStartInputProcessor: Processor<GoalsProcessorContext> =
  defineProcessor<GoalsProcessorContext>({
    id: "copilotz.goals.start-input",
    on: [{ eventType: GOAL_START_INPUT_EVENT }],
    async handle(event, context) {
      if (!event.durable) return;
      const payload = record(event.payload) as GoalStartInput;
      await settled(() =>
        context.actions.startGoal({
          ...payload,
          id: text(payload.id) || event.id,
        }, {
          operationKey: `start:${event.id}`,
          identity: {
            causationId: event.id,
            correlationId: event.correlationId,
            deduplicationId: event.deduplicationId,
            settlementScopeId: event.id,
          },
          signal: context.signal,
        })
      );
    },
  });

export const goalCancelInputProcessor: Processor<GoalsProcessorContext> =
  defineProcessor<GoalsProcessorContext>({
    id: "copilotz.goals.cancel-input",
    on: [{ eventType: GOAL_CANCEL_INPUT_EVENT }],
    async handle(event, context) {
      if (!event.durable) return;
      await settled(() =>
        context.actions.cancelGoal(
          record(event.payload) as GoalCancelInput,
          {
            operationKey: `cancel:${event.id}`,
            identity: {
              causationId: event.id,
              correlationId: event.correlationId,
              deduplicationId: event.deduplicationId,
              settlementScopeId: event.id,
            },
            signal: context.signal,
          },
        )
      );
    },
  });

export const goalMessageProcessor: Processor<GoalsProcessorContext> =
  defineProcessor<GoalsProcessorContext>({
    id: "copilotz.goals.message",
    on: [{ eventType: "message.created", subject: { type: "message" } }],
    async handle(event, context) {
      if (!event.durable) return;
      const message = collectionRecord(event);
      if (!text(message.id)) return;
      const workflow = workflowMetadata(record(message.metadata));
      if (
        workflow?.kind !== "agent_output" && workflow?.kind !== "tool_result"
      ) return;
      await settled(() =>
        context.actions.acceptGoalMessage({
          messageId: message.id,
        }, {
          operationKey: `message:${message.id}`,
          identity: {
            causationId: event.id,
            correlationId: event.correlationId,
            settlementScopeId: context.identity.settlementScopeId,
          },
          signal: context.signal,
        })
      );
    },
  });

export const goalResponseProcessor: Processor<GoalsProcessorContext> =
  defineProcessor<GoalsProcessorContext>({
    id: "copilotz.goals.response",
    on: [{
      eventType: GOAL_RESPONSE_RECORDED_EVENT,
      subject: { type: "goal" },
    }],
    async handle(event, context) {
      if (!event.durable || !event.subject?.id) return;
      await settled(() =>
        context.actions.advanceGoal({
          goalId: event.subject!.id,
        }, {
          operationKey: `advance:${event.id}`,
          identity: {
            causationId: event.id,
            correlationId: event.correlationId,
            settlementScopeId: context.identity.settlementScopeId,
          },
          signal: context.signal,
        })
      );
    },
  });

export const goalStopRequestProcessor: Processor<GoalsProcessorContext> =
  defineProcessor<GoalsProcessorContext>({
    id: "copilotz.goals.stop-request",
    on: [{
      eventType: GOAL_STOP_REQUESTED_EVENT,
      subject: { type: "goal" },
    }],
    async handle(event, context) {
      if (!event.durable || !event.subject?.id) return;
      const requestId = text(collectionRecord(event).stopRequestId);
      if (!requestId) return;
      const goal = await currentGoal(context, event.subject.id);
      if (
        !goal || goal.status !== "running" || goal.stopStatus !== "requested" ||
        goal.stopRequestId !== requestId
      ) return;
      const alias = goal.resource.stopAction;
      if (
        !alias || !Object.hasOwn(context.actions, alias) ||
        typeof context.actions[alias] !== "function"
      ) {
        await context.collections.goal.commands.resolveStop({
          id: goal.id,
          requestId,
          decision: {
            stop: true,
            status: "error",
            reason: alias
              ? `Goal stop Action alias '${alias}' is no longer composed.`
              : "Goal stop request has no configured Action.",
            operationalError: true,
          },
          extraErrors: 1,
        }, {
          operationKey: `goal:${goal.id}:stop-missing:${requestId}`,
          visibility: { kind: "internal" },
          identity: { correlationId: goal.correlationId },
        });
        return;
      }
      await invokeConfigured(
        context,
        event,
        alias,
        stopActionInput(goal),
        actionDescriptor("stop", goal.id, requestId, alias),
      );
    },
  });

export const goalEvaluationProcessor: Processor<GoalsProcessorContext> =
  defineProcessor<GoalsProcessorContext>({
    id: "copilotz.goals.evaluation-request",
    on: [{
      eventType: GOAL_EVALUATION_REQUESTED_EVENT,
      subject: { type: "goal" },
    }],
    async handle(event, context) {
      if (!event.durable || !event.subject?.id) return;
      const requestId = text(collectionRecord(event).evaluationRequestId);
      if (!requestId) return;
      const goal = await currentGoal(context, event.subject.id);
      if (
        !goal || goal.status !== "running" ||
        goal.evaluationStatus !== "requested" ||
        goal.evaluationRequestId !== requestId
      ) return;
      const alias = goal.resource.evaluateAction;
      if (
        !alias || !Object.hasOwn(context.actions, alias) ||
        typeof context.actions[alias] !== "function"
      ) {
        await settleEvaluation(
          context,
          event,
          goal,
          requestId,
          evaluationError(
            alias
              ? `Goal evaluate Action alias '${alias}' is no longer composed.`
              : "Goal evaluation request has no configured Action.",
          ),
        );
        return;
      }
      await invokeConfigured(
        context,
        event,
        alias,
        evaluationActionInput(goal),
        actionDescriptor("evaluate", goal.id, requestId, alias),
      );
    },
  });

export const goalConfiguredActionLifecycleProcessor: Processor<
  GoalsProcessorContext
> = defineProcessor<GoalsProcessorContext>({
  id: "copilotz.goals.configured-action-lifecycle",
  on: ["completed", "failed", "cancelled"].map((status) => ({
    eventType: "*",
    data: {
      status,
      metadata: {
        [GOAL_ACTION_METADATA_KEY]: { schema: GOAL_ACTION_METADATA_SCHEMA },
      },
    },
  })),
  async handle(event, context) {
    if (!event.durable) return;
    const lifecycle = terminalLifecycle(event);
    if (!lifecycle) return;
    const descriptor = parseActionDescriptor(lifecycle.metadata);
    if (!descriptor) return;
    const goal = await currentGoal(context, descriptor.goalId);
    if (!goal || goal.status !== "running") return;
    if (
      !Object.hasOwn(context.actions, descriptor.actionAlias) ||
      typeof context.actions[descriptor.actionAlias] !== "function"
    ) return;

    if (descriptor.kind === "stop") {
      if (
        descriptor.actionAlias !== goal.resource.stopAction ||
        goal.stopStatus !== "requested" ||
        goal.stopRequestId !== descriptor.requestId ||
        !sameActionValue(lifecycle.input, stopActionInput(goal))
      ) return;
      if (lifecycle.status === "cancelled") {
        if (goal.stopAttempt >= 2) {
          await context.collections.goal.commands.resolveStop({
            id: goal.id,
            requestId: descriptor.requestId,
            decision: {
              stop: true,
              status: "error",
              reason:
                "Goal stop Action was cancelled after its one durable retry.",
              operationalError: true,
            },
            extraErrors: 1,
          }, {
            operationKey:
              `goal:${goal.id}:stop-cancelled-terminal:${descriptor.requestId}`,
            visibility: { kind: "internal" },
            identity: { correlationId: goal.correlationId },
          });
          return;
        }
        const next = nextRequestId("stop", goal, goal.stopAttempt + 1);
        await context.collections.goal.commands.retryStop({
          id: goal.id,
          requestId: descriptor.requestId,
          nextRequestId: next,
        }, {
          operationKey: `goal:${goal.id}:stop-retry:${descriptor.requestId}`,
          visibility: { kind: "internal" },
          identity: { correlationId: goal.correlationId },
        });
        return;
      }
      let decision: GoalStopDecision;
      let extraErrors = 0;
      if (lifecycle.status === "failed") {
        decision = {
          stop: true,
          status: "error",
          reason: `Goal stop Action failed: ${lifecycle.error.message}`,
          operationalError: true,
        };
        extraErrors = 1;
      } else {
        try {
          decision = normalizeStopOutput(record(lifecycle).output);
        } catch (error) {
          decision = {
            stop: true,
            status: "error",
            reason: `Goal stop Action returned invalid output: ${
              errorMessage(error)
            }`,
            operationalError: true,
          };
          extraErrors = 1;
        }
      }
      await context.collections.goal.commands.resolveStop({
        id: goal.id,
        requestId: descriptor.requestId,
        decision,
        extraErrors,
      }, {
        operationKey: `goal:${goal.id}:stop-resolve:${descriptor.requestId}`,
        visibility: { kind: "internal" },
        identity: { correlationId: goal.correlationId },
      });
      return;
    }

    if (
      descriptor.actionAlias !== goal.resource.evaluateAction ||
      goal.evaluationStatus !== "requested" ||
      goal.evaluationRequestId !== descriptor.requestId ||
      !sameActionValue(lifecycle.input, evaluationActionInput(goal))
    ) return;
    if (lifecycle.status === "cancelled") {
      if (goal.evaluationAttempt >= 2) {
        await settleEvaluation(
          context,
          event,
          goal,
          descriptor.requestId,
          evaluationError(
            "Goal evaluate Action was cancelled after its one durable retry.",
          ),
        );
        return;
      }
      const next = nextRequestId("evaluate", goal, goal.evaluationAttempt + 1);
      await context.collections.goal.commands.retryEvaluation({
        id: goal.id,
        requestId: descriptor.requestId,
        nextRequestId: next,
      }, {
        operationKey:
          `goal:${goal.id}:evaluation-retry:${descriptor.requestId}`,
        visibility: { kind: "internal" },
        identity: { correlationId: goal.correlationId },
      });
      return;
    }
    let evaluation: GoalEvaluation;
    if (lifecycle.status === "failed") {
      evaluation = evaluationError(
        `Goal evaluate Action failed: ${lifecycle.error.message}`,
      );
    } else {
      try {
        evaluation = normalizeEvaluation(
          record(lifecycle).output,
          evaluationCandidate(goal),
        );
      } catch (error) {
        evaluation = evaluationError(
          `Goal evaluate Action returned invalid output: ${
            errorMessage(error)
          }`,
        );
      }
    }
    await settleEvaluation(
      context,
      event,
      goal,
      descriptor.requestId,
      evaluation,
    );
  },
});

export const goalAdvanceLifecycleRecoveryProcessor: Processor<
  GoalsProcessorContext
> = defineProcessor<GoalsProcessorContext>({
  id: "copilotz.goals.advance-recovery",
  on: [
    { eventType: `${advanceGoalAction.id}.failed` },
    { eventType: `${advanceGoalAction.id}.cancelled` },
  ],
  async handle(event, context) {
    if (!event.durable) return;
    const lifecycle = terminalLifecycle(event, advanceGoalAction.id);
    if (
      !lifecycle ||
      (lifecycle.status !== "failed" && lifecycle.status !== "cancelled")
    ) return;
    const actionRunId = lifecycle.actionRunId;
    const goalId = text(record(lifecycle.input).goalId);
    if (!goalId || !sameActionValue(lifecycle.input, { goalId })) return;
    const goal = await currentGoal(context, goalId);
    if (
      !goal || goal.status !== "running" ||
      goal.transitionClaimId !== actionRunId
    ) return;
    await context.collections.goal.commands.releaseTransition({
      id: goalId,
      claimId: actionRunId,
    }, {
      operationKey: `goal:${goalId}:advance-recovery:${event.id}`,
      visibility: { kind: "internal" },
      identity: { correlationId: goal.correlationId },
    });
  },
});

export const goalLlmTerminalProcessor: Processor<GoalsProcessorContext> =
  defineProcessor<GoalsProcessorContext>({
    id: "copilotz.goals.llm-terminal",
    on: [
      {
        eventType: "llm.call.failed",
        data: { metadata: { schema: CORE_LLM_CALL_METADATA_SCHEMA } },
      },
      {
        eventType: "llm.call.cancelled",
        data: { metadata: { schema: CORE_LLM_CALL_METADATA_SCHEMA } },
      },
    ],
    async handle(event, context) {
      if (!event.durable) return;
      const lifecycle = terminalLifecycle(event, "llm.call");
      if (
        !lifecycle ||
        (lifecycle.status !== "failed" && lifecycle.status !== "cancelled")
      ) return;
      const metadata = coreLlmCallMetadata(lifecycle.metadata);
      if (!metadata) return;
      await settled(() =>
        context.actions.failGoalAwaited({
          triggerMessageId: metadata.triggerMessageId,
          threadId: metadata.threadId,
          participantId: metadata.agentParticipantId,
          agentId: metadata.agentId,
          status: lifecycle.status === "cancelled" ? "cancelled" : "failed",
          ...(text(lifecycle.error.message)
            ? { reason: text(lifecycle.error.message) }
            : {}),
        }, {
          operationKey: `llm-terminal:${event.id}`,
          identity: {
            causationId: event.id,
            correlationId: event.correlationId,
            settlementScopeId: context.identity.settlementScopeId,
          },
          signal: context.signal,
        })
      );
    },
  });
