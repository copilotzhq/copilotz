import type {
  EventCoordinator,
  EventStore,
  SqlExecutor,
} from "../events/index.ts";
import type { OperationCatalog } from "../streams/catalog.ts";
import { createOperationCatalogTables } from "../streams/catalog.ts";
import type { ActionWorkOutcome } from "./deferral.ts";

export const ACTION_RESOLVER_CONSUMER = "runtime:action-resolver";
export const ACTION_RESOLVER_EVENT = "copilotz.action.resolve";
export type ActionResolutionRequest = Readonly<{
  actionRunId: string;
  actionId: string;
  outcome: ActionWorkOutcome;
  error?: Readonly<{ name: string; message: string }>;
}>;

type DeferredWorkOptions = Readonly<{
  store: EventStore;
  coordinator: EventCoordinator;
  catalog: OperationCatalog;
}>;

/**
 * A deferred receipt owns its descendant work. When that work drains, transfer
 * ownership to exactly one resolver delivery in the same transaction. No timer,
 * history scan, or plugin-owned completion registry participates in settlement.
 * A failed/cancelled stream's outcome is final before its retained prefix is
 * physically frozen. It cannot delay the resolver; the operation still waits
 * for that transport cleanup before publishing its own terminal state.
 */
export async function advanceDeferredActions(
  options: DeferredWorkOptions,
  input: Readonly<
    { namespace?: string; operationId?: string; limit?: number }
  > = {},
  transaction?: SqlExecutor,
): Promise<() => Promise<void>> {
  const { store, coordinator, catalog } = options;
  const tables = store.tables;
  const streams =
    createOperationCatalogTables(store.databaseSchema).operationStreams;
  const ready = `NOT EXISTS (
    SELECT 1 FROM ${tables.event_deliveries} AS delivery
    WHERE delivery.settlement_scope_id = action.scope_id
      AND delivery.action_scope_id = action.action_run_id
      AND delivery.status IN ('pending','leased','retry_wait')
  ) AND NOT EXISTS (
    SELECT 1 FROM ${tables.open_actions} AS child
    WHERE child.namespace = action.namespace AND child.action_scope_id = action.action_run_id
  ) AND NOT EXISTS (
    SELECT 1 FROM ${streams} AS stream
    WHERE stream.namespace = action.namespace AND stream.operation_id = action.scope_id
      AND stream.descriptor -> 'metadata' ->> 'sourceActionScopeId' = action.action_run_id
      AND (stream.state = 'open' OR (stream.state = 'terminating' AND stream.outcome = 'completed'))
  )`;
  const committed: Awaited<ReturnType<typeof store.commitMutation>>[] = [];
  const executor = transaction ?? store.session;
  const candidates = await executor.query<
    { namespace: string; scope_id: string; action_run_id: string }
  >(
    `SELECT namespace, scope_id, action_run_id FROM ${tables.open_actions} AS action
     WHERE state = 'deferred'
       AND ($1::text IS NULL OR namespace = $1)
       AND ($2::text IS NULL OR scope_id = $2)
       AND ${ready}
     ORDER BY namespace, scope_id, action_run_id LIMIT $3`,
    [input.namespace ?? null, input.operationId ?? null, input.limit ?? 100],
  );
  for (const candidate of candidates.rows) {
    const advance = async (tx: SqlExecutor) => {
      await catalog.lockScope(tx, candidate.scope_id);
      // Keep ownership stable before taking the fresh readiness snapshot.
      await tx.query(
        `SELECT action_run_id FROM ${tables.open_actions}
         WHERE namespace = $1 AND action_run_id = $2 FOR UPDATE`,
        [candidate.namespace, candidate.action_run_id],
      );
      // New statement after the admission lock: every prior admission is visible.
      const rows = await tx.query<{
        action_run_id: string;
        action_id: string;
        action_scope_id: string | null;
        deferred_event_id: string;
        correlation_id: string;
        metadata: Record<string, unknown>;
        outcome: ActionWorkOutcome;
        error: { name?: string; message?: string } | null;
      }>(
        `SELECT action.action_run_id, action.action_id, action.action_scope_id,
           action.deferred_event_id, event.correlation_id, event.metadata,
           (SELECT jsonb_build_object('name', delivery.last_error ->> 'name', 'message', delivery.last_error ->> 'message')
            FROM ${tables.event_deliveries} AS delivery
            WHERE delivery.settlement_scope_id = action.scope_id AND delivery.action_scope_id = action.action_run_id
              AND delivery.status = 'dead_letter' ORDER BY delivery.settled_at, delivery.id LIMIT 1) AS error,
           CASE WHEN EXISTS (
             SELECT 1 FROM ${tables.event_deliveries} AS delivery
             WHERE delivery.settlement_scope_id = action.scope_id
               AND delivery.action_scope_id = action.action_run_id
               AND delivery.status = 'dead_letter'
           ) OR EXISTS (
             SELECT 1 FROM ${streams} AS stream
             WHERE stream.namespace = action.namespace AND stream.operation_id = action.scope_id
               AND stream.descriptor -> 'metadata' ->> 'sourceActionScopeId' = action.action_run_id
               AND stream.outcome IN ('failed','abandoned')
           ) THEN 'failed' WHEN EXISTS (
             SELECT 1 FROM ${tables.event_deliveries} AS delivery
             WHERE delivery.settlement_scope_id = action.scope_id
               AND delivery.action_scope_id = action.action_run_id AND delivery.status = 'cancelled'
           ) OR EXISTS (
             SELECT 1 FROM ${streams} AS stream
             WHERE stream.namespace = action.namespace AND stream.operation_id = action.scope_id
               AND stream.descriptor -> 'metadata' ->> 'sourceActionScopeId' = action.action_run_id
               AND stream.outcome = 'cancelled'
           ) THEN 'cancelled' ELSE 'completed' END AS outcome
         FROM ${tables.open_actions} AS action
         JOIN ${tables.events} AS event ON event.id = action.deferred_event_id
         WHERE action.namespace = $1 AND action.action_run_id = $2 AND action.state = 'deferred'
           AND ${ready}`,
        [candidate.namespace, candidate.action_run_id],
      );
      const row = rows.rows[0];
      if (!row) return;
      const request: ActionResolutionRequest = {
        actionId: row.action_id,
        actionRunId: row.action_run_id,
        outcome: row.outcome,
        ...(row.error
          ? {
            error: {
              name: row.error.name || "ActionWorkFailed",
              message: row.error.message || "Deferred work permanently failed.",
            },
          }
          : {}),
      };
      const deduplicationId = `${row.action_run_id}:action:resolve`;
      const bodyId = `event-body:${candidate.namespace}:${deduplicationId}`;
      const { actionId: _actionId, actionStatus: _actionStatus, ...metadata } =
        row.metadata;
      const result = await store.commitMutation({
        draft: {
          namespace: candidate.namespace,
          type: ACTION_RESOLVER_EVENT,
          subject: { type: row.action_id, id: row.action_run_id },
          causationId: row.deferred_event_id,
          correlationId: row.correlation_id,
          settlementScopeId: candidate.scope_id,
          actionScopeId: row.action_scope_id ?? undefined,
          deduplicationId,
          metadata: { ...metadata, actionResolver: true },
          payload: {
            dataRef: {
              eventBodyId: bodyId,
              schemaVersion: 1,
              mediaType: "application/json",
            },
          },
        },
        body: { id: bodyId, json: request },
        consumers: [{
          consumerId: ACTION_RESOLVER_CONSUMER,
          settlement: "inherit",
        }],
        transaction: tx,
      });
      const delivery = result.deliveries.find((value) =>
        value.consumerId === ACTION_RESOLVER_CONSUMER
      );
      if (!delivery) {
        throw new Error("Action resolver handoff has no delivery.");
      }
      await tx.query(
        `UPDATE ${tables.open_actions} SET state = 'resolving', owner_delivery_id = $3
         WHERE namespace = $1 AND action_run_id = $2 AND state = 'deferred'`,
        [candidate.namespace, row.action_run_id, delivery.id],
      );
      committed.push(result);
    };
    if (transaction) await advance(transaction);
    else await store.session.transaction(advance);
  }
  return async () => {
    for (const result of committed) await coordinator.flushCommitted(result);
  };
}
