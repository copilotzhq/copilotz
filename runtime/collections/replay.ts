import type { DurableEvent } from "../events/index.ts";
import type { CollectionDefinition } from "./definition.ts";
import { eventDataRef, readEventBody } from "../events/body-store.ts";
import { sameValue } from "./equal.ts";
import {
  projectAssetManifestEntry,
  projectCollectionEvent,
} from "./reducer.ts";
import { projectGraphRelation } from "./relation-reducer.ts";
import { queryCollectionRecords } from "./query.ts";
import type {
  CollectionEventBody,
  CollectionRecord,
  GraphRelationEventBody,
} from "./types.ts";
import type {
  EventMutationContext,
  EventStore,
  SqlExecutor,
} from "../events/index.ts";
import type { AssetEventBody, AssetManifestEntry } from "../content/index.ts";
import { assetNodeData } from "../content/asset-node.ts";

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

function isRelationLifecycleEvent(event: DurableEvent): boolean {
  return event.type === "relation.upserted" &&
    event.subject?.type === "relation";
}

function isAssetLifecycleEvent(event: DurableEvent): boolean {
  return (event.type === "asset.created" || event.type === "asset.deleted") &&
    event.subject?.type === "asset";
}

function assertCollectionEventBody(
  body: CollectionEventBody<CollectionRecord>,
  event: DurableEvent,
  definition: CollectionDefinition,
): void {
  if (
    event.subject?.type !== definition.name ||
    event.subject.id !== body.record.id ||
    event.namespace !== body.record.namespace ||
    (body.operation !== "create" && body.id !== body.record.id)
  ) {
    throw new Error(
      `Collection Event Body does not match '${event.type}' subject.`,
    );
  }
}

async function loadNamespaceEvents(
  executor: SqlExecutor,
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
    }, executor);
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
    if (
      event.subject?.type !== definition.name || !eventNames.has(event.type)
    ) continue;
    const dataRef = eventDataRef(event.payload);
    const body = await readEventBody<CollectionEventBody<CollectionRecord>>(
      context,
      namespace,
      dataRef,
    );
    assertCollectionEventBody(body, event, definition);
    bodies.push(body);
  }
  return Object.freeze(bodies);
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
  const events = await loadNamespaceEvents(executor, store, namespace);
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
  const events = await loadNamespaceEvents(executor, store, namespace);
  const bodies = await readCollectionBodies(
    executor,
    store,
    namespace,
    definition,
    events,
  );
  const replayed = foldCollectionBodies(bodies);
  const folded = replayed;
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

function isCollectionEventBody(
  value: unknown,
): value is CollectionEventBody<CollectionRecord> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const body = value as Record<string, unknown>;
  if (
    body.operation !== "create" && body.operation !== "update" &&
    body.operation !== "delete" && body.operation !== "command"
  ) return false;
  const record = body.record;
  return !!record && typeof record === "object" && !Array.isArray(record) &&
    typeof (record as Record<string, unknown>).id === "string" &&
    typeof (record as Record<string, unknown>).namespace === "string" &&
    Array.isArray(body.assets);
}

function assetManifestFromEvent(
  body: Extract<AssetEventBody, { operation: "create" }>,
): AssetManifestEntry {
  return Object.freeze({
    assetId: body.asset.id,
    bodyId: body.bodyId,
    mediaType: body.asset.mediaType,
    byteLength: body.asset.byteLength,
    digest: body.asset.digest,
    location: structuredClone(body.asset.location),
    ...(body.idempotencyKey ? { idempotencyKey: body.idempotencyKey } : {}),
    ...(body.asset.origin
      ? { origin: structuredClone(body.asset.origin) }
      : {}),
    ...(body.asset.metadata
      ? { metadata: structuredClone(body.asset.metadata) }
      : {}),
    createdAt: body.asset.createdAt,
    ...(body.asset.readyAt ? { readyAt: body.asset.readyAt } : {}),
  });
}

async function projectAssetLifecycle(
  context: EventMutationContext,
  namespace: string,
  event: DurableEvent,
  body: AssetEventBody,
): Promise<void> {
  if (
    event.subject?.type !== "asset" ||
    event.subject.id !== body.asset.id ||
    body.asset.namespace !== namespace
  ) {
    throw new Error("Asset Event Body does not match its Event subject.");
  }
  if (body.operation === "create") {
    await projectAssetManifestEntry(
      context,
      namespace,
      assetManifestFromEvent(body),
    );
    return;
  }
  const asset = body.asset;
  const data = JSON.stringify(assetNodeData(asset, body.bodyId));
  await context.transaction.query(
    `INSERT INTO ${context.tables.nodes} (
       id, namespace, type, name, data, source_type, source_id,
       created_at, updated_at
     ) VALUES ($1, $2, 'asset', $3, $4::jsonb, $5, $6, $7, $8)
     ON CONFLICT (id) DO UPDATE SET
       name = EXCLUDED.name,
       data = EXCLUDED.data,
       source_type = EXCLUDED.source_type,
       source_id = EXCLUDED.source_id,
       updated_at = EXCLUDED.updated_at
     WHERE ${context.tables.nodes}.namespace = EXCLUDED.namespace
       AND ${context.tables.nodes}.type = 'asset'`,
    [
      asset.id,
      namespace,
      asset.mediaType,
      data,
      body.idempotencyKey ? "asset_idempotency" : null,
      body.idempotencyKey ?? null,
      asset.createdAt,
      asset.deletedAt ?? asset.readyAt ?? asset.createdAt,
    ],
  );
  await context.transaction.query(
    `DELETE FROM ${context.tables.edges}
      WHERE namespace = $1 AND (source_node_id = $2 OR target_node_id = $2)`,
    [namespace, asset.id],
  );
}

/** Rebuilds the complete bound graph for one namespace in global Event order. */
export async function rebuildNamespaceProjections(
  executor: SqlExecutor,
  store: EventStore,
  definitions: readonly CollectionDefinition[],
  namespace: string,
): Promise<void> {
  await executor.query(
    "SELECT pg_advisory_xact_lock_shared(hashtext($1), hashtext($2))",
    [store.databaseSchema, "body-ownership"],
  );
  await executor.query(
    `LOCK TABLE ${store.tables.nodes}, ${store.tables.edges}
     IN ACCESS EXCLUSIVE MODE`,
  );
  const events = await loadNamespaceEvents(executor, store, namespace);
  const context: EventMutationContext = {
    transaction: executor,
    tables: store.tables,
  };
  const byName = new Map(definitions.map((definition) => [
    definition.name,
    definition,
  ]));
  if (byName.size !== definitions.length) {
    throw new TypeError("Namespace rebuild received duplicate Collections.");
  }
  const storedTypes = await executor.query<{ type: string }>(
    `SELECT DISTINCT type FROM ${store.tables.nodes}
     WHERE namespace = $1 AND type <> 'asset'`,
    [namespace],
  );
  const unknownStoredTypes = storedTypes.rows.map((row) => row.type).filter(
    (name) => !byName.has(name),
  );
  if (unknownStoredTypes.length) {
    throw new Error(
      `Namespace rebuild is missing Collection definitions: ${
        unknownStoredTypes.join(
          ", ",
        )
      }.`,
    );
  }

  const bodies = new Map<string, unknown>();
  const bodyFor = async (event: DurableEvent): Promise<unknown | undefined> => {
    if (bodies.has(event.id)) return bodies.get(event.id);
    const payload = event.payload && typeof event.payload === "object" &&
        !Array.isArray(event.payload)
      ? event.payload as Record<string, unknown>
      : {};
    if (!payload.dataRef) return undefined;
    const body = await readEventBody<unknown>(
      context,
      namespace,
      eventDataRef(event.payload),
    );
    bodies.set(event.id, body);
    return body;
  };
  for (const event of events) {
    if (!event.subject || event.subject.type === "asset") continue;
    if (byName.has(event.subject.type) || isRelationLifecycleEvent(event)) {
      continue;
    }
    const body = await bodyFor(event);
    if (isCollectionEventBody(body)) {
      throw new Error(
        `Namespace rebuild is missing Collection definition '${event.subject.type}'.`,
      );
    }
  }

  await executor.query(
    `DELETE FROM ${store.tables.edges} WHERE namespace = $1`,
    [namespace],
  );
  await executor.query(
    `DELETE FROM ${store.tables.nodes} WHERE namespace = $1`,
    [namespace],
  );
  for (const event of events) {
    if (isRelationLifecycleEvent(event)) {
      const body = await bodyFor(event) as GraphRelationEventBody;
      if (
        body?.operation !== "upsert" ||
        body.relation?.id !== event.subject!.id ||
        body.relation.namespace !== namespace ||
        body.intent?.id !== body.relation.id
      ) {
        throw new Error(
          "Relation Event Body does not match its Event subject.",
        );
      }
      await projectGraphRelation(context, body.relation);
      continue;
    }
    if (isAssetLifecycleEvent(event)) {
      const body = await bodyFor(event) as AssetEventBody;
      await projectAssetLifecycle(context, namespace, event, body);
      continue;
    }
    const subject = event.subject;
    if (!subject) continue;
    const definition = byName.get(subject.type);
    if (!definition || !collectionEventNames(definition).has(event.type)) {
      continue;
    }
    const body = await bodyFor(event) as CollectionEventBody<CollectionRecord>;
    assertCollectionEventBody(body, event, definition);
    await projectCollectionEvent(context, definition, body);
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
