import type { CollectionDefinition } from "./definition.ts";
import type {
  CollectionProjection,
  CollectionProjections,
} from "./projection-types.ts";
export type CollectionProjectionRegistrations = ReadonlyMap<
  string,
  ReadonlyMap<string, CollectionProjection>
>;

/** Validate the complete owner-only registration before database activation. */
export function validateCollectionProjections(
  supplied: CollectionProjections | undefined,
  collections: Readonly<Record<string, CollectionDefinition>>,
): CollectionProjectionRegistrations {
  const plain = (value: unknown) =>
    value && typeof value === "object" && !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype;
  if (supplied !== undefined && !plain(supplied)) {
    throw new TypeError(
      "Collection projections require an alias/query registration map.",
    );
  }
  const result = new Map<string, ReadonlyMap<string, CollectionProjection>>();
  for (const [alias, queries] of Object.entries(supplied ?? {})) {
    const definition = Object.hasOwn(collections, alias)
      ? collections[alias]
      : undefined;
    if (
      !definition || definition.ownerPolicy !== "required" || !plain(queries)
    ) {
      throw new TypeError(
        "Collection projections require a registered Collection alias.",
      );
    }
    if (
      Object.values(collections).filter((item) => item.name === definition.name)
        .length !== 1
    ) {
      throw new TypeError(
        "An owner projection Collection must have exactly one registered alias.",
      );
    }
    const entries = new Map<string, CollectionProjection>();
    for (const [name, projection] of Object.entries(queries)) {
      const declaration = definition.queries?.[name];
      if (
        !declaration?.ownerProjection || !declaration.inputSchema ||
        !declaration.outputSchema || !plain(projection) ||
        typeof projection.select !== "function" ||
        Object.keys(projection).some((key) => key !== "select")
      ) {
        throw new TypeError(
          "Owner projections require a declared query, input/output schemas, and one select callback.",
        );
      }
      entries.set(name, Object.freeze({ select: projection.select }));
    }
    result.set(definition.name, entries);
  }
  for (const definition of Object.values(collections)) {
    for (const [name, query] of Object.entries(definition.queries ?? {})) {
      if (query.ownerProjection && !result.get(definition.name)?.has(name)) {
        throw new TypeError(
          "A declared owner projection registration is missing.",
        );
      }
    }
  }
  return result;
}
