import {
  authorizationRowKeys,
  authorizationTableKey,
  cachedAuthorization,
  rememberAuthorization,
} from "../authorization/cache.ts";
import {
  ownerDeliveryLive,
  readOwnerDelivery,
} from "../authorization/leases.ts";
import { stableStringify } from "../collections/equal.ts";
/** Current execution fence over the existing operation, lease and Action rows. */
import { ActionOwnershipLost } from "../actions/ownership.ts";
import { createCoreTableNames } from "../events/schema.ts";
import type { SqlExecutor } from "../events/session.ts";
import type { OperationCatalog } from "../streams/catalog.ts";

export type OwnerInvocationLiveness = Readonly<{
  databaseSchema: string;
  namespace: string;
  /** Required when the invocation is bound to an operation. */
  operationCatalog?: Readonly<{
    admitEventSql(...args: Parameters<OperationCatalog["admitEventSql"]>): Pick<
      ReturnType<OperationCatalog["admitEventSql"]>,
      "ctes" | "gate"
    >;
  }>;
  operationId?: string;
  eventId?: string;
  writer?: Readonly<{ deliveryId: string; leaseOwner: string }>;
  /** Only supply an Action which is currently executing, never a stored result. */
  action?: Readonly<{ id: string; runId: string }>;
}>;

export async function assertOwnerInvocationLive(
  read: Readonly<{ transaction: SqlExecutor; commandTime: string }>,
  binding: OwnerInvocationLiveness,
  retainDeadline?: (expiresAt: string | undefined) => void,
): Promise<void> {
  const tables = createCoreTableNames(binding.databaseSchema);
  const params: unknown[] = [];
  const param = (value: unknown) => `$${params.push(value)}`;
  const ctes: string[] = [];
  const gates: string[] = [];
  if (binding.operationId) {
    if (!binding.operationCatalog) {
      throw new TypeError(
        "Invocation operation authority requires its catalog.",
      );
    }
    const admitted = binding.operationCatalog.admitEventSql({
      namespace: binding.namespace,
      operationId: binding.operationId,
    }, param);
    ctes.push(...admitted.ctes);
    gates.push(admitted.gate);
  }
  if (binding.writer) {
    const delivery = param(binding.writer.deliveryId);
    gates.push(`EXISTS (SELECT 1 FROM ${tables.event_deliveries} AS delivery
      WHERE id=${delivery} AND lease_owner=${param(binding.writer.leaseOwner)}
      AND status='leased' AND (lease_expires_at IS NULL OR lease_expires_at > ${
      param(read.commandTime)
    }::timestamptz)
      AND owner_epoch=(SELECT epoch FROM ${tables.owner_epochs} WHERE owner='schema')
      AND EXISTS (SELECT 1 FROM ${tables.events}
        WHERE id=delivery.event_id AND namespace=${param(binding.namespace)})
      ${binding.eventId ? `AND event_id=${param(binding.eventId)}` : ""}
      ${
      binding.operationId
        ? `AND settlement_scope_id=${param(binding.operationId)}`
        : ""
    })`);
    if (binding.action) {
      gates.push(`EXISTS (SELECT 1 FROM ${tables.open_actions}
        WHERE namespace=${param(binding.namespace)} AND action_run_id=${
        param(binding.action.runId)
      }
        AND action_id=${
        param(binding.action.id)
      } AND owner_delivery_id=${delivery}
        AND state IN ('invoked','awaiting'))`);
    }
  }
  if (!gates.length) return;
  const deadline = retainDeadline && binding.writer
    ? `(SELECT lease_expires_at::text FROM ${tables.event_deliveries} WHERE id=${
      param(binding.writer.deliveryId)
    })`
    : "NULL";
  const live = await read.transaction.query<{ expires_at: string | null }>(
    `${ctes.length ? `WITH ${ctes.join(",")}` : ""} SELECT 1 AS live${
      retainDeadline ? `, ${deadline} AS expires_at` : ""
    } WHERE ${gates.join(" AND ")}`,
    params,
  );
  if (live.rows.length !== 1) {
    throw new ActionOwnershipLost(
      binding.action?.runId ?? binding.writer?.deliveryId ??
        binding.operationId ?? "invocation",
    );
  }
  retainDeadline?.(live.rows[0].expires_at ?? undefined);
}

/** Collection reads reuse owner-observed liveness, including their open Action. */
const liveScopes = new WeakMap<object, object>();
const unscopedLive = { cache: "invocation" };
export async function assertCachedOwnerInvocationLive(
  read: Readonly<{ transaction: SqlExecutor; commandTime: string }>,
  binding: OwnerInvocationLiveness,
): Promise<void> {
  let scope = unscopedLive;
  if (binding.operationCatalog) {
    let saved = liveScopes.get(binding.operationCatalog);
    if (!saved) {
      saved = { cache: "invocation" };
      liveScopes.set(binding.operationCatalog, saved);
    }
    scope = saved as typeof unscopedLive;
  }
  const { operationCatalog: _catalog, ...identity } = binding;
  const key = stableStringify(identity);
  let sourceEventId = binding.eventId;
  if (binding.writer) {
    const lease = await readOwnerDelivery(
      read.transaction,
      binding.databaseSchema,
      binding.writer.deliveryId,
    );
    sourceEventId ??= lease?.event_id;
    if (
      !ownerDeliveryLive(
        read.transaction,
        lease,
        binding.writer.leaseOwner,
        read.commandTime,
      ) ||
      binding.eventId && lease?.event_id !== binding.eventId ||
      binding.operationId && lease?.settlement_scope_id !== binding.operationId
    ) {
      throw new ActionOwnershipLost(
        binding.action?.runId ?? binding.writer.deliveryId,
      );
    }
  }
  if (cachedAuthorization<boolean>(read.transaction, scope, key)) return;
  await assertOwnerInvocationLive(read, binding);
  rememberAuthorization(read.transaction, scope, key, true, [
    ...(binding.operationId
      ? authorizationRowKeys(
        binding.databaseSchema,
        "copilotz_operations",
        binding.operationId,
      )
      : []),
    ...(binding.action
      ? [authorizationTableKey(binding.databaseSchema, "open_actions")]
      : []),
    // Events are immutable, but opaque deletion must not retain source authority.
    ...(sourceEventId
      ? authorizationRowKeys(binding.databaseSchema, "events", sourceEventId)
      : []),
  ]);
}
