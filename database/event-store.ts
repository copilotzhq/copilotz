import { ulid } from "ulid";
import type {
  DeliveryStatus,
  DurableEvent,
  DurableEventDraft,
  EventDelivery,
} from "@/events/types.ts";
import { quoteIdentifier, V2_SCHEMA_VERSION } from "./v2-schema.ts";
import type { DatabaseSession, SqlTransaction } from "./session.ts";

const UNSETTLED_STATUSES = ["pending", "leased", "retry_wait"] as const;

interface EventRow extends Record<string, unknown> {
  id: string;
  position: string | number | bigint;
  schema_version: number;
  type: string;
  namespace: string;
  thread_id: string | null;
  subject_type: string | null;
  subject_id: string | null;
  payload: unknown;
  delta: unknown;
  routing: Record<string, unknown>;
  visibility: Record<string, unknown>;
  metadata: Record<string, unknown>;
  causation_id: string | null;
  correlation_id: string;
  deduplication_id: string | null;
  created_at: string | Date;
}

interface DeliveryRow extends Record<string, unknown> {
  id: string;
  event_id: string;
  consumer_id: string;
  status: DeliveryStatus;
  attempts: number;
  max_attempts: number;
  priority: number;
  available_at: string | Date;
  lease_owner: string | null;
  lease_expires_at: string | Date | null;
  last_error: Record<string, unknown> | null;
  created_at: string | Date;
  updated_at: string | Date;
  settled_at: string | Date | null;
}

function iso(value: string | Date | null | undefined): string | undefined {
  if (value == null) return undefined;
  return value instanceof Date
    ? value.toISOString()
    : new Date(value).toISOString();
}

function json(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function mapEvent(row: EventRow): DurableEvent {
  return Object.freeze({
    durable: true,
    id: row.id,
    position: String(row.position),
    schemaVersion: row.schema_version,
    type: row.type,
    namespace: row.namespace,
    ...(row.thread_id ? { threadId: row.thread_id } : {}),
    ...(row.subject_type && row.subject_id
      ? { subject: { type: row.subject_type, id: row.subject_id } }
      : {}),
    payload: row.payload,
    ...(row.delta == null ? {} : { delta: row.delta }),
    routing: row.routing ?? {},
    visibility:
      (row.visibility ?? { kind: "public" }) as DurableEvent["visibility"],
    metadata: row.metadata ?? {},
    ...(row.causation_id ? { causationId: row.causation_id } : {}),
    correlationId: row.correlation_id,
    ...(row.deduplication_id ? { deduplicationId: row.deduplication_id } : {}),
    createdAt: iso(row.created_at)!,
  });
}

function mapDelivery(row: DeliveryRow): EventDelivery {
  return Object.freeze({
    id: row.id,
    eventId: row.event_id,
    consumerId: row.consumer_id,
    status: row.status,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    priority: row.priority,
    availableAt: iso(row.available_at)!,
    ...(row.lease_owner ? { leaseOwner: row.lease_owner } : {}),
    ...(row.lease_expires_at
      ? { leaseExpiresAt: iso(row.lease_expires_at) }
      : {}),
    ...(row.last_error ? { lastError: row.last_error } : {}),
    createdAt: iso(row.created_at)!,
    updatedAt: iso(row.updated_at)!,
    ...(row.settled_at ? { settledAt: iso(row.settled_at) } : {}),
  });
}

export interface CommitMutationOptions<T> {
  draft: DurableEventDraft;
  consumerIds: readonly string[];
  priority?: number;
  maxAttempts?: number;
  mutate(transaction: SqlTransaction): Promise<T>;
  onDuplicate?: (
    event: DurableEvent,
    transaction: SqlTransaction,
  ) => Promise<T>;
}

export interface CommitMutationResult<T> {
  value: T;
  event: DurableEvent;
  deliveries: readonly EventDelivery[];
  deduplicated: boolean;
}

export interface CorrelationSettlement {
  unsettled: number;
  deadLetters: number;
  cancelled: number;
}

export class EventStore {
  readonly #session: DatabaseSession;
  readonly #schema: string;

  constructor(session: DatabaseSession, schemaName = "public") {
    this.#session = session;
    this.#schema = quoteIdentifier(schemaName);
  }

  table(name: "nodes" | "edges" | "events" | "event_deliveries"): string {
    return `${this.#schema}.${quoteIdentifier(name)}`;
  }

  /** Internal read path used by graph repositories; not exported publicly. */
  read<TRow extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: TRow[] }> {
    return this.#session.query<TRow>(sql, params);
  }

  async commitMutation<T>(
    options: CommitMutationOptions<T>,
  ): Promise<CommitMutationResult<T>> {
    const draft = options.draft;
    const eventId = ulid();
    const correlationId = draft.correlationId ?? eventId;
    const createdAt = draft.createdAt ?? new Date().toISOString();
    const consumers = [...new Set(options.consumerIds)];

    return await this.#session.transaction(async (transaction) => {
      if (draft.deduplicationId) {
        const existingResult = await transaction.query<EventRow>(
          `SELECT * FROM ${this.table("events")}
           WHERE namespace = $1 AND deduplication_id = $2
           LIMIT 1`,
          [draft.namespace, draft.deduplicationId],
        );
        const existingRow = existingResult.rows[0];
        if (existingRow) {
          const event = mapEvent(existingRow);
          if (!options.onDuplicate) {
            throw new Error(
              `Mutation '${draft.deduplicationId}' was already committed.`,
            );
          }
          const value = await options.onDuplicate(event, transaction);
          const deliveries = await this.#deliveriesForEvent(
            transaction,
            event.id,
          );
          return { value, event, deliveries, deduplicated: true };
        }
      }

      const value = await options.mutate(transaction);
      const inserted = await transaction.query<EventRow>(
        `INSERT INTO ${this.table("events")} (
          id, schema_version, type, namespace, thread_id,
          subject_type, subject_id, payload, delta, routing, visibility,
          metadata, causation_id, correlation_id, deduplication_id, created_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7,
          $8::jsonb, $9::jsonb, $10::jsonb, $11::jsonb,
          $12::jsonb, $13, $14, $15, $16::timestamptz
        ) RETURNING *`,
        [
          eventId,
          V2_SCHEMA_VERSION,
          draft.type,
          draft.namespace,
          draft.threadId ?? null,
          draft.subject?.type ?? null,
          draft.subject?.id ?? null,
          json(draft.payload),
          json(draft.delta),
          json({ ...(draft.routing ?? {}), consumerIds: consumers }),
          json(draft.visibility ?? { kind: "public" }),
          json(draft.metadata ?? {}),
          draft.causationId ?? null,
          correlationId,
          draft.deduplicationId ?? null,
          createdAt,
        ],
      );
      const event = mapEvent(inserted.rows[0]);

      const deliveries: EventDelivery[] = [];
      for (const consumerId of consumers) {
        const deliveryId = ulid();
        const delivery = await transaction.query<DeliveryRow>(
          `INSERT INTO ${this.table("event_deliveries")} (
            id, event_id, consumer_id, status, attempts, max_attempts,
            priority, available_at, created_at, updated_at
          ) VALUES ($1, $2, $3, 'pending', 0, $4, $5, NOW(), NOW(), NOW())
          RETURNING *`,
          [
            deliveryId,
            event.id,
            consumerId,
            options.maxAttempts ?? 3,
            options.priority ?? 0,
          ],
        );
        deliveries.push(mapDelivery(delivery.rows[0]));
      }

      if (draft.threadId) {
        await transaction.query(
          `UPDATE ${this.table("nodes")}
           SET data = COALESCE(data, '{}'::jsonb) || $1::jsonb,
               updated_at = NOW()
           WHERE id = $2 AND namespace = $3 AND type = 'thread'`,
          [
            json({
              lastEventId: event.id,
              lastEventPosition: event.position,
              lastEventAt: event.createdAt,
            }),
            draft.threadId,
            draft.namespace,
          ],
        );
      }

      return { value, event, deliveries, deduplicated: false };
    });
  }

  async append(
    draft: DurableEventDraft,
    consumerIds: readonly string[],
  ): Promise<CommitMutationResult<void>> {
    return await this.commitMutation({
      draft,
      consumerIds,
      mutate: () => Promise.resolve(),
      onDuplicate: () => Promise.resolve(),
    });
  }

  async getEvent(id: string): Promise<DurableEvent | null> {
    const result = await this.#session.query<EventRow>(
      `SELECT * FROM ${this.table("events")} WHERE id = $1 LIMIT 1`,
      [id],
    );
    return result.rows[0] ? mapEvent(result.rows[0]) : null;
  }

  async listEvents(options: {
    namespace: string;
    threadId?: string;
    correlationId?: string;
    afterPosition?: string;
    limit?: number;
  }): Promise<readonly DurableEvent[]> {
    const conditions = ["namespace = $1"];
    const params: unknown[] = [options.namespace];
    const add = (sql: string, value: unknown) => {
      params.push(value);
      conditions.push(sql.replace("?", `$${params.length}`));
    };
    if (options.threadId) add("thread_id = ?", options.threadId);
    if (options.correlationId) {
      add("correlation_id = ?", options.correlationId);
    }
    if (options.afterPosition) {
      add("position > ?::bigint", options.afterPosition);
    }
    params.push(Math.max(1, Math.min(options.limit ?? 1_000, 10_000)));
    const result = await this.#session.query<EventRow>(
      `SELECT * FROM ${this.table("events")}
       WHERE ${conditions.join(" AND ")}
       ORDER BY position ASC LIMIT $${params.length}`,
      params,
    );
    return result.rows.map(mapEvent);
  }

  async getDelivery(id: string): Promise<EventDelivery | null> {
    const result = await this.#session.query<DeliveryRow>(
      `SELECT * FROM ${this.table("event_deliveries")} WHERE id = $1 LIMIT 1`,
      [id],
    );
    return result.rows[0] ? mapDelivery(result.rows[0]) : null;
  }

  async listDeliveries(options: {
    namespace?: string;
    eventId?: string;
    correlationId?: string;
    status?: DeliveryStatus;
    limit?: number;
  } = {}): Promise<readonly EventDelivery[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    const add = (condition: string, value: unknown) => {
      params.push(value);
      conditions.push(condition.replace("?", `$${params.length}`));
    };
    if (options.namespace) add("e.namespace = ?", options.namespace);
    if (options.eventId) add("d.event_id = ?", options.eventId);
    if (options.correlationId) {
      add("e.correlation_id = ?", options.correlationId);
    }
    if (options.status) add("d.status = ?", options.status);
    params.push(Math.max(1, Math.min(options.limit ?? 1_000, 10_000)));
    const result = await this.#session.query<DeliveryRow>(
      `SELECT d.* FROM ${this.table("event_deliveries")} d
       JOIN ${this.table("events")} e ON e.id = d.event_id
       ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""}
       ORDER BY d.created_at, d.id LIMIT $${params.length}`,
      params,
    );
    return result.rows.map(mapDelivery);
  }

  async claimDelivery(options: {
    id: string;
    owner: string;
    leaseMs?: number;
  }): Promise<EventDelivery | null> {
    const leaseMs = options.leaseMs ?? 120_000;
    const result = await this.#session.query<DeliveryRow>(
      `UPDATE ${this.table("event_deliveries")}
       SET status = 'leased', attempts = attempts + 1,
           lease_owner = $2,
           lease_expires_at = NOW() + ($3 * INTERVAL '1 millisecond'),
           updated_at = NOW()
       WHERE id = $1
         AND (
           (status IN ('pending', 'retry_wait') AND available_at <= NOW())
           OR (status = 'leased' AND lease_expires_at <= NOW())
         )
       RETURNING *`,
      [options.id, options.owner, leaseMs],
    );
    return result.rows[0] ? mapDelivery(result.rows[0]) : null;
  }

  async heartbeatDelivery(options: {
    id: string;
    owner: string;
    leaseMs?: number;
  }): Promise<boolean> {
    const result = await this.#session.query<{ id: string }>(
      `UPDATE ${this.table("event_deliveries")}
       SET lease_expires_at = NOW() + ($3 * INTERVAL '1 millisecond'),
           updated_at = NOW()
       WHERE id = $1 AND status = 'leased' AND lease_owner = $2
       RETURNING id`,
      [options.id, options.owner, options.leaseMs ?? 120_000],
    );
    return result.rows.length === 1;
  }

  async succeedDelivery(id: string, owner: string): Promise<boolean> {
    return await this.#settleDelivery(id, owner, "succeeded");
  }

  async cancelDelivery(id: string, owner?: string): Promise<boolean> {
    return await this.#settleDelivery(id, owner, "cancelled");
  }

  async failDelivery(options: {
    id: string;
    owner: string;
    error: unknown;
    backoffMs: number;
  }): Promise<EventDelivery | null> {
    const serialized = serializeError(options.error);
    const result = await this.#session.query<DeliveryRow>(
      `UPDATE ${this.table("event_deliveries")}
       SET status = CASE WHEN attempts >= max_attempts
                         THEN 'dead_letter' ELSE 'retry_wait' END,
           available_at = CASE WHEN attempts >= max_attempts THEN available_at
             ELSE NOW() + ($3 * INTERVAL '1 millisecond') END,
           lease_owner = NULL, lease_expires_at = NULL,
           last_error = $4::jsonb, updated_at = NOW(),
           settled_at = CASE WHEN attempts >= max_attempts THEN NOW() ELSE NULL END
       WHERE id = $1 AND status = 'leased' AND lease_owner = $2
       RETURNING *`,
      [options.id, options.owner, options.backoffMs, json(serialized)],
    );
    return result.rows[0] ? mapDelivery(result.rows[0]) : null;
  }

  async listRecoverable(limit = 100): Promise<readonly EventDelivery[]> {
    const result = await this.#session.query<DeliveryRow>(
      `SELECT * FROM ${this.table("event_deliveries")}
       WHERE (status IN ('pending', 'retry_wait') AND available_at <= NOW())
          OR (status = 'leased' AND lease_expires_at <= NOW())
       ORDER BY priority DESC, available_at ASC, created_at ASC
       LIMIT $1`,
      [Math.max(1, Math.min(limit, 1_000))],
    );
    return result.rows.map(mapDelivery);
  }

  async nextRecoveryDelayMs(): Promise<number | null> {
    const result = await this.#session.query<
      { delay_ms: string | number | null }
    >(
      `SELECT GREATEST(0, EXTRACT(EPOCH FROM (
         MIN(CASE WHEN status = 'leased' THEN lease_expires_at ELSE available_at END)
         - NOW()
       )) * 1000) AS delay_ms
       FROM ${this.table("event_deliveries")}
       WHERE status IN ('pending', 'leased', 'retry_wait')`,
    );
    const value = result.rows[0]?.delay_ms;
    return value == null ? null : Math.max(0, Number(value));
  }

  async correlationSettlement(
    namespace: string,
    correlationId: string,
  ): Promise<CorrelationSettlement> {
    const result = await this.#session.query<{
      unsettled: string | number;
      dead_letters: string | number;
      cancelled: string | number;
    }>(
      `SELECT
         COUNT(*) FILTER (WHERE d.status IN ('pending', 'leased', 'retry_wait')) AS unsettled,
         COUNT(*) FILTER (WHERE d.status = 'dead_letter') AS dead_letters,
         COUNT(*) FILTER (WHERE d.status = 'cancelled') AS cancelled
       FROM ${this.table("event_deliveries")} d
       JOIN ${this.table("events")} e ON e.id = d.event_id
       WHERE e.namespace = $1 AND e.correlation_id = $2`,
      [namespace, correlationId],
    );
    const row = result.rows[0];
    return {
      unsettled: Number(row?.unsettled ?? 0),
      deadLetters: Number(row?.dead_letters ?? 0),
      cancelled: Number(row?.cancelled ?? 0),
    };
  }

  async cancelCorrelation(
    namespace: string,
    correlationId: string,
    reason?: string,
  ): Promise<number> {
    const result = await this.#session.query<{ id: string }>(
      `UPDATE ${this.table("event_deliveries")} d
       SET status = 'cancelled', lease_owner = NULL, lease_expires_at = NULL,
           last_error = $3::jsonb, updated_at = NOW(), settled_at = NOW()
       FROM ${this.table("events")} e
       WHERE e.id = d.event_id AND e.namespace = $1
         AND e.correlation_id = $2
         AND d.status IN ('pending', 'leased', 'retry_wait')
       RETURNING d.id`,
      [namespace, correlationId, json({ reason: reason ?? "cancelled" })],
    );
    return result.rows.length;
  }

  async retryDeadLetter(id: string): Promise<boolean> {
    const result = await this.#session.query<{ id: string }>(
      `UPDATE ${this.table("event_deliveries")}
       SET status = 'pending', attempts = 0, available_at = NOW(),
           lease_owner = NULL, lease_expires_at = NULL,
           last_error = NULL, settled_at = NULL, updated_at = NOW()
       WHERE id = $1 AND status = 'dead_letter' RETURNING id`,
      [id],
    );
    return result.rows.length === 1;
  }

  async discardDeadLetter(id: string): Promise<boolean> {
    const result = await this.#session.query<{ id: string }>(
      `UPDATE ${this.table("event_deliveries")}
       SET status = 'cancelled', updated_at = NOW(), settled_at = NOW()
       WHERE id = $1 AND status = 'dead_letter' RETURNING id`,
      [id],
    );
    return result.rows.length === 1;
  }

  async compact(options: {
    retentionMs?: number | null;
    now?: Date;
  } = {}): Promise<{ events: number; deliveries: number }> {
    if (options.retentionMs === null) return { events: 0, deliveries: 0 };
    const retentionMs = options.retentionMs ?? 7 * 24 * 60 * 60 * 1_000;
    const cutoff = new Date((options.now ?? new Date()).getTime() - retentionMs)
      .toISOString();
    return await this.#session.transaction(async (transaction) => {
      const deliveries = await transaction.query<{ id: string }>(
        `DELETE FROM ${this.table("event_deliveries")} d
         USING ${this.table("events")} e
         WHERE e.id = d.event_id AND e.created_at < $1::timestamptz
           AND d.status IN ('succeeded', 'cancelled')
           AND NOT EXISTS (
             SELECT 1 FROM ${this.table("event_deliveries")} active
             WHERE active.event_id = e.id
               AND active.status IN ('pending', 'leased', 'retry_wait', 'dead_letter')
           ) RETURNING d.id`,
        [cutoff],
      );
      const events = await transaction.query<{ id: string }>(
        `DELETE FROM ${this.table("events")} e
         WHERE e.created_at < $1::timestamptz
           AND NOT EXISTS (
             SELECT 1 FROM ${this.table("event_deliveries")} d
             WHERE d.event_id = e.id
           ) RETURNING e.id`,
        [cutoff],
      );
      return { events: events.rows.length, deliveries: deliveries.rows.length };
    });
  }

  async #deliveriesForEvent(
    transaction: SqlTransaction,
    eventId: string,
  ): Promise<readonly EventDelivery[]> {
    const result = await transaction.query<DeliveryRow>(
      `SELECT * FROM ${this.table("event_deliveries")}
       WHERE event_id = $1 ORDER BY created_at, id`,
      [eventId],
    );
    return result.rows.map(mapDelivery);
  }

  async #settleDelivery(
    id: string,
    owner: string | undefined,
    status: Extract<DeliveryStatus, "succeeded" | "cancelled">,
  ): Promise<boolean> {
    const ownerCondition = owner ? "AND lease_owner = $3" : "";
    const params: unknown[] = [id, status];
    if (owner) params.push(owner);
    const result = await this.#session.query<{ id: string }>(
      `UPDATE ${this.table("event_deliveries")}
       SET status = $2, lease_owner = NULL, lease_expires_at = NULL,
           updated_at = NOW(), settled_at = NOW()
       WHERE id = $1 AND status IN ('pending', 'leased', 'retry_wait')
       ${ownerCondition} RETURNING id`,
      params,
    );
    return result.rows.length === 1;
  }
}

export function serializeError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      ...(error.stack ? { stack: error.stack } : {}),
    };
  }
  return { name: "Error", message: String(error) };
}

export { UNSETTLED_STATUSES };
