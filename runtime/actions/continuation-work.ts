import { createSchemaCommandRunner } from "../engine/commands.ts";
import type { OperationStart } from "./continuation.ts";
import {
  prepareProtectedEventBody,
  samePreparedProtectedEventBody,
} from "./protected-event.ts";
import { actionInputHasSecrets } from "./protected-lifecycle.ts";
import type { AnyActionDefinition } from "./types.ts";
import type { ProtectedValueRuntime } from "./protected-value.ts";
import type {
  EventCoordinator,
  EventStore,
  SqlExecutor,
} from "../events/index.ts";
import {
  createOperationCatalogTables,
  publishOperationChange,
} from "../streams/catalog.ts";
import type { OperationCatalog } from "../streams/catalog.ts";
import type { ActionLifecycleAppendInput } from "./types.ts";
import { ActionOwnershipLost } from "./ownership.ts";
import type { ActionWriter } from "./ownership.ts";
import { eventDataRef, readEventBody } from "../events/body-store.ts";

export const ACTION_CONTINUATION_CONSUMER = "runtime:action-continuation";
export const ACTION_CHILD_EVENT = "copilotz.action.start";
export const ACTION_RESUME_EVENT = "copilotz.action.resume";
type Runtime = Readonly<
  {
    store: EventStore;
    coordinator: EventCoordinator;
    catalog?: OperationCatalog;
    actions?: Readonly<Record<string, AnyActionDefinition>>;
    protectedValues?: ProtectedValueRuntime;
  }
>;

export async function prepareActionOperation(
  runtime: Runtime,
  namespace: string,
  operationId: string,
  start: OperationStart,
) {
  const child = runtime.actions?.[start.action];
  if (runtime.actions && !child) {
    throw new TypeError(`Unknown Action '${start.action}'.`);
  }
  return await prepareProtectedEventBody({
    namespace,
    ownerId: `${operationId}:start`,
    data: {
      action: start.action,
      input: start.input,
      metadata: start.metadata ?? {},
    },
    schema: child && actionInputHasSecrets(child)
      ? { "x-copilotz-secret": true }
      : {},
    protectedValues: runtime.protectedValues,
  });
}

/** One admission path for standalone producers and linked children. */
export async function admitActionOperation(
  runtime: Runtime,
  tx: SqlExecutor,
  input: Readonly<
    {
      namespace: string;
      operationId: string;
      start: OperationStart;
      correlationId?: string;
      causationId?: string;
      metadata: Readonly<Record<string, unknown>>;
    }
  >,
  prepared: Awaited<ReturnType<typeof prepareActionOperation>>,
): Promise<Awaited<ReturnType<EventStore["commitMutation"]>> | undefined> {
  const { store } = runtime;
  const { namespace, operationId } = input;
  const existing = await tx.query<{ payload: unknown }>(
    `SELECT event.payload FROM ${
      createOperationCatalogTables(store.databaseSchema).operations
    } AS operation
     JOIN ${store.tables.events} AS event ON event.id = operation.root_event_id
     WHERE operation.namespace = $1 AND operation.operation_id = $2`,
    [namespace, operationId],
  );
  if (existing.rows[0]) {
    const body = await readEventBody(
      { transaction: tx, tables: store.tables },
      namespace,
      eventDataRef(existing.rows[0].payload),
    );
    if (!samePreparedProtectedEventBody(body, prepared.body)) {
      throw new TypeError("Operation identity has a different invocation.");
    }
    return;
  }
  const bodyId = `event-body:${namespace}:${operationId}:start`;
  return await store.commitMutation({
    eventId: operationId,
    draft: {
      namespace,
      type: ACTION_CHILD_EVENT,
      correlationId: input.correlationId,
      causationId: input.causationId,
      settlementScopeId: operationId,
      deduplicationId: `${operationId}:start`,
      metadata: input.metadata,
      payload: {
        dataRef: {
          eventBodyId: bodyId,
          schemaVersion: 1,
          mediaType: "application/json",
        },
      },
    },
    body: { id: bodyId, json: prepared.body },
    mutate: async (context) => {
      for (const value of prepared.prepared) {
        await runtime.protectedValues!.adopt(context, namespace, value);
      }
    },
    consumers: [{
      consumerId: ACTION_CONTINUATION_CONSUMER,
      settlement: "inherit",
    }],
    transaction: tx,
  });
}

/** Registers the wait and optional linked child with the awaiting receipt. */
export async function startAwaitedOperation(
  runtime: Runtime,
  tx: SqlExecutor,
  input: ActionLifecycleAppendInput,
  writer: ActionWriter | undefined,
  preparedChild: Awaited<ReturnType<typeof prepareActionOperation>> | undefined,
): Promise<() => Promise<void>> {
  const { store, coordinator } = runtime;
  const { draft, data } = input;
  if (
    data.status !== "awaiting" || writer?.kind !== "delivery" ||
    !draft.settlementScopeId
  ) {
    throw new TypeError(
      "Awaiting an operation requires a durable Action delivery.",
    );
  }
  const operations =
    createOperationCatalogTables(store.databaseSchema).operations;
  const namespace = draft.namespace;
  const parentId = draft.settlementScopeId;
  const childId = data.operationId ?? data.start?.operationId ??
    `${data.actionRunId}:child`;
  // Follow both ownership and wait edges. A target that transitively waits
  // for this operation is reachable in this reverse graph, as is any ancestor.
  const ancestors = await tx.query<{ operation_id: string }>(
    `WITH RECURSIVE links AS (
      SELECT operation_id AS child, parent_operation_id AS parent
      FROM ${operations} WHERE namespace = $1
      UNION
      SELECT child_operation_id, scope_id FROM ${store.tables.open_actions}
      WHERE namespace = $1 AND child_operation_id IS NOT NULL
    ), ancestors(id) AS (
      SELECT $2::text UNION SELECT links.parent FROM links JOIN ancestors ON links.child = ancestors.id
      WHERE links.parent IS NOT NULL
    ) SELECT id AS operation_id FROM ancestors`,
    [namespace, parentId],
  );
  if (
    childId === parentId ||
    ancestors.rows.some((row) => row.operation_id === childId)
  ) {
    throw new TypeError(
      "An Action cannot await its own operation, an ancestor, or create a wait cycle.",
    );
  }
  const parent = await tx.query<
    { metadata: Record<string, unknown>; observation_keys: string[] }
  >(
    `SELECT operation.metadata,
      ARRAY(SELECT DISTINCT key FROM unnest(operation.observation_keys ||
        ARRAY(SELECT jsonb_array_elements_text(COALESCE(event.metadata -> 'observationKeys', '[]'::jsonb)))) AS key ORDER BY key) AS observation_keys
      FROM ${operations} AS operation JOIN ${store.tables.events} AS event ON event.id = operation.root_event_id
      WHERE operation.namespace = $1 AND operation.operation_id = $2
      AND operation.state IN ('accepted','running') AND operation.cancellation_requested_at IS NULL`,
    [namespace, parentId],
  );
  if (!parent.rows[0]) throw new ActionOwnershipLost(data.actionRunId);
  const authority = await tx.query(
    `SELECT action.action_run_id FROM ${store.tables.open_actions} AS action
     JOIN ${store.tables.event_deliveries} AS delivery ON delivery.id = $3
     WHERE action.namespace = $1 AND action.action_run_id = $2 AND action.state = 'awaiting'
       AND delivery.status = 'leased' AND delivery.lease_owner = $4 AND (delivery.lease_expires_at IS NULL OR delivery.lease_expires_at > NOW()) AND delivery.owner_epoch=(SELECT epoch FROM ${store.tables.owner_epochs} WHERE owner='schema')
    `,
    [namespace, data.actionRunId, writer.deliveryId, writer.leaseOwner],
  );
  if (!authority.rows.length) throw new ActionOwnershipLost(data.actionRunId);
  let committed: Awaited<ReturnType<typeof store.commitMutation>> | undefined;
  const existing = await tx.query<
    {
      payload: unknown;
      parent_operation_id: string | null;
      parent_action_run_id: string | null;
    }
  >(
    `SELECT event.payload, operation.parent_operation_id, operation.parent_action_run_id
     FROM ${operations} AS operation JOIN ${store.tables.events} AS event ON event.id = operation.root_event_id
     WHERE operation.namespace = $1 AND operation.operation_id = $2`,
    [namespace, childId],
  );
  if (!data.start) {
    if (!existing.rows.length) {
      throw new TypeError(`Unknown awaited operation '${childId}'.`);
    }
  } else {
    const owned = existing.rows[0];
    if (
      owned &&
      (owned.parent_operation_id !== parentId ||
        owned.parent_action_run_id !== data.actionRunId)
    ) {
      throw new TypeError(
        "A linked child cannot be shared between Action awaits.",
      );
    }
    if (!preparedChild) {
      throw new Error("Linked child input must be prepared before admission.");
    }
    committed = await admitActionOperation(runtime, tx, {
      namespace,
      operationId: childId,
      start: data.start,
      correlationId: draft.correlationId,
      causationId: draft.causationId,
      metadata: {
        ...parent.rows[0].metadata,
        observationKeys: parent.rows[0].observation_keys,
        parent: { operationId: parentId, actionRunId: data.actionRunId },
      },
    }, preparedChild);
    const catalogTables = createOperationCatalogTables(store.databaseSchema);
    await tx.query(
      `WITH linked AS (
    UPDATE ${operations} SET parent_operation_id = COALESCE(parent_operation_id, $3),
      parent_action_run_id = COALESCE(parent_action_run_id, $4),
      observation_keys = ARRAY(SELECT DISTINCT key FROM unnest(observation_keys || $5::text[]) AS key ORDER BY key),
      visibility = 'public'
    WHERE namespace = $1 AND operation_id = $2 RETURNING observation_keys
  ), heads AS (
    INSERT INTO ${catalogTables.selectionHeads} AS head (namespace, selection_key, change_ordinal)
    SELECT $1, key, 1 FROM linked, LATERAL unnest(observation_keys) AS key ORDER BY key
    ON CONFLICT (namespace, selection_key) DO UPDATE SET change_ordinal = head.change_ordinal + 1
    RETURNING namespace, selection_key, change_ordinal
  ) INSERT INTO ${catalogTables.selectionOperations} (namespace, selection_key, operation_id, change_ordinal)
    SELECT namespace, selection_key, $2, change_ordinal FROM heads
    ON CONFLICT (namespace, selection_key, operation_id) DO UPDATE SET change_ordinal = EXCLUDED.change_ordinal`,
      [
        namespace,
        childId,
        parentId,
        data.actionRunId,
        parent.rows[0].observation_keys,
      ],
    );
  }
  await tx.query(
    `UPDATE ${store.tables.open_actions} SET child_operation_id = $3 WHERE namespace = $1 AND action_run_id = $2`,
    [namespace, data.actionRunId, childId],
  );
  const resume = await scheduleResumptions(runtime, {
    namespace,
    operationId: childId,
  }, tx);
  await publishOperationChange(
    store.session,
    tx,
    store.databaseSchema,
    namespace,
    childId,
  );
  return async () => {
    if (committed) await coordinator.flushCommitted(committed);
    await resume();
  };
}

/** Settlement and its one logical resumption are committed together. */
export async function scheduleResumptions(
  runtime: Runtime,
  input: Readonly<
    { namespace?: string; operationId?: string; limit?: number }
  > = {},
  transaction?: SqlExecutor,
): Promise<() => Promise<void>> {
  const { store, coordinator } = runtime;
  const operations =
    createOperationCatalogTables(store.databaseSchema).operations;
  const committed: Awaited<ReturnType<typeof store.commitMutation>>[] = [];
  const run = async (tx: SqlExecutor) => {
    const waiters = await tx.query<{
      namespace: string;
      scope_id: string;
      action_run_id: string;
      action_id: string;
      await_event_id: string;
      child_operation_id: string;
      state: "completed" | "failed" | "cancelled";
      error: { name?: string; message?: string } | null;
      correlation_id: string;
      metadata: Record<string, unknown>;
    }>(
      `SELECT action.*, child.state, event.correlation_id, event.metadata,
        (SELECT jsonb_build_object('name', delivery.last_error ->> 'name', 'message', delivery.last_error ->> 'message')
         FROM ${store.tables.event_deliveries} AS delivery
         WHERE delivery.settlement_scope_id = child.operation_id AND delivery.status = 'dead_letter'
         ORDER BY delivery.settled_at, delivery.id LIMIT 1) AS error
      FROM ${store.tables.open_actions} AS action
      JOIN ${operations} AS child ON child.namespace = action.namespace AND child.operation_id = action.child_operation_id
      JOIN ${store.tables.events} AS event ON event.id = action.await_event_id
      WHERE action.state = 'awaiting' AND action.owner_delivery_id IS NULL AND child.state IN ('completed','failed','cancelled')
        AND ($1::text IS NULL OR action.namespace = $1) AND ($2::text IS NULL OR child.operation_id = $2)
      ORDER BY action.namespace, action.action_run_id LIMIT $3`,
      [
        input.namespace ?? null,
        input.operationId ?? null,
        input.limit ?? (input.operationId ? null : 100),
      ],
    );
    for (const row of waiters.rows) {
      const key = `${row.action_run_id}:resume`;
      const bodyId = `event-body:${row.namespace}:${key}`;
      const result = await store.commitMutation({
        draft: {
          namespace: row.namespace,
          type: ACTION_RESUME_EVENT,
          subject: { type: row.action_id, id: row.action_run_id },
          causationId: row.await_event_id,
          correlationId: row.correlation_id,
          settlementScopeId: row.scope_id,
          deduplicationId: key,
          metadata: row.metadata,
          payload: {
            dataRef: {
              eventBodyId: bodyId,
              schemaVersion: 1,
              mediaType: "application/json",
            },
          },
        },
        body: {
          id: bodyId,
          json: {
            actionRunId: row.action_run_id,
            actionId: row.action_id,
            outcome: {
              operationId: row.child_operation_id,
              status: row.state,
              ...(row.error ? { error: row.error } : {}),
            },
          },
        },
        consumers: [{
          consumerId: ACTION_CONTINUATION_CONSUMER,
          settlement: "inherit",
        }],
        transaction: tx,
      });
      const delivery = result.deliveries.find((d) =>
        d.consumerId === ACTION_CONTINUATION_CONSUMER
      )!;
      await tx.query(
        `UPDATE ${store.tables.open_actions} SET owner_delivery_id = $3 WHERE namespace = $1 AND action_run_id = $2`,
        [row.namespace, row.action_run_id, delivery.id],
      );
      committed.push(result);
    }
  };
  if (transaction) await run(transaction);
  else {await createSchemaCommandRunner(store.session, store.databaseSchema)(
      "actions.resume",
      input,
      (_input, { transaction }) => run(transaction),
    );}
  return async () => {
    for (const result of committed) await coordinator.flushCommitted(result);
  };
}
