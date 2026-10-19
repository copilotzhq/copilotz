import type { CollectionDefinition } from "./definition.ts";
import type { CollectionPolicies, CollectionPolicy } from "./policy-types.ts";

export type CollectionPolicyRegistration = Readonly<{
  alias: string;
  name: string;
  policy: CollectionPolicy;
}>;
export type CollectionPolicyRegistrations = ReadonlyMap<
  string,
  CollectionPolicyRegistration
>;

/** Validate host registrations before acquiring or activating a database owner. */
export function validateCollectionPolicies(
  policies: CollectionPolicies | undefined,
  collections: Readonly<Record<string, CollectionDefinition>>,
): CollectionPolicyRegistrations {
  if (
    policies !== undefined &&
    (!policies || typeof policies !== "object" || Array.isArray(policies))
  ) {
    throw new TypeError("collectionPolicies must be a registration map.");
  }
  const result = new Map<string, CollectionPolicyRegistration>();
  for (const [alias, policy] of Object.entries(policies ?? {})) {
    const definition = Object.hasOwn(collections, alias)
      ? collections[alias]
      : undefined;
    if (!definition || !policy || typeof policy.authorize !== "function") {
      throw new TypeError(
        "Collection policies require a registered alias and authorize callback.",
      );
    }
    if (
      Object.values(collections).filter((item) => item.name === definition.name)
        .length !== 1
    ) {
      throw new TypeError(
        "A protected Collection must have exactly one registered alias.",
      );
    }
    result.set(
      definition.name,
      Object.freeze({
        alias,
        name: definition.name,
        policy: Object.freeze({ authorize: policy.authorize }),
      }),
    );
  }
  for (const definition of Object.values(collections)) {
    if (
      definition.ownerPolicy !== undefined &&
      definition.ownerPolicy !== "required"
    ) {
      throw new TypeError("Collection ownerPolicy must be 'required'.");
    }
    if (definition.ownerPolicy === "required" && !result.has(definition.name)) {
      throw new TypeError("A required Collection owner policy is missing.");
    }
  }
  return result;
}
