import { sameActionValue } from "./value.ts";
import { resolveOwnerIngress } from "../application/ingress/authority.ts";
/** Fixed-source retained provenance. Caller metadata is never an ancestry edge. */
import { createOperationCatalogTables } from "../streams/catalog.ts";
import { createCoreTableNames } from "../events/schema.ts";
import { eventDataRef, readEventBody } from "../events/body-store.ts";
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
  const operations = createOperationCatalogTables(databaseSchema).operations;
  const read = async (id: string): Promise<ProtectedActionSourceEntry> => {
    const event = (await transaction.query<
      {
        id: string;
        type: string;
        namespace: string;
        metadata: Record<string, unknown>;
        payload: unknown;
      }
    >(
      `SELECT id,type,namespace,metadata,payload FROM ${tables.events} WHERE id=$1 AND namespace=$2`,
      [id, namespace],
    )).rows[0];
    if (!event) {
      throw new Error("Protected Action source is unavailable in this scope.");
    }
    const body = await readEventBody(
      { transaction, tables },
      namespace,
      eventDataRef(event.payload),
    );
    const ingress = await resolveOwnerIngress(
      { transaction, tables },
      databaseSchema,
      event,
      body,
    );
    const data = await openProtectedEventBody({
      namespace,
      body,
      protectedValues: options.protectedValues,
      transaction,
    });
    return captureHostCommandJson({
      event: {
        id: event.id,
        type: event.type,
        namespace,
        metadata: event.metadata,
      },
      data,
      ...(ingress ? { ingress } : {}),
    }) as ProtectedActionSourceEntry;
  };
  const ids: string[] = [];
  let operationId = source.operationId;
  const visited = new Set<string>();
  while (operationId) {
    if (visited.has(operationId) || visited.size >= 64) {
      throw new Error("Protected Action ancestry is invalid.");
    }
    visited.add(operationId);
    const operation:
      | (Record<string, unknown> & {
        root_event_id: string;
        parent_operation_id: string | null;
        parent_action_run_id: string | null;
      })
      | undefined = (await transaction.query<
        {
          root_event_id: string;
          parent_operation_id: string | null;
          parent_action_run_id: string | null;
        }
      >(
        `SELECT root_event_id,parent_operation_id,parent_action_run_id FROM ${operations} WHERE namespace=$1 AND operation_id=$2`,
        [namespace, operationId],
      )).rows[0];
    if (
      !operation ||
      (!!operation.parent_operation_id !== !!operation.parent_action_run_id)
    ) throw new Error("Protected Action ancestry is unavailable.");
    ids.unshift(operation.root_event_id);
    operationId = operation.parent_operation_id ?? undefined;
  }
  if (!ids.includes(source.eventId)) ids.push(source.eventId);
  const ancestors: ProtectedActionSourceEntry[] = [];
  for (const id of ids) ancestors.push(await read(id));
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
  const operations = createOperationCatalogTables(databaseSchema).operations;
  const seen = new Set<string>();
  let operationId: string | undefined = current.operationId;
  let originalRoot: string | undefined;
  let currentRoot: string | undefined;
  while (operationId) {
    if (seen.has(operationId) || seen.size >= 64) {
      throw new Error("Protected Action ancestry is invalid.");
    }
    seen.add(operationId);
    const edge: {
      root_event_id: string;
      parent_operation_id: string | null;
      parent_action_run_id: string | null;
    } | undefined = (await transaction.query<{
      root_event_id: string;
      parent_operation_id: string | null;
      parent_action_run_id: string | null;
    }>(
      `SELECT root_event_id,parent_operation_id,parent_action_run_id FROM ${operations} WHERE namespace=$1 AND operation_id=$2`,
      [namespace, operationId],
    )).rows[0];
    if (
      !edge ||
      Boolean(edge.parent_operation_id) !== Boolean(edge.parent_action_run_id)
    ) {
      throw new Error("Protected Action ancestry is unavailable.");
    }
    if (operationId === current.operationId) currentRoot = edge.root_event_id;
    if (operationId === original.operationId) originalRoot = edge.root_event_id;
    operationId = edge.parent_operation_id ?? undefined;
  }
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
