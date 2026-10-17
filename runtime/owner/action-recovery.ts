/** Private owner-only exhausted-delivery recovery. No new execution entitlement
 * or provider query is created; failures retain the logical effect evidence. */
import { recoverDeliveryActions } from "../actions/recovery.ts";
import {
  createEventCoordinator,
  type EventPublisher,
} from "../events/coordinator.ts";
import type { SqlExecutor, SqlSession } from "../events/session.ts";
import { createEventStore, type EventStore } from "../events/store.ts";
import type { DeliveryExecutor } from "../execution/types.ts";
import type { PluginRegistry } from "../plugins/registry.ts";
import {
  createOperationCatalogTables,
  type OperationCatalog,
  type OperationSettlementScope,
} from "../streams/catalog.ts";
import type {
  OwnerCaller,
  OwnerCommand,
  OwnerCommandContext,
  OwnerCommandHandler,
} from "./boundary.ts";
import { readOwnerEffectInventory } from "./effects.ts";

export const OWNER_ACTION_RECOVERY = "action.recoverExpired";
export function ownerActionRecoveryKey(
  ownerId: string,
  namespace: string,
  occurrence: string,
): string {
  return JSON.stringify([
    OWNER_ACTION_RECOVERY,
    ownerId,
    namespace,
    occurrence,
  ]);
}
function text(value: unknown): asserts value is string {
  if (typeof value !== "string" || !value.trim() || value.length > 1024) {
    throw new TypeError("Invalid Action recovery identity.");
  }
}
function refuse(): never {
  throw Object.assign(new Error("Current owner recovery authority refused."), {
    code: "ActionOwnershipLost",
  });
}
export function createOwnerActionRecovery(
  options: Readonly<{
    ownerId: string;
    schema: string;
    session: SqlSession;
    registry: PluginRegistry;
    catalog: OperationCatalog;
    executor: DeliveryExecutor;
    publish?: EventPublisher;
    maxBatch?: number;
    /** SQL-only host control policy; worker ctx/settlement grants are insufficient. */
    authorizeControl(
      tx: SqlExecutor,
      caller: OwnerCaller,
      namespace: string,
      commandTime: string,
    ): boolean | Promise<boolean>;
    /** Persist the existing settlement alarm in this command and wake after commit. */
    scheduleSettlement(
      context: OwnerCommandContext,
      scope: OperationSettlementScope,
    ): void | Promise<void>;
  }>,
) {
  text(options.ownerId);
  if (options.catalog.databaseSchema !== options.schema) {
    throw new TypeError("Recovery catalog schema does not match.");
  }
  if (
    typeof options.authorizeControl !== "function" ||
    typeof options.scheduleSettlement !== "function"
  ) {
    throw new TypeError(
      "Recovery authority and settlement scheduling are required.",
    );
  }
  const maxBatch = options.maxBatch ?? 25;
  if (!Number.isSafeInteger(maxBatch) || maxBatch < 1 || maxBatch > 100) {
    throw new TypeError("Recovery batch must be between 1 and 100.");
  }
  const authorized = new WeakMap<SqlExecutor, string>();
  const operationTables = createOperationCatalogTables(options.schema);
  const recover: OwnerCommandHandler = async (_intent, context) => {
    const namespace = authorized.get(context.tx);
    if (namespace === undefined) return refuse();
    const scheduled = new Set<string>();
    // Each established settlement.schedule stages one wake. Keep the command's
    // publication reservation constant even when every delivery has its own scope.
    const wakes: Array<() => void | Promise<void>> = [];
    const store: EventStore = createEventStore({
      session: options.session,
      schema: options.schema,
      ownerCommit: { ...context.ownerCommit, afterCommit: context.afterCommit },
      lockSettlementScope: (tx, scope) => options.catalog.lockScope(tx, scope),
      admitOperationEventSql: (input, param) =>
        options.catalog.admitEventSql(input, param),
      indexOperationEvent: (tx, input) => options.catalog.indexEvent(tx, input),
      indexOperationEventSql: (input, param) =>
        options.catalog.indexEventSql(input, param),
      async settleActionOwners(tx, delivery) {
        // commitDeliverySettlement already holds the exact operation lock.
        const current = await tx.query<{ cancellation_requested_at: unknown }>(
          `SELECT cancellation_requested_at FROM ${operationTables.operations} WHERE namespace=$1 AND operation_id=$2`,
          [namespace, delivery.settlementScopeId],
        );
        if (current.rows.length !== 1) return refuse();
        const publish = await recoverDeliveryActions(
          {
            store,
            coordinator,
            catalog: options.catalog,
            actions: options.registry.actions,
            commandTime: context.commandTime,
            ...(current.rows[0].cancellation_requested_at !== null
              ? {
                deliveryCancellation: {
                  namespace,
                  operationId: delivery.settlementScopeId,
                },
              }
              : {}),
            async hasUnresolvedEffect(transaction, ref) {
              return (await readOwnerEffectInventory(transaction, {
                ...ref,
                ownerId: options.ownerId,
                schema: options.schema,
              })).some((effect) => effect.status === "begun");
            },
          },
          tx,
          delivery,
        );
        if (!scheduled.has(delivery.settlementScopeId)) {
          let registering = true;
          const schedulingContext: OwnerCommandContext = {
            ...context,
            afterCommit(callback) {
              if (!registering) {
                throw new TypeError("Recovery wake registration is closed.");
              }
              if (wakes.length >= maxBatch) {
                throw new TypeError("Recovery wake batch exceeds its bound.");
              }
              wakes.push(callback);
            },
          };
          try {
            await options.scheduleSettlement(schedulingContext, {
              namespace,
              operationId: delivery.settlementScopeId,
            });
          } finally {
            registering = false;
          }
          scheduled.add(delivery.settlementScopeId);
        }
        return publish;
      },
    });
    const coordinator = createEventCoordinator({
      store,
      registry: options.registry,
      executor: options.executor,
      publish: options.publish,
      scheduleOnly: true,
    });
    const recovered = await store.recoverExpiredDeliveries({
      namespace,
      limit: maxBatch,
    });
    if (wakes.length) {
      context.afterCommit(async () => {
        const errors: unknown[] = [];
        for (const wake of wakes) {
          try {
            await wake();
          } catch (error) {
            errors.push(error);
          }
        }
        if (errors.length) {
          throw new AggregateError(
            errors,
            "Recovery settlement wake failed; durable alarms remain.",
          );
        }
      });
    }
    return { deliveryIds: recovered.map((delivery) => delivery.id) };
  };
  return {
    handlers: { [OWNER_ACTION_RECOVERY]: recover },
    async authorize(
      tx: SqlExecutor,
      caller: OwnerCaller,
      command: OwnerCommand,
      commandTime: string,
    ) {
      const data = command.intent as {
        namespace?: unknown;
        occurrence?: unknown;
      } | null;
      if (
        !data || typeof data !== "object" || Array.isArray(data) ||
        Object.keys(data).sort().join(",") !== "namespace,occurrence"
      ) throw new TypeError("Invalid Action recovery data.");
      text(data.namespace);
      text(data.occurrence);
      if (
        command.kind !== OWNER_ACTION_RECOVERY ||
        command.domain !== "occurrence" ||
        command.key !==
          ownerActionRecoveryKey(
            options.ownerId,
            data.namespace,
            data.occurrence,
          )
      ) return refuse();
      if (
        await options.authorizeControl(
          tx,
          structuredClone(caller),
          data.namespace,
          commandTime,
        ) !== true
      ) return refuse();
      authorized.set(tx, data.namespace);
    },
  };
}
