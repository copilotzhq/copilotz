import { awaitEventPublication } from "../events/coordinator.ts";
import { withoutCollectionPolicyInvocation } from "../collections/policy-invocation.ts";
import { createOperationCatalogTables } from "../streams/catalog.ts";
/** Owner-only terminal settlement after a trusted current-policy refusal. */
import { createSchemaCommandRunner } from "../engine/commands.ts";
import { withoutOwnerCommandAuthorization } from "../engine/command-authorization.ts";
import { sanitizedAuthorizationRefusal } from "../engine/authorization-refusal.ts";
import { eventDataRef, readEventBody } from "../events/body-store.ts";
import type {
  EventCoordinator,
  EventStore,
  SqlExecutor,
} from "../events/index.ts";
import type { ActionInvocationFrame } from "./invoker.ts";
import { createActionLifecycleAppender } from "./persistence.ts";
import { createActionLifecycleEmitter } from "./lifecycle.ts";
import { publicActionLifecycleData } from "./protected-lifecycle.ts";
import { readActionEffectInventory } from "./effect-commands.ts";
import type { ActionWriter } from "./ownership.ts";
import { ActionOwnershipLost } from "./ownership.ts";
import type { ActionEventData, AnyActionDefinition } from "./types.ts";
import type { ProtectedValueRuntime } from "./protected-value.ts";
import { sameActionValue } from "./value.ts";
/** Follow only the retained wait target and its operation children. Overflow
 * cannot prove no external work, so preserve indeterminacy rather than guessing. */
async function waitedEffectIndeterminate(
  tx: SqlExecutor,
  store: EventStore,
  namespace: string,
  operationId: string,
): Promise<boolean> {
  const catalog = createOperationCatalogTables(store.databaseSchema);
  const queue = [operationId], seen = new Set(queue);
  let examined = 0;
  for (let index = 0; index < queue.length; index++) {
    const ids = (await tx.query<{ event_id: string }>(
      `SELECT event_id FROM ${catalog.operationEvents} WHERE namespace=$1 AND operation_id=$2 ORDER BY event_ordinal LIMIT $3`,
      [namespace, queue[index], 65 - examined],
    )).rows;
    if (ids.length + examined > 64) return true;
    examined += ids.length;
    for (const { event_id } of ids) {
      const event = (await tx.query<{ type: string; payload: unknown }>(
        `SELECT type,payload FROM ${store.tables.events} WHERE namespace=$1 AND id=$2`,
        [namespace, event_id],
      )).rows[0];
      if (!event) return true;
      if (!event.type.endsWith(".invoked")) continue;
      const data = publicActionLifecycleData(
        await readEventBody(
          { transaction: tx, tables: store.tables },
          namespace,
          eventDataRef(event.payload),
        ),
      ) as ActionEventData;
      if (data.status !== "invoked" || typeof data.actionRunId !== "string") {
        return true;
      }
      if (
        (await readActionEffectInventory(tx, {
          schema: store.databaseSchema,
          namespace,
          actionRunId: data.actionRunId,
        })).some((row) => row.status === "begun")
      ) return true;
    }
    const children = (await tx.query<{ operation_id: string }>(
      `SELECT operation_id FROM ${catalog.operations} WHERE namespace=$1 AND parent_operation_id=$2 LIMIT $3`,
      [namespace, queue[index], 65 - seen.size],
    )).rows;
    for (const child of children) {
      if (seen.size >= 64 || seen.has(child.operation_id)) return true;
      seen.add(child.operation_id);
      queue.push(child.operation_id);
    }
  }
  return false;
}
export async function settleActionAuthorizationRefusal(
  options: Readonly<{
    store: EventStore;
    coordinator: EventCoordinator;
    namespace: string;
    source: Readonly<{ eventId: string; operationId?: string }>;
    writer?: ActionWriter;
    actions: Readonly<Record<string, AnyActionDefinition>>;
    protectedValues?: ProtectedValueRuntime;
  }>,
  frame: ActionInvocationFrame,
): Promise<{ error: Error; settled: boolean }> {
  // Snapshot only owner-bound coordinates, before the first await. No worker
  // reason/status/output is accepted by this narrow capability.
  const binding = Object.freeze({
    actionId: frame.actionId,
    actionRunId: frame.actionRunId,
    parentActionRunId: frame.parentActionRunId,
    metadata: structuredClone(frame.metadata),
  });
  const { store, namespace } = options;
  const source = Object.freeze({ ...options.source }),
    writer = options.writer && Object.freeze({ ...options.writer });
  if (!writer || writer.kind !== "delivery") {
    throw new ActionOwnershipLost(binding.actionRunId);
  }
  return await withoutCollectionPolicyInvocation(() =>
    withoutOwnerCommandAuthorization(() =>
      createSchemaCommandRunner(store.session, store.databaseSchema)(
        "actions.refuseAuthorization",
        { actionRunId: binding.actionRunId },
        async (_, command) => {
          const tx = command.transaction;
          const lease = await tx.query(
            `SELECT delivery.id FROM ${store.tables.event_deliveries} delivery JOIN ${store.tables.events} event ON event.id=delivery.event_id WHERE delivery.id=$1 AND delivery.event_id=$2 AND event.namespace=$3 AND delivery.status='leased' AND delivery.lease_owner=$4 AND (delivery.lease_expires_at IS NULL OR delivery.lease_expires_at>$6::timestamptz) AND delivery.owner_epoch=(SELECT epoch FROM ${store.tables.owner_epochs} WHERE owner='schema') AND ($5::text IS NULL OR delivery.settlement_scope_id=$5)`,
            [
              writer.deliveryId,
              source.eventId,
              namespace,
              writer.leaseOwner,
              source.operationId ?? null,
              command.commandTime,
            ],
          );
          if (lease.rows.length !== 1) {
            throw new ActionOwnershipLost(binding.actionRunId);
          }
          const event = (await tx.query<
            {
              id: string;
              payload: unknown;
              correlation_id: string;
            }
          >(
            `SELECT event.id,event.payload,event.correlation_id FROM ${store.tables.events} event WHERE event.namespace=$1 AND event.deduplication_id=$2`,
            [namespace, `${binding.actionRunId}:action:invoked`],
          )).rows[0];
          if (!event) {
            return { error: sanitizedAuthorizationRefusal(), settled: false }; // The refused claim never became an obligation.
          }
          const data = publicActionLifecycleData(
            await readEventBody(
              { transaction: tx, tables: store.tables },
              namespace,
              eventDataRef(event.payload),
            ),
          ) as ActionEventData;
          if (
            data.status !== "invoked" ||
            data.actionRunId !== binding.actionRunId ||
            data.actionId !== binding.actionId ||
            data.parentActionRunId !== binding.parentActionRunId ||
            !sameActionValue(data.metadata, binding.metadata)
          ) throw new ActionOwnershipLost(binding.actionRunId);
          const obligation = (await tx.query<
            {
              invoked_event_id: string;
              owner_delivery_id: string | null;
              scope_id: string;
              action_scope_id: string | null;
              child_operation_id: string | null;
            }
          >(
            `SELECT invoked_event_id,owner_delivery_id,scope_id,action_scope_id,child_operation_id FROM ${store.tables.open_actions} WHERE namespace=$1 AND action_run_id=$2`,
            [namespace, binding.actionRunId],
          )).rows[0];
          if (source.operationId) {
            const member = await tx.query(
              `SELECT event_id FROM ${
                createOperationCatalogTables(store.databaseSchema)
                  .operationEvents
              } WHERE namespace=$1 AND operation_id=$2 AND event_id=$3 LIMIT 1`,
              [namespace, source.operationId, event.id],
            );
            if (!member.rows.length) {
              throw new ActionOwnershipLost(binding.actionRunId);
            }
          }
          const indeterminate = (await readActionEffectInventory(tx, {
            schema: store.databaseSchema,
            namespace,
            actionRunId: binding.actionRunId,
          })).some((entry) => entry.status === "begun") ||
            Boolean(
              obligation?.child_operation_id &&
                await waitedEffectIndeterminate(
                  tx,
                  store,
                  namespace,
                  obligation.child_operation_id,
                ),
            );
          const refusal = sanitizedAuthorizationRefusal(indeterminate);
          if (!obligation) {
            const terminal = (await tx.query<{ payload: unknown }>(
              `SELECT payload FROM ${store.tables.events} WHERE namespace=$1 AND deduplication_id=$2`,
              [namespace, `${binding.actionRunId}:action:terminal`],
            )).rows[0];
            if (!terminal) throw new ActionOwnershipLost(binding.actionRunId);
            const retained = publicActionLifecycleData(
              await readEventBody(
                { transaction: tx, tables: store.tables },
                namespace,
                eventDataRef(terminal.payload),
              ),
            ) as ActionEventData;
            if (
              !["completed", "failed", "cancelled"].includes(retained.status) ||
              retained.actionId !== binding.actionId ||
              retained.actionRunId !== binding.actionRunId ||
              retained.parentActionRunId !== binding.parentActionRunId ||
              !sameActionValue(retained.metadata, binding.metadata)
            ) throw new ActionOwnershipLost(binding.actionRunId);
            return { error: refusal, settled: true }; // Disclosure refusal cannot undo an earlier committed terminal.
          }
          if (
            obligation.invoked_event_id !== event.id ||
            obligation.owner_delivery_id !== writer.deliveryId ||
            (source.operationId && obligation.scope_id !== source.operationId)
          ) throw new ActionOwnershipLost(binding.actionRunId);
          const lifecycle = createActionLifecycleEmitter({
            namespace,
            metadata: {
              sourceEventId: source.eventId,
              sourceDeliveryId: writer.deliveryId,
            },
            append: createActionLifecycleAppender({
              store,
              coordinator: options.coordinator,
              actions: options.actions,
              protectedValues: options.protectedValues,
              writer,
              transaction: tx,
            }),
          });
          const result = await lifecycle.emit({
            actionId: data.actionId,
            actionRunId: data.actionRunId,
            ...(data.parentActionRunId
              ? { parentActionRunId: data.parentActionRunId }
              : {}),
            input: data.input,
            metadata: data.metadata,
            status: "failed",
            error: {
              ...(indeterminate
                ? {
                  name: refusal.name,
                  message: refusal.message,
                  code: (refusal as Error & { code: string }).code,
                }
                : {
                  name: "ActionError",
                  message: "Forbidden",
                  code: "forbidden",
                  status: 403,
                  callerSafe: true,
                }),
            },
            deduplicationId: `${data.actionRunId}:action:terminal`,
            settlementScopeId: obligation.scope_id,
            actionScopeId: obligation.action_scope_id ?? undefined,
            causationId: source.eventId,
            correlationId: event.correlation_id,
          });
          command.afterCommit(async () => {
            await awaitEventPublication(
              result as import("../events/store.ts").CommitEventMutationResult<
                unknown
              >,
            );
          });
          return { error: refusal, settled: true };
        },
      )
    )
  );
}
