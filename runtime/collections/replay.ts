import type { DurableEvent } from "../events/index.ts";
import type { CollectionDefinition } from "./definition.ts";
import { eventDataRef, readEventBody } from "../events/body-store.ts";
import { sameValue } from "./equal.ts";
import { projectCollectionEvent } from "./reducer.ts";
import { queryCollectionRecords } from "./query.ts";
import type { CollectionEventBody, CollectionRecord } from "./types.ts";
import type {
  EventMutationContext,
  EventStore,
  SqlExecutor,
} from "../events/index.ts";

function collectionEventNames(
  definition: CollectionDefinition,
): ReadonlySet<string> {
  return new Set([
    `${definition.name}.created`,
    `${definition.name}.updated`,
    `${definition.name}.deleted`,
    ...Object.values(definition.commands ?? {}).flatMap((command) =>
      command.event ? [command.event] : []
    ),
  ]);
}

const replayPageSize = 1_000;

async function loadNamespaceEvents(
  store: EventStore,
  namespace: string,
): Promise<readonly DurableEvent[]> {
  const events: DurableEvent[] = [];
  let afterPosition: string | undefined;
  while (true) {
    const page = await store.listEvents({
      namespace,
      ...(afterPosition ? { afterPosition } : {}),
      limit: replayPageSize,
    });
    events.push(...page);
    if (page.length < replayPageSize) break;
    const nextPosition = page.at(-1)?.position;
    if (!nextPosition || nextPosition === afterPosition) {
      throw new Error("Event replay pagination did not advance.");
    }
    afterPosition = nextPosition;
  }
  return Object.freeze(events);
}

async function readCollectionBodies(
  executor: SqlExecutor,
  store: EventStore,
  namespace: string,
  definition: CollectionDefinition,
  events: readonly DurableEvent[],
): Promise<readonly CollectionEventBody<CollectionRecord>[]> {
  const bodies: CollectionEventBody<CollectionRecord>[] = [];
  const context = { transaction: executor, tables: store.tables };
  const eventNames = collectionEventNames(definition);
  for (const event of events) {
    if (!eventNames.has(event.type)) continue;
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

function withThreadActivity(
  records: ReadonlyMap<string, CollectionRecord>,
  events: readonly DurableEvent[],
): ReadonlyMap<string, CollectionRecord> {
  const activity = new Map<
    string,
    Readonly<{
      lastEventId: string;
      lastEventPosition: string;
      lastEventAt: string;
    }>
  >();
  for (const event of events) {
    if (!event.threadId) continue;
    activity.set(event.threadId, {
      lastEventId: event.id,
      lastEventPosition: event.position,
      lastEventAt: event.createdAt,
    });
  }
  return new Map(
    [...records].map(([id, record]) => [
      id,
      Object.freeze({ ...record, ...(activity.get(id) ?? {}) }),
    ]),
  );
}

async function loadStoredProjections(
  executor: SqlExecutor,
  store: EventStore,
  definition: CollectionDefinition,
  namespace: string,
): Promise<readonly CollectionRecord[]> {
  const stored: CollectionRecord[] = [];
  let after: string | undefined;
  while (true) {
    const page = await queryCollectionRecords(
      executor,
      store.tables,
      definition,
      namespace,
      {
        limit: replayPageSize,
        order: { field: "id" },
        ...(after ? { after } : {}),
      },
    );
    stored.push(...page);
    if (page.length < replayPageSize) break;
    const next = page.at(-1)?.id;
    if (!next || next === after) {
      throw new Error("Projection verification pagination did not advance.");
    }
    after = next;
  }
  return Object.freeze(stored);
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
  definition: CollectionDefinition,
): Promise<readonly CollectionEventBody<CollectionRecord>[]> {
  const events = await loadNamespaceEvents(store, namespace);
  return await readCollectionBodies(
    executor,
    store,
    namespace,
    definition,
    events,
  );
}

export async function verifyCollectionProjections(
  executor: SqlExecutor,
  store: EventStore,
  definition: CollectionDefinition,
  namespace: string,
): Promise<Readonly<{ ok: true } | { ok: false; reason: string }>> {
  const events = await loadNamespaceEvents(store, namespace);
  const bodies = await readCollectionBodies(
    executor,
    store,
    namespace,
    definition,
    events,
  );
  const replayed = foldCollectionBodies(bodies);
  const folded = definition.name === "thread"
    ? withThreadActivity(replayed, events)
    : replayed;
  const stored = await loadStoredProjections(
    executor,
    store,
    definition,
    namespace,
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
      return {
        ok: false,
        reason: `Stored '${record.id}' is absent from replay.`,
      };
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
  const events = await loadNamespaceEvents(store, namespace);
  const bodies = await readCollectionBodies(
    executor,
    store,
    namespace,
    definition,
    events,
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
  if (definition.name === "thread") {
    const activity = withThreadActivity(foldCollectionBodies(bodies), events);
    for (const [threadId, record] of activity) {
      await executor.query(
        `UPDATE ${store.tables.nodes}
         SET data = COALESCE(data, '{}'::jsonb) || $1::jsonb,
             updated_at = NOW()
         WHERE id = $2 AND namespace = $3 AND type = 'thread'`,
        [
          JSON.stringify({
            lastEventId: record.lastEventId,
            lastEventPosition: record.lastEventPosition,
            lastEventAt: record.lastEventAt,
          }),
          threadId,
          namespace,
        ],
      );
    }
  }
}

export function isCollectionEvent(
  event: DurableEvent,
  collection: string | CollectionDefinition,
): boolean {
  if (typeof collection === "string") {
    return event.type === `${collection}.created` ||
      event.type === `${collection}.updated` ||
      event.type === `${collection}.deleted`;
  }
  return collectionEventNames(collection).has(event.type);
}
