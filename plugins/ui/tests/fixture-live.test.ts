/**
 * Test and demo transport: answers any bounded Collection query from
 * in-memory tables and pushes a fresh owner snapshot to every subscription a
 * change touches. It speaks the canonical frame contract, never a reducer.
 * @module
 */
import type { SubscriptionTransport } from "../../../client/live-query.ts";
import type { CollectionRecord } from "../../../runtime/collections/types.ts";
import type { SubscriptionFrame } from "../../../runtime/subscriptions/types.ts";
import { SubscriptionQueue } from "../../../runtime/subscriptions/device.ts";

type Row = { id: string; [field: string]: unknown };
type Query = Readonly<Record<string, unknown>> | undefined;
type Subscription = {
  collection: string;
  query: Query;
  queue: SubscriptionQueue<SubscriptionFrame>;
  progressOnly: boolean;
};

function field(row: Row, path: string): unknown {
  let value: unknown = row;
  for (const key of path.split(".")) {
    value = value && typeof value === "object"
      ? (value as Record<string, unknown>)[key]
      : undefined;
  }
  return value;
}

/** Equality `where`, one `order` field, and `limit`, as the live owner bounds them. */
export function select(rows: readonly Row[], query: Query): Row[] {
  const where = (query?.where ?? {}) as Record<string, unknown>;
  const order = query?.order as
    | { field?: string; direction?: "asc" | "desc" }
    | undefined;
  const by = order?.field ?? "id";
  const sign = order?.direction === "desc" ? -1 : 1;
  const selected = rows.filter((row) =>
    Object.entries(where).every(([key, value]) => field(row, key) === value)
  ).sort((left, right) => {
    const a = String(field(left, by) ?? ""), b = String(field(right, by) ?? "");
    return (a < b ? -1 : a > b ? 1 : left.id < right.id ? -1 : 1) * sign;
  });
  const limit = typeof query?.limit === "number" ? query.limit : undefined;
  return limit === undefined ? selected : selected.slice(0, limit);
}

export class FixtureLive implements SubscriptionTransport {
  readonly tables: Map<string, Map<string, Row>> = new Map();
  private subscriptions = new Set<Subscription>();
  private sequence = 1;
  /** Collections whose reads the owner refuses. */
  readonly denied: Set<string> = new Set();
  /** Refuse `order` by any field but id, as owners did before ordered live reads. */
  idOrderOnly = false;

  constructor(data: Readonly<Record<string, readonly Row[]>> = {}) {
    for (const [collection, rows] of Object.entries(data)) {
      this.tables.set(
        collection,
        new Map(rows.map((row) => [row.id, structuredClone(row)])),
      );
    }
  }

  rows(collection: string): Row[] {
    return [...(this.tables.get(collection)?.values() ?? [])];
  }

  get(collection: string, id: string): Row | undefined {
    return this.tables.get(collection)?.get(id);
  }

  private frame(subscription: Subscription): SubscriptionFrame {
    const sequence = String(this.sequence);
    const rows = subscription.progressOnly
      ? []
      : select(this.rows(subscription.collection), subscription.query);
    return {
      t: "snapshot",
      complete: true,
      sequence,
      checkpoint: sequence,
      rows: rows.map((row) => ({
        namespace: "main",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        ...structuredClone(row),
      })) as CollectionRecord[],
    };
  }

  observe(
    collection: string,
    query: Parameters<SubscriptionTransport["observe"]>[1],
    options: Parameters<SubscriptionTransport["observe"]>[2],
  ): ReturnType<SubscriptionTransport["observe"]> {
    const order = (query as Query)?.order as { field?: string } | undefined;
    if (this.denied.has(collection)) {
      return Promise.reject(
        Object.assign(new Error("Forbidden"), {
          code: "forbidden",
          status: 403,
        }),
      );
    }
    if (this.idOrderOnly && order?.field && order.field !== "id") {
      return Promise.reject(
        Object.assign(new Error("Subscription failed."), {
          code: "subscription_failed",
          retryable: false,
        }),
      );
    }
    const queue = new SubscriptionQueue<SubscriptionFrame>();
    const subscription: Subscription = {
      collection,
      query: query as Query,
      queue,
      progressOnly: options.progressOnly === true,
    };
    this.subscriptions.add(subscription);
    queueMicrotask(() => queue.push(this.frame(subscription)));
    const detach = () => {
      this.subscriptions.delete(subscription);
      queue.end();
      options.signal?.removeEventListener("abort", detach);
    };
    options.signal?.addEventListener("abort", detach, { once: true });
    return Promise.resolve({ frames: queue, detach });
  }

  private publish(collection: string) {
    this.sequence++;
    for (const subscription of this.subscriptions) {
      if (subscription.collection === collection) {
        subscription.queue.push(this.frame(subscription));
      }
    }
  }

  /** Create or replace rows. */
  put(collection: string, ...rows: Row[]): void {
    let table = this.tables.get(collection);
    if (!table) this.tables.set(collection, table = new Map());
    for (const row of rows) table.set(row.id, structuredClone(row));
    this.publish(collection);
  }

  /** Merge fields into a row. */
  patch(collection: string, id: string, fields: Record<string, unknown>): void {
    const row = this.get(collection, id);
    if (!row) return;
    this.put(collection, { ...row, ...fields, id });
  }

  remove(collection: string, id: string): void {
    this.tables.get(collection)?.delete(id);
    this.publish(collection);
  }

  get subscriptionCount(): number {
    return this.subscriptions.size;
  }
}
