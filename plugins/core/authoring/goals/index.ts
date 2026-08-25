/** Runs minimal Goal conversations over settled Core application sends. @module */

import type {
  ApplicationOutput,
  ApplicationSendHandle,
  CopilotzApplication,
} from "@copilotz/copilotz/application";
import type { ContentSequence } from "@copilotz/copilotz/content";
import type { ResolvedCopilotzEvent } from "@copilotz/copilotz/events";
import type { StreamOutput } from "@copilotz/copilotz/streams";
import {
  type CoreMessageInput,
  message,
} from "../../../core-collections/authoring/message-input/index.ts";
import { workflowMetadata } from "../../internal/workflow-metadata.ts";

export type GoalPhase = "target" | "lead";
export type GoalStatus = "completed" | "failed" | "stopped" | "cancelled";

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

export type GoalOutputContext = Readonly<{
  id: string;
  turn: number;
  phase: GoalPhase;
}>;

export type RunGoalOptions = Readonly<{
  id?: string;
  target: GoalScope;
  lead: GoalScope;
  content: CoreMessageInput["content"];
  maxTurns?: number;
  decide?: (
    context: GoalDecisionContext,
  ) => GoalDecision | Promise<GoalDecision>;
  onOutput?: (
    output: ApplicationOutput,
    context: GoalOutputContext,
  ) => void | Promise<void>;
  signal?: AbortSignal;
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

export type GoalTurnCompletedEvent = Readonly<{
  type: "goal.turn.completed";
  payload: Readonly<{ goalId: string; turn: GoalTurn }>;
}>;

export type GoalFinishedEvent = Readonly<{
  type: "goal.finished";
  payload: GoalResult;
}>;

export type GoalEvent = GoalTurnCompletedEvent | GoalFinishedEvent;

export type GoalHandle = Readonly<{
  id: string;
  events: ReadableStream<GoalEvent>;
  done: Promise<GoalResult>;
  cancel(reason?: string): Promise<void>;
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

function frozenClone<T>(value: T): T {
  const clone = structuredClone(value);
  const seen = new WeakSet<object>();
  const freeze = (candidate: unknown): void => {
    if (
      !candidate || typeof candidate !== "object" ||
      Object.isFrozen(candidate) || ArrayBuffer.isView(candidate) ||
      seen.has(candidate)
    ) return;
    seen.add(candidate);
    for (const child of Object.values(candidate)) freeze(child);
    Object.freeze(candidate);
  };
  freeze(clone);
  return clone;
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
  return Object.freeze({
    event: output,
    record: Object.freeze({
      id,
      threadId,
      senderId,
      recipientIds: Object.freeze([...recipientIds]),
      content: frozenClone(content),
      metadata: frozenClone(record(candidate.metadata)),
    }),
  });
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
  return frozenClone(scope);
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
  return Object.freeze({
    status: candidate.status,
    ...(reason ? { reason } : {}),
  });
}

function errorMessage(
  error: unknown,
  fallback = "Unknown Goal failure.",
): string {
  const message = error instanceof Error && error.message.trim()
    ? error.message
    : String(error);
  return message.trim() || fallback;
}

async function completedTurn(
  application: CopilotzApplication,
  input: Readonly<{
    goalId: string;
    turn: number;
    phase: GoalPhase;
    scope: GoalScope;
    content: CoreMessageInput["content"];
    onOutput?: RunGoalOptions["onOutput"];
    setActive(handle?: ApplicationSendHandle): void;
  }>,
): Promise<GoalTurn> {
  const handle = await application.send(message({
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
  }));
  input.setActive(handle);
  const messages: ObservedMessage[] = [];
  try {
    for await (const output of handle.outputs) {
      const observed = messageRecord(output);
      if (observed) messages.push(observed);
      await input.onOutput?.(
        output,
        Object.freeze({
          id: input.goalId,
          turn: input.turn,
          phase: input.phase,
        }),
      );
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
  return Object.freeze({
    turn: input.turn,
    phase: input.phase,
    correlationId: handle.correlationId,
    inputMessageId: ingress.record.id,
    outputMessageId: final.record.id,
    threadId: final.record.threadId,
    senderId: final.record.senderId,
    content: final.record.content,
  });
}

/**
 * Starts one local Goal loop. Core Messages and Action Events remain the
 * durable record; this handle intentionally has no independent persistence.
 */
export function runGoal(
  application: CopilotzApplication,
  options: RunGoalOptions,
): GoalHandle {
  if (!application || typeof application.send !== "function") {
    throw new TypeError("runGoal requires a Copilotz application.");
  }
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("Goal options must be an object.");
  }
  const id = options.id === undefined
    ? crypto.randomUUID()
    : requiredText(options.id, "Goal id");
  const target = validateScope(options.target, "Target");
  const lead = validateScope(options.lead, "Lead");
  const maxTurns = options.maxTurns ?? 20;
  if (!Number.isSafeInteger(maxTurns) || maxTurns <= 0 || maxTurns > 1_000) {
    throw new TypeError(
      "Goal maxTurns must be an integer from 1 through 1000.",
    );
  }
  if (options.decide !== undefined && typeof options.decide !== "function") {
    throw new TypeError("Goal decide must be a function.");
  }
  if (
    options.onOutput !== undefined && typeof options.onOutput !== "function"
  ) {
    throw new TypeError("Goal onOutput must be a function.");
  }

  let eventController: ReadableStreamDefaultController<GoalEvent> | undefined;
  let eventStreamClosed = false;
  const events = new ReadableStream<GoalEvent>({
    start(controller) {
      eventController = controller;
    },
    cancel() {
      eventStreamClosed = true;
    },
  }, { highWaterMark: Math.min(maxTurns * 2 + 1, 2_001) });
  const emit = (event: GoalEvent): void => {
    if (eventStreamClosed) return;
    try {
      eventController?.enqueue(event);
    } catch {
      eventStreamClosed = true;
    }
  };
  const closeEvents = (): void => {
    if (eventStreamClosed) return;
    eventStreamClosed = true;
    try {
      eventController?.close();
    } catch {
      // The consumer may have cancelled its local observation.
    }
  };

  let active: ApplicationSendHandle | undefined;
  let cancelledReason = options.signal?.aborted
    ? errorMessage(options.signal.reason ?? "Goal aborted.", "Goal aborted.")
    : undefined;
  const transcript: GoalTurn[] = [];
  const startedAt = performance.now();
  let targetTurns = 0;
  let leadTurns = 0;
  let finalMessageId: string | undefined;

  const done = (async (): Promise<GoalResult> => {
    let status: GoalStatus = "stopped";
    let reason: string | undefined;
    try {
      let nextContent = frozenClone(options.content);
      for (let turn = 1; turn <= maxTurns; turn += 1) {
        if (cancelledReason) break;
        const targetReply = await completedTurn(application, {
          goalId: id,
          turn,
          phase: "target",
          scope: target,
          content: nextContent,
          onOutput: options.onOutput,
          setActive(handle) {
            active = handle;
            if (handle && cancelledReason) {
              void handle.cancel(cancelledReason).catch(() => undefined);
            }
          },
        });
        targetTurns += 1;
        transcript.push(targetReply);
        finalMessageId = targetReply.outputMessageId;
        emit(Object.freeze({
          type: "goal.turn.completed",
          payload: Object.freeze({ goalId: id, turn: targetReply }),
        }));

        if (cancelledReason) break;
        const outcome = options.decide
          ? decision(
            await options.decide(Object.freeze({
              id,
              turn,
              targetReply,
              transcript: Object.freeze([...transcript]),
            })),
          )
          : "continue";
        if (cancelledReason) break;
        if (outcome !== "continue") {
          status = outcome.status;
          reason = outcome.reason;
          break;
        }
        if (turn === maxTurns) {
          status = "stopped";
          reason = `Maximum turns reached (${maxTurns}).`;
          break;
        }

        const leadReply = await completedTurn(application, {
          goalId: id,
          turn,
          phase: "lead",
          scope: lead,
          content: targetReply.content,
          onOutput: options.onOutput,
          setActive(handle) {
            active = handle;
            if (handle && cancelledReason) {
              void handle.cancel(cancelledReason).catch(() => undefined);
            }
          },
        });
        leadTurns += 1;
        transcript.push(leadReply);
        emit(Object.freeze({
          type: "goal.turn.completed",
          payload: Object.freeze({ goalId: id, turn: leadReply }),
        }));
        nextContent = leadReply.content;
      }
      if (cancelledReason) {
        status = "cancelled";
        reason = cancelledReason;
      }
    } catch (error) {
      if (cancelledReason) {
        status = "cancelled";
        reason = cancelledReason;
      } else {
        status = "failed";
        reason = errorMessage(error);
      }
    }

    const result: GoalResult = Object.freeze({
      id,
      status,
      ...(reason ? { reason } : {}),
      turns: targetTurns,
      ...(finalMessageId ? { finalMessageId } : {}),
      transcript: Object.freeze([...transcript]),
      metrics: Object.freeze({
        durationMs: Number((performance.now() - startedAt).toFixed(1)),
        targetTurns,
        leadTurns,
      }),
    });
    emit(Object.freeze({ type: "goal.finished", payload: result }));
    closeEvents();
    return result;
  })();

  const abort = () => {
    const reason = options.signal?.reason;
    void cancelGoal(
      errorMessage(reason ?? "Goal aborted.", "Goal aborted."),
    ).catch(() => undefined);
  };
  if (!options.signal?.aborted) {
    options.signal?.addEventListener("abort", abort, { once: true });
  }

  async function cancelGoal(reasonInput = "Goal cancelled."): Promise<void> {
    if (!cancelledReason) {
      cancelledReason = requiredText(reasonInput, "Goal cancellation reason");
    }
    await active?.cancel(cancelledReason).catch(() => undefined);
  }

  void done.finally(() => {
    options.signal?.removeEventListener("abort", abort);
  }).catch(() => undefined);

  return Object.freeze({ id, events, done, cancel: cancelGoal });
}
