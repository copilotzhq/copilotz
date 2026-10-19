/** Current execution fence over the existing operation, lease and Action rows. */
import { ActionOwnershipLost } from "../actions/ownership.ts";
import { createCoreTableNames } from "../events/schema.ts";
import type { SqlExecutor } from "../events/session.ts";
import type { OperationCatalog } from "../streams/catalog.ts";

export type OwnerInvocationLiveness = Readonly<{
  databaseSchema: string;
  namespace: string;
  /** Required when the invocation is bound to an operation. */
  operationCatalog?: Pick<OperationCatalog, "admitEventSql">;
  operationId?: string;
  eventId?: string;
  writer?: Readonly<{ deliveryId: string; leaseOwner: string }>;
  /** Only supply an Action which is currently executing, never a stored result. */
  action?: Readonly<{ id: string; runId: string }>;
}>;

export async function assertOwnerInvocationLive(
  read: Readonly<{ transaction: SqlExecutor; commandTime: string }>,
  binding: OwnerInvocationLiveness,
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
  const live = await read.transaction.query(
    `${ctes.length ? `WITH ${ctes.join(",")}` : ""} SELECT 1 AS live WHERE ${
      gates.join(" AND ")
    }`,
    params,
  );
  if (live.rows.length !== 1) {
    throw new ActionOwnershipLost(
      binding.action?.runId ?? binding.writer?.deliveryId ??
        binding.operationId ?? "invocation",
    );
  }
}
