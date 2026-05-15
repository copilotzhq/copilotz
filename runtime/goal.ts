import type { Agent, MessagePayload } from "@/types/index.ts";
import type { RunHandle, RunOptions, StreamEvent } from "@/runtime/index.ts";

export type GoalStatus =
  | "completed"
  | "failed"
  | "stopped"
  | "cancelled"
  | "error";
export type GoalPhase = "target" | "lead" | "judge";

export type GoalSender = NonNullable<MessagePayload["sender"]> & {
  usingAgent: string | Agent;
};

export interface GoalTranscriptMessage {
  turn: number;
  phase: GoalPhase;
  senderId?: string | null;
  senderName?: string | null;
  senderType?: string | null;
  content: string;
}

export interface GoalStopContext {
  id: string;
  turns: number;
  threadId: string;
  leadThreadId?: string;
  transcript: GoalTranscriptMessage[];
  events: GoalStreamEvent[];
  lastMessage?: GoalTranscriptMessage;
}

export interface GoalStopResult {
  stop: boolean;
  status?: GoalStatus;
  reason?: string;
}

export type GoalStopCallback = (
  context: GoalStopContext,
) => boolean | GoalStopResult | Promise<boolean | GoalStopResult>;

export interface GoalAssessment {
  name?: string;
  status: "completed" | "failed" | "warning";
  score?: number;
  report?: string;
  metadata?: Record<string, unknown>;
}

export interface GoalRunResult {
  handle: RunHandle;
  events: StreamEvent[];
  finalMessage?: GoalTranscriptMessage;
  text: string;
}

export interface GoalEvaluateContext {
  id: string;
  threadId: string;
  leadThreadId?: string;
  turns: number;
  transcript: GoalTranscriptMessage[];
  events: GoalStreamEvent[];
  run: (
    message: MessagePayload,
    options?: RunOptions,
  ) => Promise<GoalRunResult>;
}

export type GoalEvaluateCallback = (
  context: GoalEvaluateContext,
) =>
  | GoalAssessment
  | GoalAssessment[]
  | undefined
  | Promise<GoalAssessment | GoalAssessment[] | undefined>;

export type GoalOptions =
  & Omit<MessagePayload, "sender">
  & RunOptions
  & {
    sender: GoalSender;
    maxTurns?: number;
    stop?: GoalStopCallback;
    evaluate?: GoalEvaluateCallback;
  };

export interface GoalStoppedEvent {
  type: "GOAL_STOPPED";
  payload: {
    goalId: string;
    threadId: string;
    leadThreadId?: string;
    turn: number;
    status: GoalStatus;
    reason?: string;
  };
}

export interface GoalResultEvent {
  type: "GOAL_RESULT";
  payload: GoalResult;
}

export type GoalStreamEvent = StreamEvent | GoalStoppedEvent | GoalResultEvent;

export interface GoalResult {
  id: string;
  status: GoalStatus;
  score?: number;
  report?: string;
  reason?: string;
  threadId: string;
  leadThreadId?: string;
  turns: number;
  transcript: GoalTranscriptMessage[];
  events: GoalStreamEvent[];
  assessments: GoalAssessment[];
  metrics: {
    durationMs: number;
    targetRuns: number;
    leadRuns: number;
    judgeRuns: number;
    messages: number;
    toolCalls: number;
    errors: number;
  };
}

export interface GoalHandle {
  id: string;
  threadId: string;
  leadThreadId: string;
  status: "running";
  events: AsyncIterable<GoalStreamEvent>;
  done: Promise<GoalResult>;
  cancel: () => void;
}

export interface CreateGoalHandleOptions {
  performRun: (
    message: MessagePayload,
    options?: RunOptions,
  ) => Promise<RunHandle>;
  agents: Agent[];
  input: GoalOptions;
}

class AsyncQueue<T> implements AsyncIterable<T> {
  private buffer: T[] = [];
  private resolvers: Array<(value: IteratorResult<T>) => void> = [];
  private closed = false;
  private errorValue: unknown | null = null;

  push(item: T): void {
    if (this.closed || this.errorValue) return;
    const resolve = this.resolvers.shift();
    if (resolve) {
      resolve({ value: item, done: false });
    } else {
      this.buffer.push(item);
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    while (this.resolvers.length > 0) {
      this.resolvers.shift()!({ value: undefined as T, done: true });
    }
  }

  error(error: unknown): void {
    if (this.closed || this.errorValue) return;
    this.errorValue = error;
    while (this.resolvers.length > 0) {
      const resolve = this.resolvers.shift()!;
      resolve({ value: undefined as T, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        if (this.errorValue) return Promise.reject(this.errorValue);
        if (this.buffer.length > 0) {
          return Promise.resolve({ value: this.buffer.shift()!, done: false });
        }
        if (this.closed) {
          return Promise.resolve({ value: undefined as T, done: true });
        }
        return new Promise<IteratorResult<T>>((resolve) => {
          this.resolvers.push(resolve);
        });
      },
    };
  }
}

function splitGoalOptions(input: GoalOptions): {
  message: MessagePayload;
  runOptions: RunOptions;
  maxTurns: number;
  stop?: GoalStopCallback;
  evaluate?: GoalEvaluateCallback;
  lead: string | Agent;
} {
  const {
    ackMode,
    signal,
    queueTTL,
    traceId: _traceId,
    eventMetadata: _eventMetadata,
    namespace,
    schema,
    agents,
    tools,
    stream,
    maxTurns,
    stop,
    evaluate,
    sender,
    ...messageRest
  } = input;
  const { usingAgent, ...senderForRun } = sender;

  return {
    message: {
      ...messageRest,
      sender: senderForRun,
    } as MessagePayload,
    runOptions: {
      ackMode,
      signal,
      queueTTL,
      namespace,
      schema,
      agents,
      tools,
      stream,
    },
    maxTurns: maxTurns ?? 20,
    stop,
    evaluate,
    lead: usingAgent,
  };
}

function getAgentKey(agent: Agent): string {
  return agent.id ?? agent.name;
}

function resolveLeadAgent(
  lead: string | Agent,
  agents: Agent[],
): Agent {
  if (typeof lead !== "string") return lead;
  const found = agents.find((agent) =>
    agent.id === lead || agent.name === lead
  );
  if (!found) {
    throw new Error(`Goal lead agent not found: ${lead}`);
  }
  return found;
}

function resolveTargetAgentId(message: MessagePayload): string {
  if (typeof message.target === "string" && message.target.trim().length > 0) {
    return message.target.trim();
  }
  const participant = message.thread?.participants?.find((value) =>
    typeof value === "string" && value.trim().length > 0
  );
  if (participant) return participant;
  throw new Error(
    "copilotz.goal requires a target or thread participant for the tested agent.",
  );
}

function withAgent(baseAgents: Agent[] | undefined, agent: Agent): Agent[] {
  const source = baseAgents ?? [];
  const key = getAgentKey(agent);
  return [
    agent,
    ...source.filter((candidate) => getAgentKey(candidate) !== key),
  ];
}

function contentToText(content: MessagePayload["content"]): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => {
    if (!part || typeof part !== "object") return "";
    if ("text" in part && typeof part.text === "string") return part.text;
    if ("value" in part) return JSON.stringify(part.value);
    return "";
  }).filter(Boolean).join("\n");
}

function eventMetadata(event: StreamEvent): Record<string, unknown> {
  const metadata = (event as { metadata?: unknown }).metadata;
  return metadata && typeof metadata === "object" && !Array.isArray(metadata)
    ? metadata as Record<string, unknown>
    : {};
}

function annotateEvent(
  event: StreamEvent,
  goalId: string,
  turn: number,
  phase: GoalPhase,
): StreamEvent {
  if (!event || typeof event !== "object") return event;
  return {
    ...event,
    metadata: {
      ...eventMetadata(event),
      goalId,
      goalTurn: turn,
      goalPhase: phase,
    },
  } as StreamEvent;
}

function transcriptMessageFromEvent(
  event: StreamEvent,
  turn: number,
  phase: GoalPhase,
): GoalTranscriptMessage | undefined {
  if (event.type !== "NEW_MESSAGE") return undefined;
  const payload = event.payload as MessagePayload;
  const content = contentToText(payload.content);
  if (!content) return undefined;
  return {
    turn,
    phase,
    senderId: payload.sender?.id ?? null,
    senderName: payload.sender?.name ?? null,
    senderType: payload.sender?.type ?? null,
    content,
  };
}

function isMessageFromAgent(
  message: GoalTranscriptMessage,
  agentId: string,
): boolean {
  return message.senderType === "agent" &&
    (message.senderId === agentId || message.senderName === agentId);
}

function summarizeAssessments(assessments: GoalAssessment[]): {
  status?: GoalStatus;
  score?: number;
  report?: string;
} {
  if (assessments.length === 0) return {};
  const failed = assessments.some((assessment) =>
    assessment.status === "failed"
  );
  const scores = assessments
    .map((assessment) => assessment.score)
    .filter((score): score is number => typeof score === "number");
  return {
    status: failed ? "failed" : "completed",
    score: scores.length > 0
      ? scores.reduce((sum, score) => sum + score, 0) / scores.length
      : undefined,
    report: assessments.map((assessment) => assessment.report).filter((
      report,
    ): report is string => typeof report === "string" && report.length > 0)
      .join("\n\n") || undefined,
  };
}

function normalizeStopResult(
  result: boolean | GoalStopResult | undefined,
): GoalStopResult {
  if (typeof result === "boolean") return { stop: result };
  return result ?? { stop: false };
}

function messageThread(
  input: unknown,
): NonNullable<MessagePayload["thread"]> | undefined {
  const thread = (input as { thread?: unknown })?.thread;
  return thread && typeof thread === "object"
    ? thread as NonNullable<MessagePayload["thread"]>
    : undefined;
}

async function collectRun(
  handle: RunHandle,
  args: {
    goalId: string;
    turn: number;
    phase: GoalPhase;
    expectedAgentId?: string;
    queue: AsyncQueue<GoalStreamEvent>;
    events: GoalStreamEvent[];
    transcript: GoalTranscriptMessage[];
  },
): Promise<GoalRunResult> {
  const runEvents: StreamEvent[] = [];
  let finalMessage: GoalTranscriptMessage | undefined;

  for await (const rawEvent of handle.events) {
    const event = annotateEvent(rawEvent, args.goalId, args.turn, args.phase);
    runEvents.push(event);
    args.events.push(event);
    args.queue.push(event);

    const transcriptMessage = transcriptMessageFromEvent(
      event,
      args.turn,
      args.phase,
    );
    if (transcriptMessage) {
      args.transcript.push(transcriptMessage);
      if (
        !args.expectedAgentId ||
        isMessageFromAgent(transcriptMessage, args.expectedAgentId)
      ) {
        finalMessage = transcriptMessage;
      }
    }
  }

  await handle.done;

  return {
    handle,
    events: runEvents,
    finalMessage,
    text: finalMessage?.content ?? "",
  };
}

export async function createGoalHandle(
  options: CreateGoalHandleOptions,
): Promise<GoalHandle> {
  const goalId = crypto.randomUUID();
  const startedAt = performance.now();
  const queue = new AsyncQueue<GoalStreamEvent>();
  const allEvents: GoalStreamEvent[] = [];
  const transcript: GoalTranscriptMessage[] = [];
  const controllers: RunHandle[] = [];
  let cancelled = false;
  const initialThread = messageThread(options.input);
  let mainThreadId = typeof initialThread?.id === "string"
    ? initialThread.id
    : "";
  const initialMainThreadExternalId =
    typeof initialThread?.externalId === "string"
      ? initialThread.externalId
      : goalId;
  let leadThreadId = `${goalId}:lead`;

  const done = (async (): Promise<GoalResult> => {
    const {
      message,
      runOptions,
      maxTurns,
      stop,
      evaluate,
      lead,
    } = splitGoalOptions(options.input);
    const targetAgentId = resolveTargetAgentId(message);
    const leadAgent = resolveLeadAgent(lead, options.agents);
    const leadAgentId = getAgentKey(leadAgent);
    let turns = 0;
    let currentContent = contentToText(message.content);
    let status: GoalStatus = "stopped";
    let reason: string | undefined;
    let stopEmitted = false;
    const metrics = {
      targetRuns: 0,
      leadRuns: 0,
      judgeRuns: 0,
      errors: 0,
    };

    const emitStopped = () => {
      if (stopEmitted) return;
      stopEmitted = true;
      const event: GoalStoppedEvent = {
        type: "GOAL_STOPPED",
        payload: {
          goalId,
          threadId: mainThreadId || initialMainThreadExternalId,
          leadThreadId,
          turn: turns,
          status,
          reason,
        },
      };
      allEvents.push(event);
      queue.push(event);
    };

    const runAndCollect = async (
      runMessage: MessagePayload,
      phase: GoalPhase,
      expectedAgentId?: string,
      overrideOptions?: RunOptions,
    ): Promise<GoalRunResult> => {
      const handle = await options.performRun(runMessage, {
        ...runOptions,
        ...overrideOptions,
        traceId: `${goalId}:${phase}:${turns}:${crypto.randomUUID()}`,
        eventMetadata: {
          ...(runOptions.eventMetadata ?? {}),
          goalId,
          goalTurn: turns,
          goalPhase: phase,
        },
      });
      controllers.push(handle);
      return await collectRun(handle, {
        goalId,
        turn: turns,
        phase,
        expectedAgentId,
        queue,
        events: allEvents,
        transcript,
      });
    };

    const evaluateRun = async (
      runMessage: MessagePayload,
      overrideOptions?: RunOptions,
    ): Promise<GoalRunResult> => {
      metrics.judgeRuns++;
      return await runAndCollect(
        runMessage,
        "judge",
        undefined,
        overrideOptions,
      );
    };

    try {
      while (!cancelled && turns < maxTurns) {
        turns++;
        metrics.targetRuns++;
        const targetRun = await runAndCollect(
          {
            ...message,
            content: currentContent,
            sender: message.sender,
            target: targetAgentId,
            thread: {
              ...(message.thread ?? {}),
              ...(mainThreadId
                ? { id: mainThreadId }
                : { externalId: initialMainThreadExternalId }),
              participants: message.thread?.participants ?? [targetAgentId],
            },
          },
          "target",
          targetAgentId,
        );
        mainThreadId = targetRun.handle.threadId;

        if (!targetRun.finalMessage) {
          status = "error";
          reason =
            `No final message produced by target agent "${targetAgentId}".`;
          metrics.errors++;
          break;
        }

        const stopContext: GoalStopContext = {
          id: goalId,
          turns,
          threadId: mainThreadId || initialMainThreadExternalId,
          leadThreadId,
          transcript,
          events: allEvents,
          lastMessage: targetRun.finalMessage,
        };
        const stopResult = normalizeStopResult(await stop?.(stopContext));
        if (stopResult.stop) {
          status = stopResult.status ?? "stopped";
          reason = stopResult.reason;
          break;
        }

        if (turns >= maxTurns) {
          status = "stopped";
          reason = `Maximum turns reached (${maxTurns}).`;
          break;
        }

        metrics.leadRuns++;
        const leadRun = await runAndCollect(
          {
            content: targetRun.finalMessage.content,
            sender: {
              id: `${goalId}:target`,
              type: "user",
              name: targetAgentId,
            },
            target: leadAgentId,
            thread: {
              externalId: `${goalId}:lead`,
              ...(leadThreadId && !leadThreadId.includes(":")
                ? { id: leadThreadId }
                : {}),
              participants: [targetAgentId, leadAgentId],
              metadata: {
                goalId,
                goalThreadId: mainThreadId || initialMainThreadExternalId,
                lead: true,
              },
            },
          },
          "lead",
          leadAgentId,
          {
            agents: withAgent(
              runOptions.agents ?? options.agents,
              leadAgent,
            ),
          },
        );
        leadThreadId = leadRun.handle.threadId;

        if (!leadRun.finalMessage) {
          status = "error";
          reason = `No final message produced by lead agent "${leadAgentId}".`;
          metrics.errors++;
          break;
        }

        currentContent = leadRun.finalMessage.content;
      }

      if (cancelled) {
        status = "cancelled";
        reason = "Goal cancelled.";
      } else if (turns >= maxTurns && !reason) {
        status = "stopped";
        reason = `Maximum turns reached (${maxTurns}).`;
      }
    } catch (error) {
      status = "error";
      reason = error instanceof Error ? error.message : String(error);
      metrics.errors++;
    }

    emitStopped();

    let assessments: GoalAssessment[] = [];
    if (evaluate) {
      try {
        const output = await evaluate({
          id: goalId,
          threadId: mainThreadId || initialMainThreadExternalId,
          leadThreadId,
          turns,
          transcript,
          events: allEvents,
          run: evaluateRun,
        });
        assessments = Array.isArray(output) ? output : output ? [output] : [];
      } catch (error) {
        metrics.errors++;
        assessments = [{
          name: "evaluate",
          status: "failed",
          report: error instanceof Error ? error.message : String(error),
        }];
      }
    }

    const assessmentSummary = summarizeAssessments(assessments);
    if (assessmentSummary.status) {
      status = assessmentSummary.status;
    }

    const result: GoalResult = {
      id: goalId,
      status,
      score: assessmentSummary.score,
      report: assessmentSummary.report,
      reason,
      threadId: mainThreadId || initialMainThreadExternalId,
      leadThreadId,
      turns,
      transcript,
      events: [...allEvents],
      assessments,
      metrics: {
        durationMs: Number((performance.now() - startedAt).toFixed(1)),
        targetRuns: metrics.targetRuns,
        leadRuns: metrics.leadRuns,
        judgeRuns: metrics.judgeRuns,
        messages: transcript.length,
        toolCalls:
          allEvents.filter((event) => event.type === "TOOL_CALL").length,
        errors: metrics.errors,
      },
    };

    const resultEvent: GoalResultEvent = {
      type: "GOAL_RESULT",
      payload: result,
    };
    allEvents.push(resultEvent);
    queue.push(resultEvent);
    queue.close();
    return result;
  })();

  done.catch((error) => queue.error(error));

  return {
    id: goalId,
    threadId: mainThreadId || initialMainThreadExternalId,
    leadThreadId,
    status: "running",
    events: queue,
    done,
    cancel: () => {
      cancelled = true;
      for (const controller of controllers) controller.cancel();
    },
  };
}
