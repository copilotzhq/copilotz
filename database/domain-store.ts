import { ulid } from "ulid";
import type {
  DurableEvent,
  DurableEventDraft,
  EventVisibility,
} from "@/events/types.ts";
import type {
  LlmAttemptRecord,
  MessagePayload,
  MessageRecord,
  ParticipantRecord,
  ThreadRecord,
  ToolExecutionRecord,
  ToolInvocationInput,
} from "@/types/resources.ts";
import type { CommitMutationResult, EventStore } from "./event-store.ts";
import type { SqlTransaction } from "./session.ts";

const EDGE = {
  PARTICIPANT: "participates_in",
  MESSAGE: "has_message",
  SENT_BY: "sent_by",
  ADDRESSED_TO: "addressed_to",
  PARENT: "has_child_thread",
  LLM_ATTEMPT: "has_llm_attempt",
  TOOL_EXECUTION: "has_tool_execution",
  DERIVED_FROM: "derived_from",
} as const;

interface NodeRow extends Record<string, unknown> {
  id: string;
  namespace: string;
  type: string;
  name: string;
  content: string | null;
  data: Record<string, unknown> | null;
  created_at: string | Date;
  updated_at: string | Date;
}

export interface DomainMutationContext {
  causationId?: string;
  correlationId?: string;
  deduplicationId?: string;
  metadata?: Record<string, unknown>;
}

export interface DomainCommitHooks {
  resolveConsumers(event: DurableEvent): readonly string[];
  committed(result: CommitMutationResult<unknown>): void | Promise<void>;
}

export interface ThreadInput {
  id?: string;
  externalId?: string;
  name?: string;
  status?: string;
  parentThreadId?: string;
  metadata?: Record<string, unknown>;
}

export interface ParticipantInput {
  id?: string;
  externalId: string;
  participantType: "human" | "agent" | "job";
  name?: string;
  agentId?: string;
  metadata?: Record<string, unknown>;
}

function toIso(value: string | Date): string {
  return value instanceof Date
    ? value.toISOString()
    : new Date(value).toISOString();
}

function mapNode<T>(row: NodeRow): T {
  return {
    ...(row.data ?? {}),
    id: row.id,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  } as T;
}

function matchEvent(draft: DurableEventDraft): DurableEvent {
  const id = draft.deduplicationId ?? "uncommitted";
  return {
    durable: true,
    id,
    position: "0",
    schemaVersion: 2,
    type: draft.type,
    namespace: draft.namespace,
    ...(draft.threadId ? { threadId: draft.threadId } : {}),
    ...(draft.subject ? { subject: draft.subject } : {}),
    payload: draft.payload,
    ...(draft.delta === undefined ? {} : { delta: draft.delta }),
    routing: draft.routing ?? {},
    visibility: draft.visibility ?? { kind: "public" },
    metadata: draft.metadata ?? {},
    ...(draft.causationId ? { causationId: draft.causationId } : {}),
    correlationId: draft.correlationId ?? id,
    ...(draft.deduplicationId
      ? { deduplicationId: draft.deduplicationId }
      : {}),
    createdAt: draft.createdAt ?? new Date().toISOString(),
  };
}

export class DomainStore {
  readonly #store: EventStore;
  readonly #hooks: DomainCommitHooks;

  constructor(store: EventStore, hooks: DomainCommitHooks) {
    this.#store = store;
    this.#hooks = hooks;
  }

  async ensureThread(
    namespace: string,
    input: string | ThreadInput,
    context: DomainMutationContext = {},
  ): Promise<ThreadRecord> {
    const normalized: ThreadInput = typeof input === "string"
      ? { externalId: input, name: input }
      : input;
    const existing = await this.findThread(
      namespace,
      normalized.id ?? normalized.externalId ?? "",
    );
    if (existing) return existing;

    const parent = normalized.parentThreadId
      ? await this.findThread(namespace, normalized.parentThreadId)
      : null;

    const id = normalized.id ?? ulid();
    const now = new Date().toISOString();
    const record: ThreadRecord = {
      id,
      threadId: id,
      externalId: normalized.externalId ?? null,
      name: normalized.name ?? normalized.externalId ?? id,
      status: normalized.status ?? "active",
      parentThreadId: normalized.parentThreadId ?? null,
      rootThreadId: parent?.rootThreadId ?? parent?.id ?? id,
      metadata: normalized.metadata ?? null,
      createdAt: now,
      updatedAt: now,
    };
    const draft = this.#draft("thread.created", namespace, record, context, {
      threadId: id,
      subject: { type: "thread", id },
    });
    const result = await this.#store.commitMutation({
      draft,
      consumerIds: this.#consumers(draft),
      mutate: async (transaction) => {
        await this.#insertNode(transaction, namespace, "thread", record);
        if (record.parentThreadId) {
          await this.#insertEdge(
            transaction,
            namespace,
            record.parentThreadId,
            id,
            EDGE.PARENT,
          );
        }
        return record;
      },
      onDuplicate: async (_event, transaction) =>
        await this.#requireNode<ThreadRecord>(
          transaction,
          namespace,
          "thread",
          id,
        ),
    });
    await this.#notify(result);
    return result.value;
  }

  async findThread(
    namespace: string,
    idOrExternalId: string,
  ): Promise<ThreadRecord | null> {
    if (!idOrExternalId) return null;
    const result = await this.#store.read<NodeRow>(
      `SELECT * FROM ${this.#store.table("nodes")}
       WHERE namespace = $1 AND type = 'thread'
         AND (id = $2 OR data ->> 'externalId' = $2)
       ORDER BY created_at ASC LIMIT 1`,
      [namespace, idOrExternalId],
    );
    return result.rows[0] ? mapNode<ThreadRecord>(result.rows[0]) : null;
  }

  async ensureParticipant(
    namespace: string,
    input: string | ParticipantInput,
    context: DomainMutationContext = {},
  ): Promise<ParticipantRecord> {
    const normalized: ParticipantInput = typeof input === "string"
      ? { externalId: input, participantType: "human", name: input }
      : input;
    const existing = await this.findParticipant(
      namespace,
      normalized.id ?? normalized.externalId,
    );
    if (existing) return existing;

    const id = normalized.id ?? ulid();
    const now = new Date().toISOString();
    const record: ParticipantRecord = {
      id,
      externalId: normalized.externalId,
      participantType: normalized.participantType,
      name: normalized.name ?? normalized.externalId,
      agentId: normalized.agentId ?? null,
      metadata: normalized.metadata ?? null,
      createdAt: now,
      updatedAt: now,
    };
    const draft = this.#draft(
      "participant.created",
      namespace,
      record,
      context,
      { subject: { type: "participant", id } },
    );
    const result = await this.#store.commitMutation({
      draft,
      consumerIds: this.#consumers(draft),
      mutate: async (transaction) => {
        await this.#insertNode(transaction, namespace, "participant", record);
        return record;
      },
      onDuplicate: async (_event, transaction) =>
        await this.#requireNode<ParticipantRecord>(
          transaction,
          namespace,
          "participant",
          id,
        ),
    });
    await this.#notify(result);
    return result.value;
  }

  async findParticipant(
    namespace: string,
    idOrExternalId: string,
  ): Promise<ParticipantRecord | null> {
    const result = await this.#store.read<NodeRow>(
      `SELECT * FROM ${this.#store.table("nodes")}
       WHERE namespace = $1 AND type = 'participant'
         AND (id = $2 OR data ->> 'externalId' = $2 OR data ->> 'agentId' = $2)
       ORDER BY created_at ASC LIMIT 1`,
      [namespace, idOrExternalId],
    );
    return result.rows[0] ? mapNode<ParticipantRecord>(result.rows[0]) : null;
  }

  async addParticipant(
    namespace: string,
    threadId: string,
    participantId: string,
    context: DomainMutationContext = {},
  ): Promise<void> {
    const existing = await this.#store.read<{ id: string }>(
      `SELECT id FROM ${this.#store.table("edges")}
       WHERE namespace = $1 AND source_node_id = $2
         AND target_node_id = $3 AND type = $4 LIMIT 1`,
      [namespace, threadId, participantId, EDGE.PARTICIPANT],
    );
    if (existing.rows.length) return;
    const draft = this.#draft(
      "thread.participant_added",
      namespace,
      { threadId, participantId },
      context,
      { threadId, subject: { type: "thread", id: threadId } },
    );
    const result = await this.#store.commitMutation({
      draft,
      consumerIds: this.#consumers(draft),
      mutate: async (transaction) => {
        await this.#insertEdge(
          transaction,
          namespace,
          threadId,
          participantId,
          EDGE.PARTICIPANT,
        );
      },
      onDuplicate: () => Promise.resolve(),
    });
    await this.#notify(result);
  }

  async listParticipants(
    namespace: string,
    threadId: string,
  ): Promise<readonly ParticipantRecord[]> {
    const result = await this.#store.read<NodeRow>(
      `SELECT participant.*
       FROM ${this.#store.table("edges")} relation
       JOIN ${this.#store.table("nodes")} participant
         ON participant.id = relation.target_node_id
       WHERE relation.namespace = $1 AND relation.source_node_id = $2
         AND relation.type = $3 AND participant.type = 'participant'
       ORDER BY relation.created_at ASC, participant.id ASC`,
      [namespace, threadId, EDGE.PARTICIPANT],
    );
    return result.rows.map(mapNode<ParticipantRecord>);
  }

  async createMessage(options: {
    namespace: string;
    thread: ThreadRecord;
    participant: ParticipantRecord;
    input: MessagePayload;
    target?: ParticipantRecord | null;
    correlationId?: string;
    context?: DomainMutationContext;
    visibility?: EventVisibility;
  }): Promise<CommitMutationResult<MessageRecord>> {
    const { namespace, thread, participant, input } = options;
    const id = ulid();
    const now = new Date().toISOString();
    const senderType = input.sender?.type ??
      (participant.participantType === "agent"
        ? "agent"
        : participant.participantType === "job"
        ? "job"
        : "user");
    const record: MessageRecord = {
      id,
      messageId: id,
      threadId: thread.id,
      content: input.content ?? null,
      senderId: participant.id,
      senderType,
      targetId: options.target?.id ?? input.target ?? null,
      toolCalls: input.toolCalls ?? null,
      reasoning: input.reasoning ?? null,
      metadata: {
        ...(input.metadata ?? {}),
        senderExternalId: participant.externalId,
        senderDisplayName: participant.name,
      },
      externalId: input.externalId ?? null,
      createdAt: now,
      updatedAt: now,
    };
    const context = {
      ...(options.context ?? {}),
      correlationId: options.correlationId ?? options.context?.correlationId,
    };
    const eventRecord = record.reasoning
      ? { ...record, reasoning: null }
      : record;
    const draft = this.#draft(
      "message.created",
      namespace,
      eventRecord,
      context,
      {
        threadId: thread.id,
        subject: { type: "message", id },
        routing: {
          senderId: participant.id,
          ...(options.target ? { recipientIds: [options.target.id] } : {}),
        },
        visibility: options.visibility ?? { kind: "public" },
        ...(record.reasoning ? { delta: { reasoningStored: true } } : {}),
      },
    );
    const result = await this.#store.commitMutation({
      draft,
      consumerIds: this.#consumers(draft),
      mutate: async (transaction) => {
        await this.#insertNode(transaction, namespace, "message", record);
        await this.#insertEdge(
          transaction,
          namespace,
          thread.id,
          id,
          EDGE.MESSAGE,
        );
        await this.#insertEdge(
          transaction,
          namespace,
          id,
          participant.id,
          EDGE.SENT_BY,
        );
        if (options.target) {
          await this.#insertEdge(
            transaction,
            namespace,
            id,
            options.target.id,
            EDGE.ADDRESSED_TO,
          );
        }
        return record;
      },
      onDuplicate: async (event, transaction) =>
        await this.#requireNode<MessageRecord>(
          transaction,
          namespace,
          "message",
          event.subject?.id ?? id,
        ),
    });
    await this.#notify(result);
    return result;
  }

  async listMessages(
    namespace: string,
    threadId: string,
  ): Promise<readonly MessageRecord[]> {
    const result = await this.#store.read<NodeRow>(
      `SELECT message.*
       FROM ${this.#store.table("edges")} relation
       JOIN ${this.#store.table("nodes")} message
         ON message.id = relation.target_node_id
       WHERE relation.namespace = $1 AND relation.source_node_id = $2
         AND relation.type = $3 AND message.type = 'message'
       ORDER BY relation.created_at ASC, message.id ASC`,
      [namespace, threadId, EDGE.MESSAGE],
    );
    return result.rows.map(mapNode<MessageRecord>);
  }

  async createLlmAttempt(options: {
    namespace: string;
    threadId: string;
    messageId: string;
    agentId: string;
    agentName: string;
    messages?: unknown[];
    tools?: unknown[];
    config?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
    context: DomainMutationContext;
  }): Promise<CommitMutationResult<LlmAttemptRecord>> {
    const id = ulid();
    const now = new Date().toISOString();
    const record: LlmAttemptRecord = {
      id,
      threadId: options.threadId,
      messageId: options.messageId,
      agentId: options.agentId,
      agentName: options.agentName,
      status: "pending",
      messages: options.messages ?? null,
      tools: options.tools ?? null,
      config: options.config ?? null,
      metadata: options.metadata ?? null,
      createdAt: now,
      updatedAt: now,
    };
    const draft = this.#draft(
      "llm_attempt.created",
      options.namespace,
      record,
      options.context,
      {
        threadId: options.threadId,
        subject: { type: "llm_attempt", id },
        routing: { recipientIds: [options.agentId] },
        visibility: { kind: "internal" },
      },
    );
    const result = await this.#store.commitMutation({
      draft,
      consumerIds: this.#consumers(draft),
      mutate: async (transaction) => {
        await this.#insertNode(
          transaction,
          options.namespace,
          "llm_attempt",
          record,
        );
        await this.#insertEdge(
          transaction,
          options.namespace,
          options.messageId,
          id,
          EDGE.LLM_ATTEMPT,
        );
        return record;
      },
      onDuplicate: async (event, transaction) =>
        await this.#requireNode<LlmAttemptRecord>(
          transaction,
          options.namespace,
          "llm_attempt",
          event.subject?.id ?? id,
        ),
    });
    await this.#notify(result);
    return result;
  }

  async updateLlmAttempt(
    namespace: string,
    id: string,
    operation: "started" | "completed" | "failed" | "cancelled",
    patch: Record<string, unknown>,
    context: DomainMutationContext,
  ): Promise<CommitMutationResult<LlmAttemptRecord>> {
    return await this.#updateDomainRecord<LlmAttemptRecord>({
      namespace,
      id,
      type: "llm_attempt",
      operation,
      patch,
      context,
      visibility: { kind: "internal" },
    });
  }

  async createToolExecution(options: {
    namespace: string;
    threadId: string;
    messageId: string;
    agentId: string;
    agentName: string;
    call: ToolInvocationInput;
    batchId: string;
    batchSize: number;
    batchIndex: number;
    metadata?: Record<string, unknown>;
    context: DomainMutationContext;
  }): Promise<CommitMutationResult<ToolExecutionRecord>> {
    const id = ulid();
    const now = new Date().toISOString();
    const record: ToolExecutionRecord = {
      id,
      threadId: options.threadId,
      messageId: options.messageId,
      agentId: options.agentId,
      agentName: options.agentName,
      toolCallId: options.call.id ?? ulid(),
      tool: options.call.tool,
      args: options.call.args ?? {},
      status: "pending",
      batchId: options.batchId,
      batchSize: options.batchSize,
      batchIndex: options.batchIndex,
      metadata: options.metadata ?? null,
      createdAt: now,
      updatedAt: now,
    };
    const draft = this.#draft(
      "tool_execution.created",
      options.namespace,
      record,
      options.context,
      {
        threadId: options.threadId,
        subject: { type: "tool_execution", id },
        routing: { recipientIds: [options.agentId] },
        visibility: { kind: "internal" },
      },
    );
    const result = await this.#store.commitMutation({
      draft,
      consumerIds: this.#consumers(draft),
      mutate: async (transaction) => {
        await this.#insertNode(
          transaction,
          options.namespace,
          "tool_execution",
          record,
        );
        await this.#insertEdge(
          transaction,
          options.namespace,
          options.messageId,
          id,
          EDGE.TOOL_EXECUTION,
        );
        return record;
      },
      onDuplicate: async (event, transaction) =>
        await this.#requireNode<ToolExecutionRecord>(
          transaction,
          options.namespace,
          "tool_execution",
          event.subject?.id ?? id,
        ),
    });
    await this.#notify(result);
    return result;
  }

  async updateToolExecution(
    namespace: string,
    id: string,
    operation: "started" | "waiting" | "completed" | "failed" | "cancelled",
    patch: Record<string, unknown>,
    context: DomainMutationContext,
    visibility: EventVisibility = { kind: "internal" },
  ): Promise<CommitMutationResult<ToolExecutionRecord>> {
    return await this.#updateDomainRecord<ToolExecutionRecord>({
      namespace,
      id,
      type: "tool_execution",
      operation,
      patch,
      context,
      visibility,
    });
  }

  async getNode<T>(
    namespace: string,
    type: string,
    id: string,
  ): Promise<T | null> {
    const result = await this.#store.read<NodeRow>(
      `SELECT * FROM ${this.#store.table("nodes")}
       WHERE namespace = $1 AND type = $2 AND id = $3 LIMIT 1`,
      [namespace, type, id],
    );
    return result.rows[0] ? mapNode<T>(result.rows[0]) : null;
  }

  async listNodes<T>(
    namespace: string,
    type: string,
    predicate?: (record: T) => boolean,
  ): Promise<readonly T[]> {
    const result = await this.#store.read<NodeRow>(
      `SELECT * FROM ${this.#store.table("nodes")}
       WHERE namespace = $1 AND type = $2 ORDER BY created_at ASC, id ASC`,
      [namespace, type],
    );
    const records = result.rows.map(mapNode<T>);
    return predicate ? records.filter(predicate) : records;
  }

  async #updateDomainRecord<T extends Record<string, unknown>>(options: {
    namespace: string;
    id: string;
    type: string;
    operation: string;
    patch: Record<string, unknown>;
    context: DomainMutationContext;
    visibility: EventVisibility;
  }): Promise<CommitMutationResult<T>> {
    const current = await this.getNode<T>(
      options.namespace,
      options.type,
      options.id,
    );
    if (!current) throw new Error(`Unknown ${options.type} '${options.id}'.`);
    const next = {
      ...current,
      ...options.patch,
      id: options.id,
      updatedAt: new Date().toISOString(),
    } as T;
    const threadId = typeof next.threadId === "string"
      ? next.threadId
      : undefined;
    const draft = this.#draft(
      `${options.type}.${options.operation}`,
      options.namespace,
      next,
      options.context,
      {
        threadId,
        subject: { type: options.type, id: options.id },
        delta: { before: current, after: next, patch: options.patch },
        visibility: options.visibility,
      },
    );
    const result = await this.#store.commitMutation({
      draft,
      consumerIds: this.#consumers(draft),
      mutate: async (transaction) => {
        await transaction.query(
          `UPDATE ${this.#store.table("nodes")}
           SET name = $4, content = $5, data = $6::jsonb, updated_at = NOW()
           WHERE namespace = $1 AND type = $2 AND id = $3`,
          [
            options.namespace,
            options.type,
            options.id,
            typeof next.name === "string" ? next.name : options.id,
            typeof next.content === "string" ? next.content : null,
            JSON.stringify(next),
          ],
        );
        return next;
      },
      onDuplicate: async (_event, transaction) =>
        await this.#requireNode<T>(
          transaction,
          options.namespace,
          options.type,
          options.id,
        ),
    });
    await this.#notify(result);
    return result;
  }

  #draft(
    type: string,
    namespace: string,
    payload: unknown,
    context: DomainMutationContext,
    extra: Partial<DurableEventDraft>,
  ): DurableEventDraft {
    return {
      type,
      namespace,
      payload,
      routing: {},
      visibility: { kind: "public" },
      metadata: context.metadata ?? {},
      causationId: context.causationId,
      correlationId: context.correlationId,
      deduplicationId: context.deduplicationId,
      ...extra,
    };
  }

  #consumers(draft: DurableEventDraft): readonly string[] {
    return this.#hooks.resolveConsumers(matchEvent(draft));
  }

  async #notify<T>(result: CommitMutationResult<T>): Promise<void> {
    if (!result.deduplicated) await this.#hooks.committed(result);
  }

  async #insertNode<TRecord extends object>(
    transaction: SqlTransaction,
    namespace: string,
    type: string,
    record: TRecord,
  ): Promise<void> {
    const data = record as Record<string, unknown>;
    await transaction.query(
      `INSERT INTO ${this.#store.table("nodes")} (
        id, namespace, type, name, content, data, source_type, source_id,
        created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8,
        $9::timestamptz, $10::timestamptz)`,
      [
        data.id,
        namespace,
        type,
        typeof data.name === "string"
          ? data.name
          : typeof data.externalId === "string"
          ? data.externalId
          : String(data.id),
        typeof data.content === "string" ? data.content : null,
        JSON.stringify(data),
        typeof data.sourceType === "string" ? data.sourceType : null,
        typeof data.sourceId === "string" ? data.sourceId : null,
        data.createdAt,
        data.updatedAt,
      ],
    );
  }

  async #insertEdge(
    transaction: SqlTransaction,
    namespace: string,
    sourceId: string,
    targetId: string,
    type: string,
    data?: Record<string, unknown>,
  ): Promise<void> {
    await transaction.query(
      `INSERT INTO ${this.#store.table("edges")} (
        id, namespace, source_node_id, target_node_id, type, data, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, NOW())
      ON CONFLICT (namespace, source_node_id, target_node_id, type) DO NOTHING`,
      [
        ulid(),
        namespace,
        sourceId,
        targetId,
        type,
        JSON.stringify(data ?? null),
      ],
    );
  }

  async #requireNode<T>(
    transaction: SqlTransaction,
    namespace: string,
    type: string,
    id: string,
  ): Promise<T> {
    const result = await transaction.query<NodeRow>(
      `SELECT * FROM ${this.#store.table("nodes")}
       WHERE namespace = $1 AND type = $2 AND id = $3 LIMIT 1`,
      [namespace, type, id],
    );
    if (!result.rows[0]) throw new Error(`Missing ${type} '${id}'.`);
    return mapNode<T>(result.rows[0]);
  }
}

export { EDGE as DOMAIN_EDGE };
