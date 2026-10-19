import { awaitEventPublication } from "../events/coordinator.ts";
import { readActionEffectInventory } from "./effect-commands.ts";
import { createOperationCatalogTables } from "../streams/catalog.ts";
import type {
  EventCoordinator,
  EventDelivery,
  EventStore,
  SqlExecutor,
} from "../events/index.ts";
import { eventDataRef, readEventBody } from "../events/body-store.ts";
import type { OperationCatalog } from "../streams/catalog.ts";
import type { ActionEventData, AnyActionDefinition } from "./types.ts";
import type { ProtectedValueRuntime } from "./protected-value.ts";
import { publicActionLifecycleData } from "./protected-lifecycle.ts";
import { createActionLifecycleAppender } from "./persistence.ts";
import { createActionLifecycleEmitter } from "./lifecycle.ts";

type RecoveryOptions = Readonly<{
  store: EventStore;
  coordinator: EventCoordinator;
  catalog: OperationCatalog;
  actions: Readonly<Record<string, AnyActionDefinition>>;
  protectedValues?: ProtectedValueRuntime;
}>;
type ScopeCancellation = Readonly<
  { namespace: string; operationId: string; reason: string }
>;

/** Called inside delivery settlement; publication only happens after commit. */
export async function recoverDeliveryActions(
  options: RecoveryOptions,
  transaction: SqlExecutor,
  delivery: EventDelivery,
): Promise<() => Promise<void>> {
  return await recoverActions(options, transaction, delivery);
}

/** Explicit cancellation settles every live Action, including awaiting ones. */
export async function cancelScopeActions(
  options: RecoveryOptions,
  transaction: SqlExecutor,
  scope: ScopeCancellation,
): Promise<() => Promise<void>> {
  await options.catalog.requestCancellation(
    transaction,
    scope.namespace,
    scope.operationId,
    scope.reason,
  );
  const operations =
    createOperationCatalogTables(options.store.databaseSchema).operations;
  const children = await transaction.query<{ operation_id: string }>(
    `SELECT operation_id FROM ${operations} WHERE namespace = $1 AND parent_operation_id = $2
      AND state IN ('accepted','running') ORDER BY operation_id`,
    [scope.namespace, scope.operationId],
  );
  const flushes: (() => Promise<void>)[] = [];
  for (const child of children.rows) {
    await transaction.query(
      `UPDATE ${options.store.tables.event_deliveries} SET status = 'cancelled', lease_owner = NULL,
      lease_expires_at = NULL, settled_at = NOW(), updated_at = NOW()
      WHERE settlement_scope_id = $1 AND status IN ('pending','leased','retry_wait')`,
      [child.operation_id],
    );
    flushes.push(
      await cancelScopeActions(options, transaction, {
        ...scope,
        operationId: child.operation_id,
      }),
    );
  }
  flushes.push(await recoverActions(options, transaction, undefined, scope));
  return async () => {
    for (const flush of flushes) await flush();
  };
}

async function recoverActions(
  options: RecoveryOptions,
  transaction: SqlExecutor,
  delivery?: EventDelivery,
  scope?: ScopeCancellation,
): Promise<() => Promise<void>> {
  const { store, coordinator } = options;
  const open = await transaction.query<{
    namespace: string;
    action_run_id: string;
    scope_id: string;
    action_scope_id: string | null;
    invoked_event_id: string;
    metadata: Record<string, unknown>;
    payload: unknown;
    correlation_id: string;
    causation_id: string | null;
  }>(
    `SELECT action.namespace, action.action_run_id, action.scope_id, action.action_scope_id,
      action.invoked_event_id, event.metadata, event.payload, event.correlation_id, event.causation_id
    FROM ${store.tables.open_actions} AS action
    JOIN ${store.tables.events} AS event ON event.id = action.invoked_event_id
    WHERE ${
      scope
        ? "action.namespace = $1 AND action.scope_id = $2"
        : "action.owner_delivery_id = $1"
    }
    ORDER BY action.namespace, action.action_run_id`,
    scope ? [scope.namespace, scope.operationId] : [delivery!.id],
  );
  const committed: Awaited<ReturnType<typeof coordinator.commitMutation>>[] =
    [];
  for (const row of open.rows) {
    const raw = await readEventBody(
      { transaction, tables: store.tables },
      row.namespace,
      eventDataRef(row.payload),
    );
    const invoked = publicActionLifecycleData(raw) as ActionEventData;
    if (
      invoked.status !== "invoked" || invoked.actionRunId !== row.action_run_id
    ) {
      throw new Error(
        `Action obligation '${row.action_run_id}' has an invalid invoked receipt.`,
      );
    }
    const append = createActionLifecycleAppender({
      ...options,
      transaction,
      writer: scope
        ? {
          kind: "cancellation",
          namespace: scope.namespace,
          operationId: scope.operationId,
        }
        : { kind: "recovery", deliveryId: delivery!.id },
    });
    const lifecycle = createActionLifecycleEmitter({
      namespace: row.namespace,
      append: async (input) => {
        const result = await append(input);
        committed.push(result);
        return result;
      },
      metadata: {
        ...row.metadata,
        actionTerminalSource: scope
          ? "scope_cancellation"
          : "delivery_recovery",
        ...(delivery ? { sourceDeliveryId: delivery.id } : {}),
      },
    });
    const effects = await readActionEffectInventory(transaction, {
      schema: store.databaseSchema,
      namespace: row.namespace,
      actionRunId: row.action_run_id,
    });
    const indeterminate = effects.some((effect) => effect.status === "begun");
    const cancelled = Boolean(scope) || delivery?.status === "cancelled";
    const abandoned = delivery?.status === "succeeded";
    await lifecycle.emit({
      ...invoked,
      status: cancelled ? "cancelled" : "failed",
      error: {
        ...(indeterminate ? { code: "effect_indeterminate" } : {}),
        name: cancelled
          ? "AbortError"
          : indeterminate
          ? "ActionEffectError"
          : abandoned
          ? "ActionAbandoned"
          : "ActionDeliveryExhausted",
        message: cancelled
          ? "The owning delivery was cancelled."
          : indeterminate
          ? "An external effect has no confirmed outcome; the Action cannot be blindly replayed."
          : abandoned
          ? "The owning delivery finished without completing this Action."
          : "The owning delivery permanently failed before completing this Action.",
      },
      causationId: row.causation_id ?? undefined,
      correlationId: row.correlation_id,
      settlementScopeId: row.scope_id,
      actionScopeId: row.action_scope_id ?? undefined,
      deduplicationId: `${row.action_run_id}:action:terminal`,
    });
  }
  if (delivery && (delivery.status !== "succeeded" || open.rows.length)) {
    await options.catalog.failDeliveryStreams(transaction, {
      deliveryId: delivery.id,
      operationId: delivery.settlementScopeId,
      outcome: delivery.status === "cancelled" ? "cancelled" : "failed",
    });
  }
  return async () => {
    for (const result of committed) await awaitEventPublication(result);
  };
}
