/** Run a bounded goal through a context-supplied conversation Adapter. @module */
import {
  type ActionContext,
  type ActionDefinition,
  defineAction,
} from "@copilotz/copilotz/actions";
import type {
  ApplicationOutput,
  ApplicationSendHandle,
  ApplicationSendInput,
} from "@copilotz/copilotz/application";
import type { ContentSequence } from "@copilotz/copilotz/content";
import type { ResolvedCopilotzEvent } from "@copilotz/copilotz/events";
import type { StreamOutput } from "@copilotz/copilotz/streams";
import {
  type CoreMessageInput,
  message,
} from "../../processors/message-input/input/index.ts";
import { workflowMetadata } from "../../shared/workflow-metadata.ts";
import type { GoalPolicy } from "../../resources/goals/default/index.ts";
type GoalSendHandle = Pick<
  ApplicationSendHandle,
  "eventId" | "correlationId" | "outputs" | "done" | "cancel"
>;
/** Host-owned conversation boundary; an existing application can supply its send capability directly. */
export interface GoalConversationAdapter {
  send(input: ApplicationSendInput): Promise<GoalSendHandle>;
}
export type RunGoalInput = {
  target: GoalScope;
  lead: GoalScope;
  content: CoreMessageInput["content"];
  policy?: string;
  maxTurns?: number;
};
export type GoalPhase = "target" | "lead";
export type GoalStatus = "completed" | "failed" | "stopped";

/** One explicit Core Message scope used by the local Goal loop. */
export type GoalScope = Readonly<{
  thread: CoreMessageInput["thread"];
  participant: CoreMessageInput["participant"];
  recipient: string;
  metadata?: Readonly<Record<string, unknown>>;
  visibility?: CoreMessageInput["visibility"];
}>;

/** Canonical Message reference recorded after one complete Agent turn. */
export type GoalTurn = Readonly<{
  turn: number;
  phase: GoalPhase;
  correlationId: string;
  inputMessageId: string;
  outputMessageId: string;
  threadId: string;
  senderId: string;
  content: ContentSequence;
}>;

export type GoalOutcome = Readonly<{
  status: "completed" | "failed" | "stopped";
  reason?: string;
}>;

export type GoalDecision = "continue" | GoalOutcome;

export type GoalDecisionContext = Readonly<{
  id: string;
  turn: number;
  targetReply: GoalTurn;
  transcript: readonly GoalTurn[];
}>;

export type GoalMetrics = Readonly<{
  durationMs: number;
  targetTurns: number;
  leadTurns: number;
}>;

export type GoalResult = Readonly<{
  id: string;
  status: GoalStatus;
  reason?: string;
  turns: number;
  finalMessageId?: string;
  transcript: readonly GoalTurn[];
  metrics: GoalMetrics;
}>;

type MessageRecord = Readonly<{
  id: string;
  threadId: string;
  senderId: string;
  recipientIds: readonly string[];
  content: ContentSequence;
  metadata: Readonly<Record<string, unknown>>;
}>;

type ObservedMessage = Readonly<{
  event: Extract<ResolvedCopilotzEvent, { durable: true }>;
  record: MessageRecord;
}>;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function requiredText(value: unknown, name: string): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) throw new TypeError(`${name} must be non-empty.`);
  return normalized;
}

function isStreamOutput(output: ApplicationOutput): output is StreamOutput {
  return output.type === "stream.output" &&
    "payload" in output && output.payload instanceof ReadableStream;
}

function messageRecord(output: ApplicationOutput): ObservedMessage | null {
  if (isStreamOutput(output) || !output.durable) return null;
  if (output.type !== "message.created" || output.subject?.type !== "message") {
    return null;
  }
  const body = record(output.data);
  const candidate = record(body.record);
  const id = typeof candidate.id === "string" ? candidate.id : "";
  const threadId = typeof candidate.threadId === "string"
    ? candidate.threadId
    : "";
  const senderId = typeof candidate.senderId === "string"
    ? candidate.senderId
    : "";
  const recipientIds = Array.isArray(candidate.recipientIds) &&
      candidate.recipientIds.every((item) => typeof item === "string")
    ? candidate.recipientIds as readonly string[]
    : [];
  const content = Array.isArray(candidate.content)
    ? candidate.content as ContentSequence
    : null;
  if (!id || !threadId || !senderId || !content) return null;
  return ({
    event: output,
    record: {
      id,
      threadId,
      senderId,
      recipientIds: [...recipientIds] as const,
      content: structuredClone(content),
      metadata: structuredClone(record(candidate.metadata)),
    } as const,
  } as const);
}

function positionAfter(left: string, right: string): boolean {
  try {
    return BigInt(left) > BigInt(right);
  } catch {
    return left.length === right.length
      ? left > right
      : left.length > right.length;
  }
}

function terminalAgentOutput(message: ObservedMessage): boolean {
  const metadata = message.record.metadata;
  if (workflowMetadata(metadata)?.kind !== "agent_output") return false;
  const toolCalls = metadata.llmToolCalls;
  return !Array.isArray(toolCalls) || toolCalls.length === 0;
}

function goalMetadata(
  scope: GoalScope,
  id: string,
  turn: number,
  phase: GoalPhase,
): Record<string, unknown> {
  return {
    ...structuredClone(scope.metadata ?? {}),
    copilotzGoal: { id, turn, phase },
  };
}

function validateScope(scope: GoalScope, name: string): GoalScope {
  if (!scope || typeof scope !== "object" || Array.isArray(scope)) {
    throw new TypeError(`${name} scope must be an object.`);
  }
  requiredText(scope.recipient, `${name} recipient`);
  if (typeof scope.thread === "string") {
    requiredText(scope.thread, `${name} thread`);
  } else {
    const thread = record(scope.thread);
    if (
      !requiredOptionalText(thread.id) &&
      !requiredOptionalText(thread.externalId)
    ) {
      throw new TypeError(`${name} thread requires id or externalId.`);
    }
  }
  if (typeof scope.participant === "string") {
    requiredText(scope.participant, `${name} participant`);
  } else {
    const participant = record(scope.participant);
    if (
      !requiredOptionalText(participant.id) &&
      !requiredOptionalText(participant.externalId)
    ) {
      throw new TypeError(`${name} participant requires id or externalId.`);
    }
  }
  return structuredClone(scope);
}

function requiredOptionalText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function decision(value: unknown): GoalDecision {
  if (value === "continue") return value;
  const candidate = record(value);
  if (
    candidate.status !== "completed" && candidate.status !== "failed" &&
    candidate.status !== "stopped"
  ) {
    throw new TypeError(
      "Goal decide must return 'continue' or a completed, failed, or stopped outcome.",
    );
  }
  const reason = requiredOptionalText(candidate.reason);
  return ({
    status: candidate.status,
    ...(reason ? { reason } : {}),
  } as const);
}

async function completedTurn(
  application: GoalConversationAdapter,
  input: Readonly<{
    goalId: string;
    namespace: string;
    databaseSchema: string;
    turn: number;
    phase: GoalPhase;
    scope: GoalScope;
    content: CoreMessageInput["content"];
    setActive(handle?: GoalSendHandle): void;
  }>,
): Promise<GoalTurn> {
  const handle = await application.send({
    ...message({
      deduplicationId: `${input.goalId}:${input.turn}:${input.phase}`,
      thread: input.scope.thread,
      participant: input.scope.participant,
      recipientIds: [requiredText(input.scope.recipient, "Goal recipient")],
      content: input.content,
      metadata: goalMetadata(
        input.scope,
        input.goalId,
        input.turn,
        input.phase,
      ),
      ...(input.scope.visibility ? { visibility: input.scope.visibility } : {}),
    }),
    namespace: input.namespace,
    databaseSchema: input.databaseSchema,
  });
  input.setActive(handle);
  const messages: ObservedMessage[] = [];
  try {
    for await (const output of handle.outputs) {
      const observed = messageRecord(output);
      if (observed) messages.push(observed);
    }
    await handle.done;
  } catch (error) {
    await handle.cancel("goal_turn_failed").catch(() => undefined);
    throw error;
  } finally {
    input.setActive(undefined);
  }

  const ingress = messages.find((item) => item.record.id === handle.eventId);
  if (!ingress) {
    throw new Error(
      `Goal ${input.phase} turn ${input.turn} did not project its input Message.`,
    );
  }
  if (ingress.record.recipientIds.length !== 1) {
    throw new Error(
      `Goal ${input.phase} turn ${input.turn} requires exactly one resolved Agent recipient.`,
    );
  }
  const expectedSenderId = ingress.record.recipientIds[0];
  let final: ObservedMessage | undefined;
  for (const candidate of messages) {
    if (
      candidate.record.senderId !== expectedSenderId ||
      !terminalAgentOutput(candidate)
    ) continue;
    if (
      !final || positionAfter(candidate.event.position, final.event.position)
    ) {
      final = candidate;
    }
  }
  if (!final) {
    throw new Error(
      `Goal ${input.phase} turn ${input.turn} settled without a final Agent Message.`,
    );
  }
  return ({
    turn: input.turn,
    phase: input.phase,
    correlationId: handle.correlationId,
    inputMessageId: ingress.record.id,
    outputMessageId: final.record.id,
    threadId: final.record.threadId,
    senderId: final.record.senderId,
    content: final.record.content,
  } as const);
}

export const runGoalAction: ActionDefinition<RunGoalInput, GoalResult> =
  defineAction({
    id: "copilotz.core.goal.run",
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "object" },
        lead: { type: "object" },
        content: {},
        policy: { type: "string" },
        maxTurns: { type: "integer", minimum: 1, maximum: 1000 },
      },
      required: ["target", "lead", "content"],
      additionalProperties: false,
    } as const,
    async execute(
      input: RunGoalInput,
      context: ActionContext,
    ): Promise<GoalResult> {
      const policy = context.resources.goals?.[input.policy ?? "default"] as
        | GoalPolicy
        | undefined;
      if (!policy) throw new Error("Goal policy is not configured.");
      const adapter = context.adapters.conversation
        ?.[policy.adapter ?? "default"] as GoalConversationAdapter | undefined;
      if (!adapter || typeof adapter.send !== "function") {
        throw new Error("Goal conversation Adapter is not configured.");
      }
      const id = context.action.runId;
      const target = validateScope(input.target, "Target"),
        lead = validateScope(input.lead, "Lead");
      const maxTurns = input.maxTurns ?? policy.maxTurns;
      if (!Number.isSafeInteger(maxTurns) || maxTurns < 1 || maxTurns > 1000) {
        throw new TypeError(
          "Goal maxTurns must be an integer from 1 through 1000.",
        );
      }
      const transcript: GoalTurn[] = [];
      let active: GoalSendHandle | undefined;
      const abort = () => {
        void active?.cancel("Goal action cancelled").catch(() => undefined);
      };
      context.signal.addEventListener("abort", abort, { once: true });
      const started = context.now().getTime();
      let status: GoalStatus = "stopped",
        reason: string | undefined,
        finalMessageId: string | undefined;
      let targetTurns = 0, leadTurns = 0;
      try {
        let content = structuredClone(input.content);
        for (let turn = 1; turn <= maxTurns; turn++) {
          context.signal.throwIfAborted();
          const targetReply = await completedTurn(adapter, {
            goalId: id,
            namespace: context.namespace,
            databaseSchema: context.databaseSchema,
            turn,
            phase: "target",
            scope: target,
            content,
            setActive(handle) {
              active = handle;
              if (context.signal.aborted) abort();
            },
          });
          context.signal.throwIfAborted();
          transcript.push(targetReply);
          targetTurns++;
          finalMessageId = targetReply.outputMessageId;
          await context.progress({
            type: "goal.turn.completed",
            goalId: id,
            turn: targetReply,
          });
          const outcome = policy.decide
            ? decision(
              await policy.decide({
                id,
                turn,
                targetReply,
                transcript: structuredClone(transcript),
              }),
            )
            : "continue";
          context.signal.throwIfAborted();
          if (outcome !== "continue") {
            status = outcome.status;
            reason = outcome.reason;
            break;
          }
          if (turn === maxTurns) {
            reason = `Maximum turns reached (${maxTurns}).`;
            break;
          }
          const leadReply = await completedTurn(adapter, {
            goalId: id,
            namespace: context.namespace,
            databaseSchema: context.databaseSchema,
            turn,
            phase: "lead",
            scope: lead,
            content: targetReply.content,
            setActive(handle) {
              active = handle;
              if (context.signal.aborted) abort();
            },
          });
          context.signal.throwIfAborted();
          transcript.push(leadReply);
          leadTurns++;
          await context.progress({
            type: "goal.turn.completed",
            goalId: id,
            turn: leadReply,
          });
          content = leadReply.content;
        }
        return {
          id,
          status,
          ...(reason ? { reason } : {}),
          turns: targetTurns,
          ...(finalMessageId ? { finalMessageId } : {}),
          transcript,
          metrics: {
            durationMs: context.now().getTime() - started,
            targetTurns,
            leadTurns,
          },
        };
      } catch (error) {
        context.signal.throwIfAborted();
        throw error;
      } finally {
        context.signal.removeEventListener("abort", abort);
      }
    },
  });
export default runGoalAction;
