import type {
  EventCoordinator,
  EventStore,
  SqlExecutor,
} from "../events/index.ts";
import type { OperationCatalog } from "../streams/catalog.ts";
import { advanceDeferredActions } from "./deferred-work.ts";
import { ActionOwnershipLost } from "./ownership.ts";

type WaitRuntime = Readonly<{
  store: EventStore;
  coordinator: EventCoordinator;
  catalog: OperationCatalog;
}>;

export type DeferredWaitOptions = Readonly<{
  namespace: string;
  actionRunId: string;
  operationId: string;
  deliveryId: string;
  leaseOwner: string;
  waitKey: string;
  timeoutMs?: number;
}>;

function requiredText(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new TypeError(`${label} must be non-empty.`);
  return normalized;
}

function waitTimeout(value: number | undefined): number | null {
  if (value === undefined) return null;
  if (!Number.isSafeInteger(value) || value < 1 || value > 86_400_000) {
    throw new TypeError(
      "Deferred wait timeout must be between 1 ms and 24 hours.",
    );
  }
  return value;
}

/** Attach a durable wake condition to the Action currently owned by a delivery. */
export async function registerDeferredWait(
  runtime: WaitRuntime,
  input: DeferredWaitOptions,
): Promise<void> {
  const namespace = requiredText(input.namespace, "Namespace");
  const actionRunId = requiredText(input.actionRunId, "Action run id");
  const operationId = requiredText(input.operationId, "Operation id");
  const deliveryId = requiredText(input.deliveryId, "Delivery id");
  const leaseOwner = requiredText(input.leaseOwner, "Delivery lease owner");
  const waitKey = requiredText(input.waitKey, "Deferred wait key");
  const timeoutMs = waitTimeout(input.timeoutMs);
  await runtime.store.session.transaction(async (transaction) => {
    await runtime.catalog.lockScope(transaction, operationId);
    const lease = await transaction.query(
      `SELECT id FROM ${runtime.store.tables.event_deliveries}
       WHERE id = $1 AND status = 'leased' AND lease_owner = $2
         AND lease_expires_at > NOW() FOR UPDATE`,
      [deliveryId, leaseOwner],
    );
    if (!lease.rows.length) throw new ActionOwnershipLost(actionRunId);
    const action = await transaction.query<{ scope_id: string }>(
      `SELECT scope_id FROM ${runtime.store.tables.open_actions}
       WHERE namespace = $1 AND action_run_id = $2 AND scope_id = $3
         AND state IN ('invoked','resolving') AND owner_delivery_id = $4 FOR UPDATE`,
      [namespace, actionRunId, operationId, deliveryId],
    );
    const row = action.rows[0];
    if (!row) throw new ActionOwnershipLost(actionRunId);
    const changed = await transaction.query(
      `UPDATE ${runtime.store.tables.open_actions} AS action
       SET wait_signaled = FALSE,
           wait_key = $3,
           wait_expires_at = CASE WHEN $4::bigint IS NULL THEN NULL
             ELSE NOW() + ($4::bigint * INTERVAL '1 millisecond') END
       WHERE action.namespace = $1 AND action.action_run_id = $2 AND action.scope_id = $5
         AND action.state IN ('invoked','resolving') AND action.owner_delivery_id = $6
       RETURNING action_run_id`,
      [namespace, actionRunId, waitKey, timeoutMs, row.scope_id, deliveryId],
    );
    if (!changed.rows.length) throw new ActionOwnershipLost(actionRunId);
  });
}

/** Re-arm the same receipt after a bounded wake; generation fences stale resolvers. */
export async function rearmDeferredAction(
  runtime: WaitRuntime,
  input: Omit<DeferredWaitOptions, "waitKey" | "timeoutMs">,
): Promise<void> {
  const namespace = requiredText(input.namespace, "Namespace");
  const actionRunId = requiredText(input.actionRunId, "Action run id");
  const operationId = requiredText(input.operationId, "Operation id");
  const deliveryId = requiredText(input.deliveryId, "Delivery id");
  const leaseOwner = requiredText(input.leaseOwner, "Delivery lease owner");
  await runtime.store.session.transaction(async (transaction) => {
    await runtime.catalog.lockScope(transaction, operationId);
    const lease = await transaction.query(
      `SELECT id FROM ${runtime.store.tables.event_deliveries}
       WHERE id = $1 AND status = 'leased' AND lease_owner = $2
         AND lease_expires_at > NOW() FOR UPDATE`,
      [deliveryId, leaseOwner],
    );
    if (!lease.rows.length) throw new ActionOwnershipLost(actionRunId);
    const action = await transaction.query<{ scope_id: string }>(
      `SELECT scope_id FROM ${runtime.store.tables.open_actions}
       WHERE namespace = $1 AND action_run_id = $2 AND scope_id = $3
         AND state = 'resolving' AND owner_delivery_id = $4
         AND wait_key IS NOT NULL
       FOR UPDATE`,
      [namespace, actionRunId, operationId, deliveryId],
    );
    const row = action.rows[0];
    if (!row) throw new ActionOwnershipLost(actionRunId);
    const changed = await transaction.query(
      `UPDATE ${runtime.store.tables.open_actions}
       SET state = 'deferred', owner_delivery_id = NULL,
           resolve_generation = resolve_generation + 1
       WHERE namespace = $1 AND action_run_id = $2 AND scope_id = $3
         AND state = 'resolving' AND owner_delivery_id = $4
         AND wait_key IS NOT NULL
       RETURNING action_run_id`,
      [namespace, actionRunId, operationId, deliveryId],
    );
    if (!changed.rows.length) throw new ActionOwnershipLost(actionRunId);
  });
}

/** Signal every exact-key waiter, then hand ready deferred receipts to resolvers. */
export async function signalDeferredWait(
  runtime: WaitRuntime,
  namespaceInput: string,
  waitKeyInput: string,
): Promise<number> {
  const namespace = requiredText(namespaceInput, "Namespace");
  const waitKey = requiredText(waitKeyInput, "Deferred wait key");
  const selected = await runtime.store.session.query<{ scope_id: string }>(
    `SELECT DISTINCT scope_id FROM ${runtime.store.tables.open_actions}
     WHERE namespace = $1 AND wait_key = $2 AND state IN ('invoked','deferred','resolving')`,
    [namespace, waitKey],
  );
  let signaled = 0;
  const scopes = [...new Set(selected.rows.map((row) => row.scope_id))];
  for (const scopeId of scopes) {
    await runtime.store.session.transaction(
      async (transaction: SqlExecutor) => {
        await runtime.catalog.lockScope(transaction, scopeId);
        const changed = await transaction.query(
          `UPDATE ${runtime.store.tables.open_actions} SET wait_signaled = TRUE
         WHERE namespace = $1 AND scope_id = $2 AND wait_key = $3
           AND state IN ('invoked','deferred','resolving') AND NOT wait_signaled
         RETURNING action_run_id`,
          [namespace, scopeId, waitKey],
        );
        signaled += changed.rows.length;
      },
    );
    const flush = await advanceDeferredActions(runtime, {
      namespace,
      operationId: scopeId,
    });
    await flush();
  }
  return signaled;
}
