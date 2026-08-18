import type { DurableEvent } from "../events/index.ts";
import type { CollectionDefinition } from "./definition.ts";
import { eventDataRef, readEventBody } from "./body.ts";
import { sameValue } from "./equal.ts";
import { projectCollectionEvent } from "./reducer.ts";
import { queryCollectionRecords } from "./query.ts";
import type {
  CollectionEventBody,
  CollectionRecord,
} from "./types.ts";
import type { EventMutationContext, EventStore, SqlExecutor } from "../events/index.ts";

function canonicalName(eventType: string, name: string): boolean {
  return eventType === `${name}.created` ||
    eventType === `${name}.updated` ||
    eventType === `${name}.deleted`;
}

export function foldCollectionBodies(
  bodies: readonly CollectionEventBody<CollectionRecord>[],
): ReadonlyMap<string, CollectionRecord> {
  const records = new Map<string, CollectionRecord>();
  for (const body of bodies) {
    if (body.operation === "delete") records.delete(body.id);
    else records.set(body.record.id, body.record);
  }
  return records;
}

export async function loadCollectionEventBodies(
  executor: SqlExecutor,
  store: EventStore,
  namespace: string,
  name: string,
): Promise<readonly CollectionEventBody<CollectionRecord>[]> {
  const events = await store.listEvents({ namespace, limit: 10_000 });
  const bodies: CollectionEventBody<CollectionRecord>[] = [];
  const context = { transaction: executor, tables: store.tables };
  for (const event of events) {
    if (!canonicalName(event.type, name)) continue;
    const dataRef = eventDataRef(event.payload);
    bodies.push(
      await readEventBody<CollectionEventBody<CollectionRecord>>(
        context,
        namespace,
        dataRef,
      ),
    );
  }
  return Object.freeze(bodies);
}

export async function verifyCollectionProjections(
  executor: SqlExecutor,
  store: EventStore,
  definition: CollectionDefinition,
  namespace: string,
): Promise<Readonly<{ ok: true } | { ok: false; reason: string }>> {
  const bodies = await loadCollectionEventBodies(
    executor,
    store,
    namespace,
    definition.name,
  );
  const folded = foldCollectionBodies(bodies);
  const stored = await queryCollectionRecords(
    executor,
    store.tables,
    definition,
    namespace,
    { limit: 1_000, order: { field: "id" } },
  );
  if (stored.length !== folded.size) {
    return {
      ok: false,
      reason:
        `Projection count ${stored.length} != replayed ${folded.size} for '${definition.name}'.`,
    };
  }
  for (const record of stored) {
    const expected = folded.get(record.id);
    if (!expected) {
      return { ok: false, reason: `Stored '${record.id}' is absent from replay.` };
    }
    if (!sameValue(expected, record)) {
      return {
        ok: false,
        reason: `Stored '${record.id}' does not match replayed record.`,
      };
    }
  }
  return { ok: true };
}

export async function rebuildCollectionProjections(
  executor: SqlExecutor,
  store: EventStore,
  definition: CollectionDefinition,
  namespace: string,
): Promise<void> {
  const bodies = await loadCollectionEventBodies(
    executor,
    store,
    namespace,
    definition.name,
  );
  // Delete only this collection's nodes. Declared edges cascade from the
  // nodes table FK. Event-body asset nodes are type=asset and stay put.
  await executor.query(
    `DELETE FROM ${store.tables.nodes}
     WHERE namespace = $1 AND type = $2`,
    [namespace, definition.name],
  );
  const context: EventMutationContext = {
    transaction: executor,
    tables: store.tables,
  };
  for (const body of bodies) {
    await projectCollectionEvent(context, definition, body);
  }
}

export function isCollectionEvent(
  event: DurableEvent,
  name: string,
): boolean {
  return canonicalName(event.type, name);
}
