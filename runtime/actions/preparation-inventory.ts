/** Bounded lookups over existing retained lifecycle and operation inventory. */
import type { SqlExecutor } from "../events/session.ts";
import { preparationError as fail } from "./preparation-data.ts";
const lifecycle =
  `(CASE WHEN body->>'schema'='copilotz.action.lifecycle.protected.v1' THEN body->'data' ELSE body END)`;
export function preparationInventoryIndexes(
  tables: { event_bodies: string; owner_receipts: string },
): readonly string[] {
  return [
    `CREATE INDEX IF NOT EXISTS "event_bodies_action_parent_idx" ON ${tables.event_bodies} (namespace, (${lifecycle}->>'parentActionRunId')) WHERE ${lifecycle}->>'status'='invoked'`,
    `CREATE INDEX IF NOT EXISTS "owner_receipts_preparation_operation_idx" ON ${tables.owner_receipts} ((result->'binding'->>'namespace'), (result->'binding'->>'operationId')) WHERE owner='schema' AND domain='logical' AND kind='actions.prepareNamed'`,
  ];
}
export function preparationChildrenSql(table: string): string {
  return `SELECT ${lifecycle}->>'actionRunId' AS run FROM ${table} WHERE namespace=$1 AND ${lifecycle}->>'parentActionRunId'=$2 AND ${lifecycle}->>'status'='invoked' LIMIT $3`;
}
export function preparationOperationReceiptsSql(table: string): string {
  return `SELECT result->'binding'->>'actionRunId' AS run FROM ${table} WHERE owner='schema' AND domain='logical' AND kind='actions.prepareNamed' AND result->'binding'->>'namespace'=$1 AND result->'binding'->>'operationId'=$2 LIMIT $3`;
}
const LIMIT = 64;
/** Each probe is an equality index lookup with a hard SQL row limit. No namespace scan or recursive materialization. */
export async function preparationActionDescendants(
  transaction: SqlExecutor,
  table: string,
  namespace: string,
  root: string,
): Promise<readonly string[]> {
  const queue = [root];
  const seen = new Set(queue);
  for (let index = 0; index < queue.length; index++) {
    const rows =
      (await transaction.query<{ run: string }>(preparationChildrenSql(table), [
        namespace,
        queue[index],
        LIMIT - seen.size + 1,
      ])).rows;
    for (const { run } of rows) {
      if (!run || seen.has(run)) fail("preparation_capture_invalid");
      if (seen.size >= LIMIT) fail("preparation_limit");
      seen.add(run);
      queue.push(run);
    }
  }
  return queue.slice(1);
}
export async function preparationOperationDescendants(
  transaction: SqlExecutor,
  tables: { operations: string; receipts: string },
  namespace: string,
  root: string,
): Promise<readonly string[]> {
  const queue = [root], runs: string[] = [];
  const seen = new Set(queue), captured = new Set<string>();
  for (let index = 0; index < queue.length; index++) {
    const receipts = (await transaction.query<{ run: string }>(
      preparationOperationReceiptsSql(tables.receipts),
      [namespace, queue[index], LIMIT - captured.size + 1],
    )).rows;
    for (const { run } of receipts) {
      if (!run || captured.has(run)) fail("preparation_capture_invalid");
      if (captured.size >= LIMIT) fail("preparation_limit");
      captured.add(run);
      runs.push(run);
    }
    const children = (await transaction.query<{ operation_id: string }>(
      `SELECT operation_id FROM ${tables.operations} WHERE namespace=$1 AND parent_operation_id=$2 LIMIT $3`,
      [namespace, queue[index], LIMIT - seen.size + 1],
    )).rows;
    for (const { operation_id: id } of children) {
      if (!id || seen.has(id)) fail("preparation_capture_invalid");
      if (seen.size >= LIMIT) fail("preparation_limit");
      seen.add(id);
      queue.push(id);
    }
  }
  return runs;
}
