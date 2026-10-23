/** Current lease facts from the serialized owner, never a grant supplied by a worker. */
import type { SqlExecutor, SqlQueryResult } from "../events/session.ts";
import { createCoreTableNames } from "../events/schema.ts";
import {
  authorizationOwnerEpoch,
  authorizationRowKeys,
  cachedAuthorization,
  hintAuthorizationRows,
  rememberAuthorization,
} from "./cache.ts";
import type { AuthorityValidity } from "./authority.ts";

export type OwnerDeliveryLease = {
  id: string;
  event_id: string;
  settlement_scope_id: string;
  lease_owner: string | null;
  owner_epoch: number | string;
  status: string;
  lease_expires_at: string | Date | null;
};
const leases = { cache: "lease" };
const key = (schema: string, id: string) => JSON.stringify([schema, id]);
export function rememberOwnerDelivery(
  transaction: SqlExecutor,
  schema: string,
  row: OwnerDeliveryLease,
): void {
  rememberAuthorization(transaction, leases, key(schema, row.id), {
    id: row.id,
    event_id: row.event_id,
    settlement_scope_id: row.settlement_scope_id,
    lease_owner: row.lease_owner,
    owner_epoch: row.owner_epoch,
    status: row.status,
    lease_expires_at: row.lease_expires_at,
  }, authorizationRowKeys(schema, "event_deliveries", row.id));
}
/** Lease, renew, settle, expire and reclaim commands already return the changed rows. */
export async function writeOwnerDeliveries<
  T extends OwnerDeliveryLease & Record<string, unknown>,
>(
  transaction: SqlExecutor,
  schema: string,
  ids: readonly string[] | undefined,
  sql: string,
  params?: unknown[],
): Promise<SqlQueryResult<T>> {
  hintAuthorizationRows(
    transaction,
    schema,
    "event_deliveries",
    ids ?? ((rows) => rows.map((row) => String(row.id))),
  );
  const result = await transaction.query<T>(sql, params);
  for (const row of result.rows) {
    rememberOwnerDelivery(transaction, schema, row);
  }
  return result;
}
export async function readOwnerDelivery(
  transaction: SqlExecutor,
  schema: string,
  id: string,
): Promise<OwnerDeliveryLease | undefined> {
  const saved = cachedAuthorization<OwnerDeliveryLease>(
    transaction,
    leases,
    key(schema, id),
  );
  if (saved) return saved;
  const row = (await transaction.query<OwnerDeliveryLease>(
    `SELECT id,event_id,settlement_scope_id,lease_owner,owner_epoch,status,lease_expires_at FROM ${
      createCoreTableNames(schema).event_deliveries
    } WHERE id=$1`,
    [id],
  )).rows[0];
  if (row) rememberOwnerDelivery(transaction, schema, row);
  return row;
}
export function ownerDeliveryLive(
  transaction: SqlExecutor,
  lease: OwnerDeliveryLease | undefined,
  worker: string,
  time: string,
  epoch = authorizationOwnerEpoch(transaction),
  requireExpiry = false,
): boolean {
  return !!lease && lease.status === "leased" && lease.lease_owner === worker &&
    (epoch === undefined || Number(lease.owner_epoch) === Number(epoch)) &&
    (lease.lease_expires_at === null
      ? !requireExpiry
      : new Date(lease.lease_expires_at).getTime() > Date.parse(time));
}
export async function ownerAttemptLive(
  transaction: SqlExecutor,
  schema: string,
  attempt: Extract<AuthorityValidity, { kind: "attempt" }>,
  time: string,
): Promise<boolean> {
  const epoch = authorizationOwnerEpoch(transaction);
  if (epoch !== undefined && epoch !== Number(attempt.epoch)) return false;
  return ownerDeliveryLive(
    transaction,
    await readOwnerDelivery(transaction, schema, attempt.attempt),
    attempt.worker,
    time,
    Number(attempt.epoch),
    true,
  );
}
