import { sameActionValue } from "./value.ts";
import { resolveOwnerIngress } from "../application/ingress/authority.ts";
/** Fixed-source retained provenance. Caller metadata is never an ancestry edge. */
import { createOperationCatalogTables } from "../streams/catalog.ts";
import { createCoreTableNames } from "../events/schema.ts";
import { eventDataRef, verifiedEventBody } from "../events/body-store.ts";
import type { SqlExecutor } from "../events/session.ts";
import { captureHostCommandJson } from "../application/host-command-json.ts";
import { openProtectedEventBody } from "./protected-event.ts";
import type { ProtectedValueRuntime } from "./protected-value.ts";
import type {
  ProtectedActionSource,
  ProtectedActionSourceEntry,
} from "./protected-action-types.ts";

export type ProtectedActionSourceBinding = Readonly<
  { eventId: string; operationId?: string }
>;
type SourceOperation = Readonly<{
  operation_id: string;
  root_event_id: string;
  parent_operation_id: string | null;
  parent_action_run_id: string | null;
  visibility: "public" | "internal";
}>;

/** Only owner-maintained parent and detached-delivery index edges are ancestry. */
async function readSourceAncestry(
  transaction: SqlExecutor,
  databaseSchema: string,
  namespace: string,
  operationId: string | undefined,
  allowUncatalogued = false,
): Promise<readonly SourceOperation[]> {
  const tables = createOperationCatalogTables(databaseSchema);
  if (!operationId) return [];
  const ancestors = (await transaction.query<
    SourceOperation & { next_id: string | null; valid_edge: boolean }
  >(
    `WITH RECURSIVE edges AS NOT MATERIALIZED (
      SELECT operation.operation_id,operation.root_event_id,operation.parent_operation_id,operation.parent_action_run_id,operation.visibility, CASE WHEN operation.parent_operation_id IS NOT NULL THEN operation.parent_operation_id
        WHEN operation.visibility='internal' THEN detached.id END AS next_id,
        (operation.parent_operation_id IS NOT NULL OR operation.visibility<>'internal' OR
          (detached.n=1 AND detached.id<>'' AND detached.id<>operation.operation_id)) AS valid_edge
      FROM ${tables.operations} AS operation
      LEFT JOIN LATERAL (
        SELECT count(*) AS n,min(indexed.operation_id) AS id FROM ${tables.operationEvents} AS indexed
        JOIN ${tables.events} AS event ON event.id=indexed.event_id AND event.namespace=indexed.namespace
        WHERE indexed.namespace=$1 AND indexed.event_id=operation.root_event_id
      ) AS detached ON operation.parent_operation_id IS NULL AND operation.visibility='internal'
      WHERE operation.namespace=$1
    ), chain AS (
      SELECT edges.*,1 AS depth FROM edges WHERE operation_id=$2
      UNION ALL
      SELECT edges.*,chain.depth+1 FROM chain JOIN edges ON edges.operation_id=chain.next_id WHERE chain.depth<65
    ) SELECT operation_id,root_event_id,parent_operation_id,parent_action_run_id,visibility,next_id,valid_edge
      FROM chain ORDER BY depth`,
    [namespace, operationId],
  )).rows;
  const visited = new Set<string>();
  for (const operation of ancestors) {
    if (visited.has(operation.operation_id) || visited.size >= 64) {
      throw new Error("Protected Action ancestry is invalid.");
    }
    visited.add(operation.operation_id);
    if (
      !operation.valid_edge ||
      Boolean(operation.parent_operation_id) !==
        Boolean(operation.parent_action_run_id)
    ) {
      throw new Error("Protected Action ancestry is unavailable.");
    }
  }
  if (!ancestors.length && allowUncatalogued) return [];
  if (!ancestors.length || ancestors.at(-1)!.next_id !== null) {
    throw new Error("Protected Action ancestry is unavailable.");
  }
  return ancestors;
}

/** Resolve invocation authority without opening protected application payloads. */
export async function resolveProtectedActionIngress(
  options: Readonly<{
    transaction: SqlExecutor;
    databaseSchema: string;
    namespace: string;
    source: ProtectedActionSourceBinding;
  }>,
): Promise<
  import("./protected-action-types.ts").ProtectedActionIngress | undefined
> {
  const { transaction, databaseSchema, namespace, source } = options;
  const chain = await readSourceAncestry(
    transaction,
    databaseSchema,
    namespace,
    source.operationId,
    // Raw retained Events may have delivery state without a catalog operation.
    // They stay unclassified; absence must never grant host authority.
    true,
  );
  const ids = chain.map((operation) => operation.root_event_id).reverse();
  if (!ids.includes(source.eventId)) ids.push(source.eventId);
  const rows = (await transaction.query<{
    id: string;
    owner_ingress:
      | import("./protected-action-types.ts").ProtectedActionIngress
      | null;
  }>(
    `SELECT id,owner_ingress FROM ${
      createCoreTableNames(databaseSchema).events
    } WHERE namespace=$1 AND id=ANY($2::text[])`,
    [namespace, ids],
  )).rows;
  const entries = ids.map((id) => {
    const row = rows.find((row) => row.id === id);
    if (!row) {
      throw new Error("Invocation source is unavailable in this scope.");
    }
    return row.owner_ingress;
  });
  return entries.find((entry) => entry?.authority) ?? entries[0] ?? undefined;
}

export async function resolveProtectedActionSource(
  options: Readonly<{
    transaction: SqlExecutor;
    databaseSchema: string;
    namespace: string;
    source: ProtectedActionSourceBinding;
    protectedValues?: ProtectedValueRuntime;
  }>,
): Promise<ProtectedActionSource> {
  const { transaction, databaseSchema, namespace, source } = options;
  const tables = createCoreTableNames(databaseSchema);
  const chain = await readSourceAncestry(
    transaction,
    databaseSchema,
    namespace,
    source.operationId,
  );
  const ids = chain.map((operation) => operation.root_event_id).reverse();
  if (!ids.includes(source.eventId)) ids.push(source.eventId);
  const rows = (await transaction.query<{
    id: string;
    type: string;
    namespace: string;
    metadata: Record<string, unknown>;
    payload: unknown;
    owner_ingress:
      | import("./protected-action-types.ts").ProtectedActionIngress
      | null;
    body: unknown;
    schema_version: number;
    digest: string;
  }>(
    `SELECT event.id,event.type,event.namespace,event.metadata,event.payload,event.owner_ingress,body.body,body.schema_version,body.digest
      FROM ${tables.events} AS event LEFT JOIN ${tables.event_bodies} AS body
      ON body.namespace=event.namespace AND body.event_body_id=trim(event.payload->'dataRef'->>'eventBodyId')
      WHERE event.namespace=$1 AND event.id=ANY($2::text[])`,
    [namespace, ids],
  )).rows;
  const ancestors: ProtectedActionSourceEntry[] = [];
  for (const id of ids) {
    const event = rows.find((row) => row.id === id);
    if (!event) {
      throw new Error("Protected Action source is unavailable in this scope.");
    }
    // Inline input is part of the same immutable retained Event. A dataRef must
    // still resolve and verify; a missing/corrupt referenced body never falls back.
    const body = event.payload && typeof event.payload === "object" &&
        Object.hasOwn(event.payload, "dataRef")
      ? await verifiedEventBody(event, eventDataRef(event.payload))
      : captureHostCommandJson(event.payload);
    const ingress = await resolveOwnerIngress(
      { transaction, tables },
      databaseSchema,
      { ...event, ownerIngress: event.owner_ingress ?? undefined },
      body,
    );
    const data = await openProtectedEventBody({
      namespace,
      body,
      protectedValues: options.protectedValues,
      transaction,
    });
    ancestors.push(captureHostCommandJson({
      event: {
        id: event.id,
        type: event.type,
        namespace,
        metadata: event.metadata,
      },
      data,
      ...(ingress ? { ingress } : {}),
    }) as ProtectedActionSourceEntry);
  }
  const root = ancestors[0];
  if (!root) throw new Error("Protected Action source is unavailable.");
  return Object.freeze({ ...root, ancestors: Object.freeze(ancestors) });
}

/** A resumed owner delivery keeps the first source, but must stay in its retained chain. */
export async function assertProtectedActionSourceReplay(
  options: Readonly<{
    transaction: SqlExecutor;
    databaseSchema: string;
    namespace: string;
    original: ProtectedActionSourceBinding;
    current?: ProtectedActionSourceBinding;
  }>,
): Promise<void> {
  const { transaction, databaseSchema, namespace, original, current } = options;
  if (!current || sameActionValue(original, current)) return;
  if (!original.operationId || !current.operationId) {
    throw new Error(
      "Protected Action source differs from its captured binding.",
    );
  }
  const tables = createCoreTableNames(databaseSchema);
  const chain = await readSourceAncestry(
    transaction,
    databaseSchema,
    namespace,
    current.operationId,
  );
  const originalRoot = chain.find((operation) =>
    operation.operation_id === original.operationId
  )?.root_event_id;
  const currentRoot = chain[0]?.root_event_id;
  if (!originalRoot || !currentRoot) {
    throw new Error(
      "Protected Action source differs from its captured binding.",
    );
  }
  // Event metadata cannot mint these edges. Both roots and delivery settlement
  // scopes are owner-maintained, including the replacement resumption delivery.
  for (
    const [source, root] of [[original, originalRoot], [
      current,
      currentRoot,
    ]] as const
  ) {
    const row = await transaction.query(
      `SELECT event.id FROM ${tables.events} AS event WHERE event.namespace=$1 AND event.id=$2 AND (event.id=$3 OR EXISTS (SELECT 1 FROM ${tables.event_deliveries} AS delivery WHERE delivery.event_id=event.id AND delivery.settlement_scope_id=$4))`,
      [namespace, source.eventId, root, source.operationId],
    );
    if (!row.rows.length) {
      throw new Error(
        "Protected Action source differs from its captured binding.",
      );
    }
  }
}
