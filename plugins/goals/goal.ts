import type { AgentResource } from "@copilotz/copilotz/core";
import type { CollectionRecord } from "@copilotz/copilotz/collections";
import type {
  CreateGoalRuntimeOptions,
  GoalAssessment,
  GoalHandle,
  GoalInput,
  GoalJudgeRunInput,
  GoalObservedEvent,
  GoalPhase,
  GoalResult,
  GoalRunResult,
  GoalRuntime,
  GoalStatus,
  GoalStopResult,
  GoalStreamEvent,
  GoalThreadInput,
  GoalThreadRef,
  GoalTranscriptMessage,
} from "./types.ts";
import type {
  ContentInput,
  ContentSequence,
  ResolvedContent,
} from "@copilotz/copilotz/content";
import type {
  ConversationMessage,
  ConversationThread,
  Participant,
  ParticipantInput,
} from "@copilotz/copilotz/domain";
import type {
  AttachmentOutput,
  AttachmentStreamOutput,
} from "@copilotz/copilotz/attachments";
import type { ApplicationSendHandle } from "@copilotz/copilotz/application";
import { message as coreMessage } from "@copilotz/copilotz/core";

const GOAL_METADATA_KEY = "copilotzGoal";
const DEFAULT_MAX_TURNS = 20;

type StreamChannel<T> = Readonly<{
  stream: ReadableStream<T>;
  emit(value: T): void;
  close(): void;
  error(reason: unknown): void;
}>;

type PreparedGoal = Readonly<{
  namespace: string;
  databaseSchema?: string;
  targetAgent: AgentResource;
  leadAgent: AgentResource;
  targetThread: ConversationThread;
  leadThread: ConversationThread;
  sender: Participant;
  target: Participant;
  leadInput: Participant;
  lead: Participant;
}>;

function isAttachmentStreamOutput(
  output: AttachmentOutput,
): output is AttachmentStreamOutput {
  return output.type === "stream.output" && "payload" in output &&
    Boolean(
      output.payload && typeof output.payload === "object" &&
        typeof (output.payload as { getReader?: unknown }).getReader ===
          "function",
    );
}

function requiredText(value: string | undefined, name: string): string {
  const normalized = value?.trim();
  if (!normalized) throw new TypeError(`${name} must be non-empty.`);
  return normalized;
}

function optionalText(value: string | undefined, name: string) {
  if (value === undefined) return undefined;
  return requiredText(value, name);
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function optionalRecordText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function recordTextArray(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? Object.freeze(
      value.filter((item): item is string =>
        typeof item === "string" && Boolean(item.trim())
      ),
    )
    : Object.freeze([]);
}

function recordContent(value: unknown): ContentSequence {
  return Array.isArray(value)
    ? Object.freeze(value) as ContentSequence
    : Object.freeze([]);
}

// Goals consume canonical Collection records through public contracts. These
// projections are intentionally local: runtime engine helpers are not a plugin
// dependency and no plugin imports runtime implementation files.
function mapParticipantRecord(recordValue: CollectionRecord): Participant {
  return Object.freeze({
    id: String(recordValue.id),
    namespace: String(recordValue.namespace),
    externalId: String(recordValue.externalId ?? recordValue.id),
    participantType: recordValue
      .participantType as Participant["participantType"],
    ...(optionalRecordText(recordValue.name)
      ? { name: optionalRecordText(recordValue.name) }
      : {}),
    ...(optionalRecordText(recordValue.email)
      ? { email: optionalRecordText(recordValue.email) }
      : {}),
    ...(optionalRecordText(recordValue.agentId)
      ? { agentId: optionalRecordText(recordValue.agentId) }
      : {}),
    metadata: record(recordValue.metadata),
    createdAt: String(recordValue.createdAt),
    updatedAt: String(recordValue.updatedAt),
  });
}

function mapThreadRecord(
  recordValue: CollectionRecord,
  participants: readonly Participant[],
): ConversationThread {
  return Object.freeze({
    id: String(recordValue.id),
    namespace: String(recordValue.namespace),
    ...(optionalRecordText(recordValue.externalId)
      ? { externalId: optionalRecordText(recordValue.externalId) }
      : {}),
    ...(optionalRecordText(recordValue.name)
      ? { name: optionalRecordText(recordValue.name) }
      : {}),
    ...(optionalRecordText(recordValue.description)
      ? { description: optionalRecordText(recordValue.description) }
      : {}),
    status: String(recordValue.status ?? "active"),
    ...(optionalRecordText(recordValue.parentThreadId)
      ? { parentThreadId: optionalRecordText(recordValue.parentThreadId) }
      : {}),
    metadata: record(recordValue.metadata),
    participants: [...participants],
    ...(recordValue.activeMessageBranch &&
        typeof recordValue.activeMessageBranch === "object"
      ? {
        activeMessageBranch: recordValue
          .activeMessageBranch as ConversationThread["activeMessageBranch"],
      }
      : {}),
    ...(optionalRecordText(recordValue.lastEventId)
      ? { lastEventId: optionalRecordText(recordValue.lastEventId) }
      : {}),
    ...(optionalRecordText(recordValue.lastEventPosition)
      ? { lastEventPosition: optionalRecordText(recordValue.lastEventPosition) }
      : {}),
    ...(optionalRecordText(recordValue.lastEventAt)
      ? { lastEventAt: optionalRecordText(recordValue.lastEventAt) }
      : {}),
    createdAt: String(recordValue.createdAt),
    updatedAt: String(recordValue.updatedAt),
  });
}

function mapMessageRecord(
  recordValue: CollectionRecord,
  sender: Participant,
): ConversationMessage {
  return Object.freeze({
    id: String(recordValue.id),
    namespace: String(recordValue.namespace),
    threadId: String(recordValue.threadId),
    sender,
    recipientIds: recordTextArray(recordValue.recipientIds),
    content: recordContent(recordValue.content),
    metadata: record(recordValue.metadata),
    ...(recordValue.revision && typeof recordValue.revision === "object"
      ? { revision: recordValue.revision as ConversationMessage["revision"] }
      : {}),
    createdAt: String(recordValue.createdAt),
    updatedAt: String(recordValue.updatedAt),
  });
}

function requireAgentContext(
  options: CreateGoalRuntimeOptions,
  id: string,
): AgentResource {
  const agents = (options.registry.resources.agents ?? {}) as Readonly<
    Record<string, AgentResource | undefined>
  >;
  const agent = agents[id];
  if (!agent) throw new Error(`Unknown agent context '${id}'.`);
  return agent;
}

function namespaceFor(input: GoalInput, fallback: string | undefined): string {
  return requiredText(
    input.namespace?.trim() || fallback,
    "Goal namespace",
  );
}

function maxTurnsFor(value: number | undefined): number {
  const result = value ?? DEFAULT_MAX_TURNS;
  if (!Number.isSafeInteger(result) || result < 1) {
    throw new TypeError("Goal maxTurns must be a positive integer.");
  }
  return result;
}

function createStreamChannel<T>(
  onCancel: (reason: unknown) => void | Promise<void>,
): StreamChannel<T> {
  let controller: ReadableStreamDefaultController<T> | undefined;
  let closed = false;
  const stream = new ReadableStream<T>({
    start(value) {
      controller = value;
    },
    cancel: onCancel,
  }, { highWaterMark: 256 });
  return Object.freeze({
    stream,
    emit(value) {
      if (closed) return;
      try {
        controller?.enqueue(value);
      } catch {
        closed = true;
      }
    },
    close() {
      if (closed) return;
      closed = true;
      try {
        controller?.close();
      } catch {
        // A consumer can cancel while the goal is settling.
      }
    },
    error(reason) {
      if (closed) return;
      closed = true;
      try {
        controller?.error(reason);
      } catch {
        // A consumer can cancel while the goal is settling.
      }
    },
  });
}

function deferred<T>(): Readonly<{
  promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
}> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolveValue, rejectValue) => {
    resolve = resolveValue;
    reject = rejectValue;
  });
  return Object.freeze({ promise, resolve, reject });
}

function isConversationThread(
  value: GoalThreadRef,
): value is ConversationThread {
  return typeof value === "object" && value !== null &&
    typeof (value as { namespace?: unknown }).namespace === "string" &&
    Array.isArray((value as { participants?: unknown }).participants);
}

function threadDescriptor(value: GoalThreadRef | undefined): GoalThreadInput {
  return value && typeof value === "object" && !isConversationThread(value)
    ? value
    : {};
}

function agentExternalId(agent: AgentResource): string {
  return requiredText(agent.id, `Agent '${agent.id}' ID`);
}

function agentParticipant(agent: AgentResource): ParticipantInput {
  return Object.freeze({
    externalId: agentExternalId(agent),
    participantType: "agent" as const,
    agentId: requiredText(agent.id, "Agent resource ID"),
    name: requiredText(agent.name, `Agent '${agent.id}' name`),
  });
}

function senderParticipant(input: GoalInput["sender"]): ParticipantInput {
  const externalId = input.externalId?.trim() || input.id?.trim() ||
    input.name?.trim();
  return Object.freeze({
    ...(input.id?.trim() ? { id: input.id.trim() } : {}),
    externalId: requiredText(externalId, "Goal sender externalId or id"),
    participantType: "human" as const,
    ...(input.name?.trim() ? { name: input.name.trim() } : {}),
    ...(input.email?.trim() ? { email: input.email.trim() } : {}),
    ...(input.metadata ? { metadata: structuredClone(input.metadata) } : {}),
  });
}

function participantMatches(
  participant: Participant,
  input: ParticipantInput,
): boolean {
  if (input.id?.trim() && participant.id === input.id.trim()) return true;
  if (participant.externalId === input.externalId) return true;
  return Boolean(input.agentId && participant.agentId === input.agentId);
}

function requireCompatibleParticipant(
  participant: Participant,
  input: ParticipantInput,
): Participant {
  if (participant.participantType !== input.participantType) {
    throw new Error(
      `Participant '${participant.externalId}' is '${participant.participantType}', not '${input.participantType}'.`,
    );
  }
  if (input.agentId && participant.agentId !== input.agentId) {
    throw new Error(
      `Participant '${participant.externalId}' is bound to another agent.`,
    );
  }
  return participant;
}

async function loadParticipant(
  options: CreateGoalRuntimeOptions,
  namespace: string,
  id: string,
): Promise<Participant | null> {
  const record = await options.collections.withScope({ namespace })
    .participant.get({ id });
  return record ? mapParticipantRecord(record) : null;
}

async function projectThread(
  options: CreateGoalRuntimeOptions,
  namespace: string,
  record: CollectionRecord,
): Promise<ConversationThread> {
  const participantIds = Array.isArray(record.participantIds)
    ? record.participantIds.filter((id): id is string => typeof id === "string")
    : [];
  const participants = await Promise.all(
    participantIds.map((id) => loadParticipant(options, namespace, id)),
  );
  return mapThreadRecord(
    record,
    participants.filter((value): value is Participant => value !== null),
  );
}

async function loadThreadById(
  options: CreateGoalRuntimeOptions,
  namespace: string,
  id: string,
): Promise<ConversationThread | null> {
  const record = await options.collections.withScope({ namespace })
    .thread.get({ id });
  return record ? await projectThread(options, namespace, record) : null;
}

async function loadThreadByExternalId(
  options: CreateGoalRuntimeOptions,
  namespace: string,
  externalId: string,
): Promise<ConversationThread | null> {
  const [record] = await options.collections.withScope({ namespace })
    .thread.queries.byExternalId({ externalId });
  return record ? await projectThread(options, namespace, record) : null;
}

async function loadMessage(
  options: CreateGoalRuntimeOptions,
  namespace: string,
  id: string,
): Promise<ConversationMessage | null> {
  const collections = options.collections.withScope({ namespace });
  const record = await collections.message.get({ id });
  if (!record) return null;
  const sender = await collections.participant.get({
    id: String(record.senderId),
  });
  if (!sender) throw new Error(`Message '${id}' sender was not found.`);
  return mapMessageRecord(record, mapParticipantRecord(sender));
}

function goalMetadata(
  metadata: Readonly<Record<string, unknown>> | undefined,
  input: Readonly<{
    id: string;
    phase?: GoalPhase;
    turn?: number;
    role?: string;
  }>,
): Record<string, unknown> {
  return {
    ...structuredClone(metadata ?? {}),
    [GOAL_METADATA_KEY]: {
      schema: "copilotz.goal.v1",
      goalId: input.id,
      ...(input.phase ? { phase: input.phase } : {}),
      ...(input.turn !== undefined ? { turn: input.turn } : {}),
      ...(input.role ? { role: input.role } : {}),
    },
  };
}

function frozenSnapshot<T>(values: readonly T[]): readonly T[] {
  return Object.freeze([...values]);
}

function normalizeStopResult(
  value: boolean | GoalStopResult | undefined,
): GoalStopResult {
  return typeof value === "boolean" ? { stop: value } : value ?? {
    stop: false,
  };
}

function normalizeAssessment(value: GoalAssessment): GoalAssessment {
  if (
    value.status !== "completed" && value.status !== "failed" &&
    value.status !== "warning"
  ) {
    throw new TypeError(`Invalid goal assessment status '${value.status}'.`);
  }
  if (value.score !== undefined && !Number.isFinite(value.score)) {
    throw new TypeError("Goal assessment score must be finite.");
  }
  return Object.freeze({
    ...(value.name?.trim() ? { name: value.name.trim() } : {}),
    status: value.status,
    ...(value.score !== undefined ? { score: value.score } : {}),
    ...(value.report !== undefined ? { report: value.report } : {}),
    ...(value.metadata
      ? { metadata: Object.freeze(structuredClone(value.metadata)) }
      : {}),
  });
}

function assessmentSummary(values: readonly GoalAssessment[]): Readonly<{
  status?: GoalStatus;
  score?: number;
  report?: string;
}> {
  if (!values.length) return {};
  const scores = values.flatMap((value) =>
    value.score === undefined ? [] : [value.score]
  );
  const report = values.flatMap((value) => value.report ? [value.report] : [])
    .join("\n\n");
  return Object.freeze({
    status: values.some((value) => value.status === "failed")
      ? "failed"
      : "completed",
    ...(scores.length
      ? { score: scores.reduce((sum, value) => sum + value, 0) / scores.length }
      : {}),
    ...(report ? { report } : {}),
  });
}

function resolvedText(value: ResolvedContent): string {
  if (value.text !== undefined) return value.text;
  if (value.value !== undefined) {
    try {
      return JSON.stringify(value.value);
    } catch {
      return String(value.value);
    }
  }
  return `[${value.ref.kind}: ${value.ref.name ?? value.ref.assetId}]`;
}

async function transcriptMessage(
  options: CreateGoalRuntimeOptions,
  message: ConversationMessage,
  turn: number,
  phase: GoalPhase,
): Promise<GoalTranscriptMessage> {
  const resolved = await options.resolver.getMany(message.content, {
    namespace: message.namespace,
  });
  return Object.freeze({
    messageId: message.id,
    threadId: message.threadId,
    turn,
    phase,
    sender: message.sender,
    content: message.content,
    text: resolved.map(resolvedText).join("\n"),
    metadata: message.metadata,
    createdAt: message.createdAt,
  });
}

async function loadThread(
  options: CreateGoalRuntimeOptions,
  namespace: string,
  ref: string | ConversationThread,
): Promise<ConversationThread> {
  if (typeof ref !== "string" && ref.namespace !== namespace) {
    throw new Error("Goal thread belongs to another namespace.");
  }
  const value = typeof ref === "string"
    ? requiredText(ref, "Goal thread")
    : ref.id;
  const thread = await loadThreadById(options, namespace, value) ??
    (typeof ref === "string"
      ? await loadThreadByExternalId(options, namespace, value)
      : null);
  if (!thread) {
    throw new Error(`Goal thread '${value}' was not found in '${namespace}'.`);
  }
  return thread;
}

async function ensureParticipant(
  options: CreateGoalRuntimeOptions,
  namespace: string,
  thread: ConversationThread,
  input: ParticipantInput,
  operationKey: string,
  goalId: string,
): Promise<Readonly<{ thread: ConversationThread; participant: Participant }>> {
  const existing = thread.participants.find((participant) =>
    participantMatches(participant, input)
  );
  if (existing) {
    return Object.freeze({
      thread,
      participant: requireCompatibleParticipant(existing, input),
    });
  }
  await options.actions(namespace).addThreadParticipant({
    threadId: thread.id,
    participant: input,
    eventMetadata: goalMetadata(undefined, {
      id: goalId,
      role: operationKey,
    }),
  }, {
    operationKey: `goal:${operationKey}`,
    identity: {
      correlationId: goalId,
      deduplicationId: `${goalId}:${operationKey}`,
    },
  });
  const updated = await loadThreadById(options, namespace, thread.id);
  if (!updated) throw new Error("Participant mutation returned no thread.");
  const participant = updated.participants.find((candidate) =>
    participantMatches(candidate, input)
  );
  if (!participant) {
    throw new Error(`Goal participant '${input.externalId}' was not attached.`);
  }
  return Object.freeze({
    thread: updated,
    participant: requireCompatibleParticipant(participant, input),
  });
}

async function createOrLoadTargetThread(
  options: CreateGoalRuntimeOptions,
  input: GoalInput,
  namespace: string,
  goalId: string,
  participants: readonly ParticipantInput[],
): Promise<ConversationThread> {
  if (
    typeof input.thread === "string" ||
    (input.thread && isConversationThread(input.thread))
  ) {
    return await loadThread(options, namespace, input.thread);
  }
  const descriptor = threadDescriptor(input.thread);
  const existing = descriptor.id?.trim()
    ? await loadThreadById(options, namespace, descriptor.id.trim())
    : descriptor.externalId?.trim()
    ? await loadThreadByExternalId(
      options,
      namespace,
      descriptor.externalId.trim(),
    )
    : null;
  if (existing) return existing;
  const id = descriptor.id?.trim() || `${goalId}:target`;
  const record = await options.actions(namespace).createThread({
    id,
    ...(descriptor.externalId?.trim()
      ? { externalId: descriptor.externalId.trim() }
      : {}),
    ...(descriptor.parentThreadId?.trim()
      ? { parentThreadId: descriptor.parentThreadId.trim() }
      : {}),
    participants: [...participants],
    metadata: goalMetadata(descriptor.metadata ?? input.metadata, {
      id: goalId,
      role: "target",
    }),
  }, {
    operationKey: "goal:thread:target",
    identity: {
      correlationId: goalId,
      deduplicationId: `${goalId}:thread:target`,
    },
  }) as CollectionRecord;
  return await projectThread(options, namespace, record);
}

async function createPrivateThread(
  options: CreateGoalRuntimeOptions,
  input: Readonly<{
    namespace: string;
    goalId: string;
    role: "lead" | "judge";
    suffix?: string;
    descriptor?: GoalThreadRef;
    participants: readonly ParticipantInput[];
    metadata?: Readonly<Record<string, unknown>>;
  }>,
): Promise<ConversationThread> {
  if (
    typeof input.descriptor === "string" ||
    (input.descriptor && isConversationThread(input.descriptor))
  ) {
    return await loadThread(options, input.namespace, input.descriptor);
  }
  const descriptor = threadDescriptor(input.descriptor);
  const existing = descriptor.id?.trim()
    ? await loadThreadById(options, input.namespace, descriptor.id.trim())
    : descriptor.externalId?.trim()
    ? await loadThreadByExternalId(
      options,
      input.namespace,
      descriptor.externalId.trim(),
    )
    : null;
  if (existing) return existing;
  const label = input.suffix ? `${input.role}:${input.suffix}` : input.role;
  const id = descriptor.id?.trim() || `${input.goalId}:${label}`;
  const record = await options.actions(input.namespace).createThread({
    id,
    ...(descriptor.externalId?.trim()
      ? { externalId: descriptor.externalId.trim() }
      : {}),
    ...(descriptor.parentThreadId?.trim()
      ? { parentThreadId: descriptor.parentThreadId.trim() }
      : {}),
    participants: [...input.participants],
    metadata: goalMetadata(descriptor.metadata ?? input.metadata, {
      id: input.goalId,
      role: input.role,
    }),
  }, {
    operationKey: `goal:thread:${label}`,
    identity: {
      correlationId: input.goalId,
      deduplicationId: `${input.goalId}:thread:${label}`,
    },
  }) as CollectionRecord;
  return await projectThread(options, input.namespace, record);
}

async function prepareGoal(
  options: CreateGoalRuntimeOptions,
  input: GoalInput,
  goalId: string,
): Promise<PreparedGoal> {
  const namespace = namespaceFor(input, options.defaultNamespace);
  const databaseSchema = optionalText(
    input.databaseSchema ?? options.defaultDatabaseSchema,
    "Goal database schema",
  );
  const targetAgentId = requiredText(input.target, "Goal target agent");
  const leadAgentId = requiredText(input.sender.usingAgent, "Goal lead agent");
  const targetAgent = requireAgentContext(options, targetAgentId);
  const leadAgent = requireAgentContext(options, leadAgentId);
  const senderInput = senderParticipant(input.sender);
  const targetInput = agentParticipant(targetAgent);
  let targetThread = await createOrLoadTargetThread(
    options,
    input,
    namespace,
    goalId,
    [senderInput, targetInput],
  );
  const ensuredSender = await ensureParticipant(
    options,
    namespace,
    targetThread,
    senderInput,
    "target:sender",
    goalId,
  );
  targetThread = ensuredSender.thread;
  const ensuredTarget = await ensureParticipant(
    options,
    namespace,
    targetThread,
    targetInput,
    "target:agent",
    goalId,
  );
  targetThread = ensuredTarget.thread;

  const leadInputDescriptor: ParticipantInput = Object.freeze({
    externalId: `${goalId}:target-output`,
    participantType: "human" as const,
    name: targetAgent.name,
    metadata: goalMetadata(undefined, { id: goalId, role: "lead-input" }),
  });
  const leadDescriptor = agentParticipant(leadAgent);
  let leadThread = await createPrivateThread(options, {
    namespace,
    goalId,
    role: "lead",
    participants: [leadInputDescriptor, leadDescriptor],
    metadata: input.metadata,
  });
  const ensuredLeadInput = await ensureParticipant(
    options,
    namespace,
    leadThread,
    leadInputDescriptor,
    "lead:input",
    goalId,
  );
  leadThread = ensuredLeadInput.thread;
  const ensuredLead = await ensureParticipant(
    options,
    namespace,
    leadThread,
    leadDescriptor,
    "lead:agent",
    goalId,
  );
  leadThread = ensuredLead.thread;

  return Object.freeze({
    namespace,
    ...(databaseSchema ? { databaseSchema } : {}),
    targetAgent,
    leadAgent,
    targetThread,
    leadThread,
    sender: ensuredSender.participant,
    target: ensuredTarget.participant,
    leadInput: ensuredLeadInput.participant,
    lead: ensuredLead.participant,
  });
}

function errorText(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

/** Creates bounded simulation runs over ordinary event-native application runs. */
export function createGoalRuntime(
  options: CreateGoalRuntimeOptions,
): GoalRuntime {
  const createId = options.createId ?? (() => crypto.randomUUID());
  const now = options.now ?? (() => new Date());
  const active = new Set<GoalHandle>();
  let closed = false;

  const goal = async (input: GoalInput): Promise<GoalHandle> => {
    if (closed) throw new Error("Goal runtime is shut down.");
    const maxTurns = maxTurnsFor(input.maxTurns);
    const goalId = requiredText(createId(), "Goal ID");
    const prepared = await prepareGoal(options, input, goalId);
    const startedAt = now().getTime();
    const completion = deferred<GoalResult>();
    const activeRuns = new Set<ApplicationSendHandle>();
    const abort = new AbortController();
    let cancellationReason: string | undefined;
    let settled = false;

    const cancel = async (reason = "Goal cancelled."): Promise<void> => {
      if (settled || abort.signal.aborted) return;
      cancellationReason = reason;
      abort.abort(reason);
      await Promise.all(
        [...activeRuns].map((run) => run.cancel(reason).catch(() => undefined)),
      );
    };
    const channel = createStreamChannel<GoalStreamEvent>((reason) =>
      cancel(errorText(reason ?? "Goal event stream cancelled."))
    );

    const observations: GoalObservedEvent[] = [];
    const transcript: GoalTranscriptMessage[] = [];
    const seenMessages = new Set<string>();
    let turns = 0;
    let targetRuns = 0;
    let leadRuns = 0;
    let judgeRuns = 0;
    let orchestrationErrors = 0;

    const observeRun = async (
      run: ApplicationSendHandle,
      phase: GoalPhase,
      turn: number,
      expectedParticipantId?: string,
    ): Promise<GoalRunResult> => {
      activeRuns.add(run);
      const runEvents: GoalObservedEvent[] = [];
      let finalMessage: GoalTranscriptMessage | undefined;
      try {
        for await (const output of run.outputs) {
          if (isAttachmentStreamOutput(output)) {
            await output.payload.cancel("goal_run_stream_output_ignored").catch(
              () => undefined,
            );
            continue;
          }
          const event = output;
          const observation: GoalObservedEvent = Object.freeze({
            type: "goal.event",
            payload: Object.freeze({ goalId, turn, phase, event }),
          });
          observations.push(observation);
          runEvents.push(observation);
          channel.emit(observation);
          if (
            event.durable &&
            event.type === "message.created" &&
            event.subject?.type === "message" &&
            !seenMessages.has(event.subject.id)
          ) {
            const message = await loadMessage(
              options,
              prepared.namespace,
              event.subject.id,
            );
            if (!message) {
              throw new Error(
                `Observed message '${event.subject.id}' was not found.`,
              );
            }
            seenMessages.add(message.id);
            const projected = await transcriptMessage(
              options,
              message,
              turn,
              phase,
            );
            transcript.push(projected);
            if (
              expectedParticipantId === undefined ||
              projected.sender.id === expectedParticipantId
            ) {
              finalMessage = projected;
            }
          }
        }
        await run.done;
      } catch (error) {
        await run.cancel("Goal phase failed.").catch(() => undefined);
        throw error;
      } finally {
        activeRuns.delete(run);
      }
      return Object.freeze({
        handle: run,
        events: frozenSnapshot(runEvents),
        ...(finalMessage ? { finalMessage } : {}),
        text: finalMessage?.text ?? "",
      });
    };

    const performPhase = async (
      input: Readonly<{
        phase: GoalPhase;
        turn: number;
        thread: ConversationThread;
        participant: Participant;
        recipient: Participant;
        content: ContentInput | readonly ContentInput[];
        expectedParticipantId: string;
        correlationId?: string;
        metadata?: Readonly<Record<string, unknown>>;
      }>,
    ): Promise<GoalRunResult> => {
      if (abort.signal.aborted) throw abort.signal.reason;
      const correlationId = input.correlationId?.trim() ||
        `${goalId}:${input.phase}:${input.turn}:${createId()}`;
      const run = await options.send({
        ...coreMessage({
          thread: input.thread.id,
          participant: input.participant,
          recipientIds: [input.recipient.id],
          content: input.content,
          correlationId,
          deduplicationId: `${correlationId}:input`,
          metadata: goalMetadata(input.metadata, {
            id: goalId,
            phase: input.phase,
            turn: input.turn,
          }),
        }),
        namespace: prepared.namespace,
        ...(prepared.databaseSchema
          ? { databaseSchema: prepared.databaseSchema }
          : {}),
      });
      return await observeRun(
        run,
        input.phase,
        input.turn,
        input.expectedParticipantId,
      );
    };

    const execute = async (): Promise<void> => {
      let status: GoalStatus = "stopped";
      let reason: string | undefined;
      let assessments: readonly GoalAssessment[] = [];
      let currentContent = input.content;

      try {
        while (!abort.signal.aborted && turns < maxTurns) {
          turns += 1;
          targetRuns += 1;
          const targetRun = await performPhase({
            phase: "target",
            turn: turns,
            thread: prepared.targetThread,
            participant: prepared.sender,
            recipient: prepared.target,
            content: currentContent,
            expectedParticipantId: prepared.target.id,
            metadata: input.metadata,
          });
          if (!targetRun.finalMessage) {
            status = "error";
            reason =
              `No final message produced by target agent '${prepared.targetAgent.id}'.`;
            orchestrationErrors += 1;
            break;
          }

          const stop = normalizeStopResult(
            await input.stop?.(Object.freeze({
              id: goalId,
              turns,
              threadId: prepared.targetThread.id,
              leadThreadId: prepared.leadThread.id,
              transcript: frozenSnapshot(transcript),
              events: frozenSnapshot(observations),
              lastMessage: targetRun.finalMessage,
              signal: abort.signal,
            })),
          );
          if (stop.stop) {
            status = stop.status ?? "stopped";
            reason = stop.reason;
            break;
          }
          if (turns >= maxTurns) {
            status = "stopped";
            reason = `Maximum turns reached (${maxTurns}).`;
            break;
          }

          leadRuns += 1;
          const leadRun = await performPhase({
            phase: "lead",
            turn: turns,
            thread: prepared.leadThread,
            participant: prepared.leadInput,
            recipient: prepared.lead,
            content: targetRun.finalMessage.content,
            expectedParticipantId: prepared.lead.id,
            metadata: input.metadata,
          });
          if (!leadRun.finalMessage) {
            status = "error";
            reason =
              `No final message produced by lead agent '${prepared.leadAgent.id}'.`;
            orchestrationErrors += 1;
            break;
          }
          currentContent = leadRun.finalMessage.content;
        }
      } catch (error) {
        if (abort.signal.aborted) {
          status = "cancelled";
          reason = cancellationReason ??
            (errorText(abort.signal.reason) || "Goal cancelled.");
        } else {
          status = "error";
          reason = errorText(error);
          orchestrationErrors += 1;
        }
      }

      if (abort.signal.aborted) {
        status = "cancelled";
        reason = cancellationReason ?? "Goal cancelled.";
      } else if (turns >= maxTurns && !reason) {
        status = "stopped";
        reason = `Maximum turns reached (${maxTurns}).`;
      }

      if (input.evaluate && !abort.signal.aborted) {
        try {
          const runJudge = async (
            judgeInput: GoalJudgeRunInput,
          ): Promise<GoalRunResult> => {
            judgeRuns += 1;
            const judgeAgentId = requiredText(
              judgeInput.target,
              "Goal judge agent",
            );
            const judgeAgent = requireAgentContext(options, judgeAgentId);
            const judgeSenderInput: ParticipantInput = judgeInput.sender ?? {
              externalId: `${goalId}:judge:${judgeRuns}:evaluator`,
              participantType: "human",
              name: "Goal evaluator",
            };
            const judgeAgentInput = agentParticipant(judgeAgent);
            let judgeThread = await createPrivateThread(options, {
              namespace: prepared.namespace,
              goalId,
              role: "judge",
              suffix: String(judgeRuns),
              descriptor: judgeInput.thread,
              participants: [judgeSenderInput, judgeAgentInput],
              metadata: judgeInput.metadata,
            });
            const ensuredSender = await ensureParticipant(
              options,
              prepared.namespace,
              judgeThread,
              judgeSenderInput,
              `judge:${judgeRuns}:sender`,
              goalId,
            );
            judgeThread = ensuredSender.thread;
            const ensuredJudge = await ensureParticipant(
              options,
              prepared.namespace,
              judgeThread,
              judgeAgentInput,
              `judge:${judgeRuns}:agent`,
              goalId,
            );
            return await performPhase({
              phase: "judge",
              turn: turns,
              thread: ensuredJudge.thread,
              participant: ensuredSender.participant,
              recipient: ensuredJudge.participant,
              content: judgeInput.content,
              expectedParticipantId: ensuredJudge.participant.id,
              correlationId: judgeInput.correlationId,
              metadata: judgeInput.metadata,
            });
          };
          const output = await input.evaluate(Object.freeze({
            id: goalId,
            threadId: prepared.targetThread.id,
            leadThreadId: prepared.leadThread.id,
            turns,
            transcript: frozenSnapshot(transcript),
            events: frozenSnapshot(observations),
            signal: abort.signal,
            run: runJudge,
          }));
          const values = output === undefined
            ? []
            : Array.isArray(output)
            ? output
            : [output];
          assessments = Object.freeze(values.map(normalizeAssessment));
        } catch (error) {
          orchestrationErrors += 1;
          assessments = Object.freeze([normalizeAssessment({
            name: "evaluate",
            status: "failed",
            report: errorText(error),
          })]);
        }
      }

      const summary = assessmentSummary(assessments);
      if (summary.status && status !== "cancelled") status = summary.status;
      const failedEvents =
        observations.filter(({ payload }) =>
          payload.event.type.endsWith(".failed") ||
          payload.event.type.endsWith(".cancelled")
        ).length;
      const result: GoalResult = Object.freeze({
        id: goalId,
        status,
        ...(summary.score !== undefined ? { score: summary.score } : {}),
        ...(summary.report !== undefined ? { report: summary.report } : {}),
        ...(reason ? { reason } : {}),
        threadId: prepared.targetThread.id,
        leadThreadId: prepared.leadThread.id,
        turns,
        transcript: frozenSnapshot(transcript),
        events: frozenSnapshot(observations),
        assessments,
        metrics: Object.freeze({
          durationMs: Math.max(0, now().getTime() - startedAt),
          targetRuns,
          leadRuns,
          judgeRuns,
          messages: transcript.length,
          toolCalls: observations.filter(({ payload }) =>
            payload.event.type === "copilotz.core.tool.call.invoked"
          ).length,
          errors: orchestrationErrors + failedEvents,
        }),
      });
      channel.emit(Object.freeze({
        type: "goal.stopped",
        payload: Object.freeze({
          goalId,
          threadId: prepared.targetThread.id,
          leadThreadId: prepared.leadThread.id,
          turn: turns,
          status,
          ...(reason ? { reason } : {}),
        }),
      }));
      channel.emit(Object.freeze({ type: "goal.result", payload: result }));
      channel.close();
      settled = true;
      completion.resolve(result);
    };

    const handle: GoalHandle = Object.freeze({
      id: goalId,
      threadId: prepared.targetThread.id,
      leadThreadId: prepared.leadThread.id,
      status: "running" as const,
      events: channel.stream,
      done: completion.promise,
      cancel,
    });
    active.add(handle);
    completion.promise.finally(() => {
      settled = true;
      active.delete(handle);
      input.signal?.removeEventListener("abort", forwardAbort);
    }).catch(() => undefined);
    const forwardAbort = () => {
      void cancel(errorText(input.signal?.reason ?? "Goal cancelled."));
    };
    if (input.signal?.aborted) forwardAbort();
    else input.signal?.addEventListener("abort", forwardAbort, { once: true });
    queueMicrotask(() => {
      void execute().catch((error) => {
        settled = true;
        active.delete(handle);
        channel.error(error);
        completion.reject(error);
      });
    });
    return handle;
  };

  return Object.freeze({
    goal,
    async shutdown(reason = "Goal runtime shut down.") {
      if (closed) return;
      closed = true;
      const handles = [...active];
      await Promise.all(handles.map((handle) => handle.cancel(reason)));
      await Promise.all(
        handles.map((handle) => handle.done.catch(() => undefined)),
      );
    },
  });
}
