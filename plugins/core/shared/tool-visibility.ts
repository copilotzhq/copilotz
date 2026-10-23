/** Shared output authorization for retained results and live Tool output. @module */
import type { CollectionPredicate } from "@copilotz/copilotz/collections/authoring";

/** Missing initiator identity never grants access to retained output. */
export function canReadToolOutput(
  visibility: Readonly<Record<string, unknown>>,
  viewers: readonly string[],
): boolean {
  return visibility.policy === "public" ||
    typeof visibility.requesterId === "string" &&
      viewers.includes(visibility.requesterId) ||
    visibility.policy === "public_status" &&
      typeof visibility.initiatorId === "string" &&
      viewers.includes(visibility.initiatorId);
}

/** Storage equivalent, repeated before resolving bodies to fence policy changes. */
export function toolOutputReadFilter(
  viewers: readonly string[],
): CollectionPredicate {
  return {
    or: [
      { field: "visibility.kind", ne: "tool" },
      { field: "visibility.policy", eq: "public" },
      { field: "visibility.requesterId", in: viewers },
      {
        and: [
          { field: "visibility.policy", eq: "public_status" },
          { field: "visibility.initiatorId", in: viewers },
        ],
      },
    ],
  };
}

/** Public tool status never grants access to a result body or execution metadata. */
export function projectToolOutput<T extends Readonly<Record<string, unknown>>>(
  record: T,
  viewers?: readonly string[],
): T {
  const visibility = record.visibility as Record<string, unknown> | undefined;
  if (
    !viewers || visibility?.kind !== "tool" ||
    canReadToolOutput(visibility, viewers)
  ) return record;
  const metadata = (record.metadata ?? {}) as Record<string, unknown>;
  const invocation = metadata.toolInvocation as
    | Record<string, unknown>
    | undefined;
  const workflow = metadata.copilotzWorkflow as
    | Record<string, unknown>
    | undefined;
  const action = metadata.copilotzToolAction as
    | Record<string, unknown>
    | undefined;
  return {
    ...record,
    content: [],
    metadata: {
      ...(metadata.toolStatus !== undefined
        ? { toolStatus: metadata.toolStatus }
        : {}),
      ...(metadata.toolId !== undefined ? { toolId: metadata.toolId } : {}),
      toolInvocation: {
        ...(invocation?.id !== undefined ? { id: invocation.id } : {}),
        tool: metadata.toolId !== undefined ? { id: metadata.toolId } : {},
      },
      copilotzWorkflow: workflow?.sourceMessageId !== undefined
        ? { sourceMessageId: workflow.sourceMessageId }
        : {},
      copilotzToolAction: {
        ...(action?.actionRunId !== undefined
          ? { actionRunId: action.actionRunId }
          : {}),
        ...(action?.planMessageId !== undefined
          ? { planMessageId: action.planMessageId }
          : {}),
      },
    },
  };
}
