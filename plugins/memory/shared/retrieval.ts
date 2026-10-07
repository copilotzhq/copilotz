/** Bounded note retrieval under current Memory plugin grants. @module */
import type {
  CollectionPredicate,
  CollectionRecord,
  SnapshotCollections,
} from "@copilotz/copilotz/collections";
import type { MemoryNote } from "../authoring/notes/index.ts";
import type { MemorySpaceDescriptor } from "../authoring/consolidation/index.ts";

export type StoredMemoryNote =
  & MemoryNote
  & Readonly<{
    consolidationId: string;
    createdByAgentId: string;
    originThreadId: string;
  }>;

export function memoryNote(value: CollectionRecord): StoredMemoryNote {
  if (
    typeof value.text !== "string" || typeof value.memorySpaceId !== "string"
  ) throw new Error("Stored memory note is invalid.");
  return {
    id: value.id,
    memorySpaceId: value.memorySpaceId,
    text: value.text,
    createdAt: value.createdAt,
    consolidationId: String(value.consolidationId),
    createdByAgentId: String(value.createdByAgentId),
    originThreadId: String(value.originThreadId),
    sources: value.sources as MemoryNote["sources"],
    ...(value.retirement
      ? { retirement: value.retirement as MemoryNote["retirement"] }
      : {}),
  };
}

export function memoryFilter(
  spaces: readonly Pick<MemorySpaceDescriptor, "id">[],
  includeRetired = false,
): CollectionPredicate {
  return {
    and: [
      { field: "memorySpaceId", in: spaces.map((space) => space.id) },
      ...(includeRetired ? [] : [{ field: "retirement", eq: null } as const]),
    ],
  };
}

/** Separate bounded own/peer candidates ensure peer volume cannot starve own notes. */
export async function activeMemoryNotes(
  context: { collections: SnapshotCollections },
  spaces: readonly MemorySpaceDescriptor[],
  limit: number,
) {
  const groups = await Promise.all(
    ["read_write", "read"].map(async (access) => {
      const scopes = spaces.filter((space) => space.access === access);
      if (!scopes.length) return [];
      return await context.collections.memoryNote.list({
        filter: memoryFilter(scopes),
        order: { field: "createdAt", direction: "desc" },
        limit: limit + 1,
      });
    }),
  );
  return {
    notes: groups.flatMap((values) => values.slice(0, limit).map(memoryNote)),
    truncated: groups.some((values) => values.length > limit),
  };
}

export function finiteEmbedding(value: unknown): value is readonly number[] {
  return Array.isArray(value) && value.length > 0 &&
    value.every((item) => typeof item === "number" && Number.isFinite(item));
}

export function vectorSimilarity(metric: string, distance: number): number {
  return metric === "cosine"
    ? 1 - distance
    : metric === "innerProduct"
    ? -distance
    : 1 / (1 + distance);
}
