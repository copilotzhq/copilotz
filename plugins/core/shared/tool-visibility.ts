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
