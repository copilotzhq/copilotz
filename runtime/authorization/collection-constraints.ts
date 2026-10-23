/** Constraint enforcement used only inside the owner's Collection command. */
import type {
  ServerCollectionMutationPolicy,
  ServerConstraints,
} from "./contracts.ts";
import type { CollectionPolicyIntent } from "./intent.ts";
import { authorizationRefused } from "./evaluator.ts";
import {
  compileCollectionPredicate,
  matchesCollectionFilter,
} from "../collections/predicate.ts";
import { sameValue } from "../collections/equal.ts";
import type {
  CollectionFilter,
  CollectionRecord,
} from "../collections/types.ts";

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    authorizationRefused();
  }
  return value as Record<string, unknown>;
}
/** Validate captured policy data before any consumer can interpret a filter. */
export function validateCollectionConstraints(
  constraints: ServerConstraints,
): void {
  const filter = (value: unknown) => {
    try {
      const input = record(value);
      for (const [key, item] of Object.entries(input)) {
        if (key === "filter") {
          compileCollectionPredicate(
            item as NonNullable<CollectionFilter["filter"]>,
            [],
          );
        } else if (["where", "contains", "containsAny"].includes(key)) {
          const fields = record(item);
          if (
            Object.keys(fields).some((field) =>
              !/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(field)
            )
          ) throw new TypeError("Invalid policy filter field path.");
          if (
            key === "containsAny" &&
            Object.values(fields).some((values) => !Array.isArray(values))
          ) {
            throw new TypeError("Policy containsAny requires arrays.");
          }
        } else {
          throw new TypeError(`Unsupported policy filter clause: ${key}`);
        }
      }
    } catch (error) {
      console.error("Policy collection filter refused", {
        reason: error instanceof Error ? error.message : String(error),
      });
      authorizationRefused();
    }
  };
  if (constraints.collections !== undefined) {
    for (const value of Object.values(record(constraints.collections))) {
      filter(value);
    }
  }
  const mutation = (value: unknown) => {
    const policy = record(value);
    if (
      Object.keys(policy).some((key) =>
        !["filter", "fields", "input"].includes(key)
      )
    ) authorizationRefused();
    if (Object.hasOwn(policy, "filter")) filter(policy.filter);
    if (
      Object.hasOwn(policy, "fields") &&
      (!Array.isArray(policy.fields) ||
        policy.fields.some((field) => typeof field !== "string"))
    ) authorizationRefused();
    if (Object.hasOwn(policy, "input")) record(policy.input);
  };
  if (constraints.collectionMutations !== undefined) {
    for (
      const value of Object.values(record(constraints.collectionMutations))
    ) {
      for (const [key, policy] of Object.entries(record(value))) {
        if (key === "commands") {
          for (const command of Object.values(record(policy))) {
            mutation(command);
          }
        } else if (["create", "update", "delete"].includes(key)) {
          mutation(policy);
        } else authorizationRefused();
      }
    }
  }
}

function inserted(
  input: Record<string, unknown>,
  trusted?: Readonly<Record<string, unknown>>,
) {
  const value = { ...input };
  for (const [key, item] of Object.entries(trusted ?? {})) {
    if (Object.hasOwn(value, key) && !sameValue(value[key], item)) {
      authorizationRefused();
    }
    value[key] = item;
  }
  return value;
}
function fields(
  policy: ServerCollectionMutationPolicy,
  input: readonly string[],
) {
  if (policy.fields && input.some((field) => !policy.fields!.includes(field))) {
    authorizationRefused();
  }
}
export function constrainCollection(
  intent: CollectionPolicyIntent,
  constraints: ServerConstraints,
): unknown {
  const args = record(intent.args);
  const read = [
    "get",
    "list",
    "aggregate",
    "search",
    "query",
    "relations.list",
    "vectors.search",
  ].includes(intent.method);
  if (read) {
    const filter = constraints.collections?.[intent.collection.alias] ??
      constraints.collections?.[intent.collection.name];
    if (!filter || (Array.isArray(args.include) && args.include.length)) {
      authorizationRefused();
    }
    if (
      intent.phase === "result" && intent.result !== null &&
      intent.result !== undefined &&
      !["aggregate", "query"].includes(intent.method)
    ) {
      const value = intent.method === "vectors.search"
        ? record(intent.result).record
        : intent.result;
      if (
        value && !(Array.isArray(value) && value.length === 0) &&
        !matchesCollectionFilter(filter, value as CollectionRecord)
      ) authorizationRefused();
    }
    if (intent.method === "vectors.search") {
      return { ...args, authorizationFilter: filter };
    }
    return ["list", "aggregate", "search"].includes(
        intent.method,
      )
      ? { ...args, all: [...(Array.isArray(args.all) ? args.all : []), filter] }
      : args;
  }
  const mutation = constraints.collectionMutations?.[intent.collection.alias] ??
    constraints.collectionMutations?.[intent.collection.name];
  const policy = intent.method === "command"
    ? mutation?.commands?.[String(args.name)]
    : mutation?.[intent.method as "create" | "update" | "delete"];
  if (!policy) authorizationRefused();
  if (intent.phase === "mutation") {
    if (
      policy.filter && intent.current !== undefined &&
      intent.method !== "create" &&
      (!intent.current ||
        !matchesCollectionFilter(policy.filter, intent.current))
    ) authorizationRefused();
  }
  if (
    policy.filter && intent.next &&
    !matchesCollectionFilter(policy.filter, intent.next)
  ) authorizationRefused();
  if (intent.method === "create") {
    const input = record(args.input);
    if (
      ["namespace", "createdAt", "updatedAt"].some((field) =>
        Object.hasOwn(input, field)
      )
    ) authorizationRefused();
    fields(policy, Object.keys(input).filter((field) => field !== "id"));
    return { ...args, input: inserted(input, policy.input) };
  }
  if (intent.method === "update") {
    const input = inserted(args, policy.input);
    const set = record(input.set ?? {});
    const unset = input.unset ?? [];
    if (
      !Array.isArray(unset) || unset.some((field) => typeof field !== "string")
    ) authorizationRefused();
    const changed = [...Object.keys(set), ...unset];
    if (
      changed.some((field) =>
        ["id", "namespace", "createdAt", "updatedAt"].includes(field)
      )
    ) authorizationRefused();
    fields(policy, changed);
    return input;
  }
  if (intent.method === "command") {
    const input = record(args.input ?? {});
    if (Object.hasOwn(input, "id")) authorizationRefused();
    fields(policy, Object.keys(input).filter((field) => field !== "id"));
    return { ...args, input: inserted(input, policy.input) };
  }
  return args;
}
