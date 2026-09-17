/** Core conversation queries over the generic operation catalog. @module */
import type {
  OperationCatalog,
  OperationRecord,
  OperationState,
} from "@copilotz/copilotz/streams";

type OperationListCatalog = Pick<OperationCatalog, "list">;
type OperationWatermarkCatalog = Pick<OperationCatalog, "maxEventPosition">;

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
  catalog: OperationListCatalog,
  namespaceInput: string,
  operationIdInput: string,
  threadIdInput: string,
): Promise<boolean> {
  const namespace = requiredText(namespaceInput, "Operation namespace");
  const operationId = requiredText(operationIdInput, "Operation id");
  const threadId = requiredText(threadIdInput, "Thread id");
  const result = await catalog.list({
    namespace,
    operationIds: [operationId],
    association: {
      operationMetadata: { operationMetadata: { threadId } },
      eventMetadata: { core: { threadId } },
    },
    limit: 1,
  });
  return result.length > 0;
}

export async function listThreadOperations(
  catalog: OperationListCatalog,
  input: {
    namespace: string;
    threadId: string;
    operationIds?: readonly string[];
    states?: readonly OperationState[];
    afterPosition?: string;
    limit?: number;
  },
): Promise<readonly OperationRecord[]> {
  const namespace = requiredText(input.namespace, "Operation namespace");
  const threadId = requiredText(input.threadId, "Thread id");
  if (
    input.afterPosition && !/^(0|[1-9][0-9]*)$/.test(input.afterPosition)
  ) throw new TypeError("Invalid event position.");
  return await catalog.list({
    namespace,
    operationIds: input.operationIds,
    states: input.states,
    association: {
      operationMetadata: { operationMetadata: { threadId } },
      eventMetadata: { core: { threadId } },
    },
    afterPosition: input.afterPosition || undefined,
    limit: boundedLimit(input.limit),
  });
}

export async function threadEventWatermark(
  catalog: OperationWatermarkCatalog,
  namespaceInput: string,
  threadIdInput: string,
): Promise<string | undefined> {
  return await catalog.maxEventPosition({
    namespace: requiredText(namespaceInput, "Operation namespace"),
    eventMetadata: {
      core: { threadId: requiredText(threadIdInput, "Thread id") },
    },
  });
}
