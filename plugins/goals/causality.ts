import type { RuntimeContext } from "@copilotz/copilotz/actions";
import type { CollectionRecord } from "@copilotz/copilotz/collections";
import {
  coreToolActionMessageMetadata,
  coreToolPlanMetadata,
  workflowMetadata,
} from "@copilotz/copilotz/core";
import { asGoalRecord } from "./collection.ts";
import type { GoalPlanCursor, GoalRecord } from "./types.ts";

export type GoalCausalAnchor = Readonly<{
  awaitingMessageId: string;
  planId: string | null;
}>;

export type GoalCausality = Readonly<{
  goal: GoalRecord;
  anchors: readonly GoalCausalAnchor[];
}>;

type ValidatedToolStep = Readonly<{
  messageId: string;
  triggerMessageId: string;
  threadId: string;
  participantId: string;
  agentId: string;
  plan: GoalPlanCursor;
}>;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function text(value: unknown): string {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function textArray(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => Boolean(text(entry)))
    : [];
}

function currentPlanId(goal: GoalRecord): string | null {
  return goal.plan?.planId ?? null;
}

function expectedAgentId(goal: GoalRecord): string {
  if (goal.phase === "target") return goal.targetAgentId;
  if (goal.phase === "lead") return goal.leadAgentId;
  return goal.judgeAgentId ?? "";
}

async function message(
  context: Pick<RuntimeContext, "collections">,
  id: string,
): Promise<CollectionRecord | null> {
  return await context.collections.message?.get({ id }) ?? null;
}

/**
 * Verifies the complete Core T -> P -> trigger chain for one final Tool result.
 * Every field is checked before the result may bridge a Goal cursor.
 */
async function validatedFinalToolStep(
  context: Pick<RuntimeContext, "collections">,
  toolMessage: CollectionRecord,
): Promise<ValidatedToolStep | null> {
  const toolMetadata = record(toolMessage.metadata);
  const workflow = workflowMetadata(toolMetadata);
  if (workflow?.kind !== "tool_result") return null;
  const tool = coreToolActionMessageMetadata(toolMetadata);
  if (!tool || tool.planIndex + 1 !== tool.planSize) return null;
  if (
    text(toolMessage.threadId) !== tool.threadId ||
    !textArray(toolMessage.recipientIds).includes(tool.agentParticipantId) ||
    workflow.sourceMessageId !== tool.planMessageId ||
    workflow.agentParticipantId !== tool.agentParticipantId
  ) return null;

  const planMessage = await message(context, tool.planMessageId);
  if (!planMessage) return null;
  const planMetadata = record(planMessage.metadata);
  const planWorkflow = workflowMetadata(planMetadata);
  const plan = coreToolPlanMetadata(planMetadata);
  if (
    !plan || plan.planId !== tool.planId || plan.planSize !== tool.planSize ||
    text(planMessage.id) !== tool.planMessageId ||
    text(planMessage.threadId) !== tool.threadId ||
    text(planMessage.senderId) !== tool.agentParticipantId ||
    planWorkflow?.kind !== "agent_output" ||
    planWorkflow.sourceMessageId !== tool.triggerMessageId ||
    planWorkflow.agentParticipantId !== tool.agentParticipantId
  ) return null;

  return Object.freeze({
    messageId: toolMessage.id,
    triggerMessageId: tool.triggerMessageId,
    threadId: tool.threadId,
    participantId: tool.agentParticipantId,
    agentId: tool.agentId,
    plan: Object.freeze({
      planId: tool.planId,
      planMessageId: tool.planMessageId,
      triggerMessageId: tool.triggerMessageId,
      planSize: tool.planSize,
    }),
  });
}

async function causalAnchors(
  context: Pick<RuntimeContext, "collections">,
  sourceMessageId: string,
  owner: Readonly<{
    threadId: string;
    participantId: string;
    agentId: string;
  }>,
): Promise<readonly GoalCausalAnchor[] | null> {
  const result: GoalCausalAnchor[] = [];
  const seen = new Set<string>();
  let cursor = sourceMessageId;
  while (true) {
    if (!cursor || seen.has(cursor)) return null;
    seen.add(cursor);
    const source = await message(context, cursor);
    if (!source) return null;
    const sourceWorkflow = workflowMetadata(record(source.metadata));
    if (sourceWorkflow?.kind !== "tool_result") {
      if (text(source.threadId) !== owner.threadId) return null;
      result.push({ awaitingMessageId: cursor, planId: null });
      return Object.freeze(result);
    }
    const step = await validatedFinalToolStep(context, source);
    if (
      !step || step.threadId !== owner.threadId ||
      step.participantId !== owner.participantId ||
      step.agentId !== owner.agentId ||
      seen.has(step.plan.planMessageId) || seen.has(step.triggerMessageId)
    ) return null;
    seen.add(step.plan.planMessageId);
    result.push(
      { awaitingMessageId: cursor, planId: step.plan.planId },
      {
        awaitingMessageId: step.triggerMessageId,
        planId: step.plan.planId,
      },
    );
    cursor = step.triggerMessageId;
  }
}

/** Finds a running Goal at any validated cursor in a consecutive Tool chain. */
export async function resolveGoalCausality(
  context: Pick<RuntimeContext, "collections">,
  input: Readonly<{
    sourceMessageId: string;
    threadId: string;
    participantId: string;
    agentId: string;
  }>,
): Promise<GoalCausality | null> {
  const anchors = await causalAnchors(context, input.sourceMessageId, input);
  if (
    !anchors?.length || !context.collections.goal?.queries.byAwaitingMessageId
  ) {
    return null;
  }
  const unique = new Map<string, GoalCausalAnchor>();
  for (const anchor of anchors) {
    unique.set(`${anchor.awaitingMessageId}\0${anchor.planId ?? ""}`, anchor);
  }
  const normalizedAnchors = Object.freeze([...unique.values()]);
  for (const anchor of normalizedAnchors) {
    const candidates = await context.collections.goal.queries
      .byAwaitingMessageId({ awaitingMessageId: anchor.awaitingMessageId });
    for (const candidate of candidates) {
      const goal = asGoalRecord(candidate);
      if (
        goal.status !== "running" || goal.phase === "done" ||
        goal.expectedThreadId !== input.threadId ||
        goal.expectedParticipantId !== input.participantId ||
        currentPlanId(goal) !== anchor.planId ||
        expectedAgentId(goal) !== input.agentId
      ) continue;
      return Object.freeze({ goal, anchors: normalizedAnchors });
    }
  }
  return null;
}

export async function finalToolStep(
  context: Pick<RuntimeContext, "collections">,
  messageId: string,
): Promise<ValidatedToolStep | null> {
  const candidate = await message(context, messageId);
  return candidate ? await validatedFinalToolStep(context, candidate) : null;
}
