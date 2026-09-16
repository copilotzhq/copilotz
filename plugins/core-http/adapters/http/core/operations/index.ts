/** Core conversation queries over the generic operation catalog. @module */
import type {
  OperationCatalog,
  OperationRecord,
  OperationState,
} from "@copilotz/copilotz/streams";
function requiredText(value: string, label: string) {
  const text = value.trim();
  if (!text) throw new TypeError(`${label} must be non-empty.`);
  return text;
}
function boundedLimit(value = 1000) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 10000) {
    throw new TypeError("Limit must be between 1 and 10000.");
  }
  return value;
}
export async function operationBelongsToThread(
  catalog: OperationCatalog,
  namespaceInput: string,
  operationIdInput: string,
  threadIdInput: string,
): Promise<boolean> {
  const { session, tables } = catalog;
  const namespace = requiredText(namespaceInput, "Operation namespace");
  const operationId = requiredText(operationIdInput, "Operation id");
  const threadId = requiredText(threadIdInput, "Thread id");
  const result = await session.query<{ operation_id: string }>(
    `SELECT operation.operation_id
           FROM ${tables.operations} AS operation
          WHERE operation.namespace = $1 AND operation.operation_id = $2
            AND (
              operation.metadata -> 'operationMetadata' ->> 'threadId' = $3
              OR EXISTS (
                SELECT 1 FROM ${tables.operationEvents} AS indexed
                JOIN ${tables.events} AS event ON event.id = indexed.event_id
                WHERE indexed.namespace = operation.namespace
                  AND indexed.operation_id = operation.operation_id
                  AND event.metadata -> 'core' ->> 'threadId' = $3
              )
            )
          LIMIT 1`,
    [namespace, operationId, threadId],
  );
  return result.rows.length > 0;
}
export async function listThreadOperations(
  catalog: OperationCatalog,
  input: {
    namespace: string;
    threadId: string;
    states?: readonly OperationState[];
    afterPosition?: string;
    limit?: number;
  },
): Promise<readonly OperationRecord[]> {
  const { session, tables } = catalog;
  const namespace = requiredText(input.namespace, "Operation namespace");
  const threadId = requiredText(input.threadId, "Thread id");
  const params: unknown[] = [namespace, threadId];
  const stateFilter = input.states?.length
    ? ` AND operation.state = ANY($${
      params.push([...new Set(input.states)])
    }::text[])`
    : "";
  if (
    input.afterPosition && !/^(0|[1-9][0-9]*)$/.test(input.afterPosition)
  ) throw new TypeError("Invalid event position.");
  const progressFilter = input.afterPosition
    ? ` AND (operation.state IN ('accepted', 'running') OR EXISTS (
        SELECT 1 FROM ${tables.operationEvents} AS progress WHERE progress.namespace = operation.namespace
        AND progress.operation_id = operation.operation_id AND progress.event_position > $${
      params.push(input.afterPosition)
    }::bigint))`
    : "";
  params.push(boundedLimit(input.limit));
  const result = await session.query<{ operation_id: string }>(
    `SELECT operation.operation_id FROM ${tables.operations} AS operation
          WHERE operation.namespace = $1${stateFilter}${progressFilter}
            AND (
              operation.metadata -> 'operationMetadata' ->> 'threadId' = $2
              OR EXISTS (
                SELECT 1 FROM ${tables.operationEvents} AS indexed
                JOIN ${tables.events} AS event ON event.id = indexed.event_id
                WHERE indexed.namespace = operation.namespace
                  AND indexed.operation_id = operation.operation_id
                  AND event.metadata -> 'core' ->> 'threadId' = $2
              )
            )
          ORDER BY operation.updated_at DESC, operation.operation_id DESC
          LIMIT $${params.length}`,
    params,
  );
  return result.rows.length
    ? await catalog.list({
      namespace,
      operationIds: result.rows.map((row) => row.operation_id),
      limit: result.rows.length,
    })
    : [];
}
export async function threadEventWatermark(
  catalog: OperationCatalog,
  namespaceInput: string,
  threadIdInput: string,
): Promise<string | undefined> {
  const { session, tables } = catalog;
  const result = await session.query<{
    position: string | number | bigint | null;
  }>(
    `SELECT MAX(position) AS position FROM ${tables.events}
          WHERE namespace = $1 AND metadata -> 'core' ->> 'threadId' = $2`,
    [
      requiredText(namespaceInput, "Operation namespace"),
      requiredText(threadIdInput, "Thread id"),
    ],
  );
  const value = result.rows[0]?.position;
  return value === null || value === undefined ? undefined : String(value);
}
