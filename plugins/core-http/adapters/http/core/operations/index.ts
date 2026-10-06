/** Core conversation queries over the generic operation catalog. @module */
import type {
  OperationCatalog,
  OperationSelectionChange,
  OperationState,
} from "@copilotz/copilotz/streams";
import { coreThreadObservationKey } from "@copilotz/copilotz/core";

type OperationListCatalog = Pick<OperationCatalog, "listSelectionChanges">;
type OperationWatermarkCatalog = Pick<OperationCatalog, "getSelectionHeads">;

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
  const result = await catalog.listSelectionChanges({
    namespace: requiredText(namespaceInput, "Operation namespace"),
    operationIds: [requiredText(operationIdInput, "Operation id")],
    selectionKey: coreThreadObservationKey(threadIdInput),
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
    /** Commit-ordered selection change ordinal, independent of global Event positions. */
    afterPosition?: string;
    limit?: number;
  },
): Promise<readonly OperationSelectionChange[]> {
  if (input.afterPosition && !/^(0|[1-9][0-9]*)$/.test(input.afterPosition)) {
    throw new TypeError("Invalid selection position.");
  }
  return await catalog.listSelectionChanges({
    namespace: requiredText(input.namespace, "Operation namespace"),
    selectionKey: coreThreadObservationKey(input.threadId),
    operationIds: input.operationIds,
    states: input.states,
    afterChangeOrdinal: input.afterPosition || undefined,
    limit: boundedLimit(input.limit),
  });
}

export async function threadEventWatermark(
  catalog: OperationWatermarkCatalog,
  namespaceInput: string,
  threadIdInput: string,
): Promise<string | undefined> {
  const key = coreThreadObservationKey(threadIdInput);
  const heads = await catalog.getSelectionHeads({
    namespace: requiredText(namespaceInput, "Operation namespace"),
    selectionKeys: [key],
  });
  return heads.find((head) => head.selectionKey === key)?.changeOrdinal;
}
