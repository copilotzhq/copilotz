/** Defines runtime-neutral prompt Context Resources. @module */

import type { ContextResource } from "../../shared/types.ts";

function requiredText(value: unknown, label: string): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) throw new TypeError(`${label} must be non-empty.`);
  return normalized;
}

/** Defines one runtime-neutral application context contributor. */
export function defineContextResource(
  resource: ContextResource,
): ContextResource {
  const id = requiredText(resource.id, "Context resource id");
  if (resource.type !== "context") {
    throw new TypeError(`Context resource '${id}' must have type 'context'.`);
  }
  if (!resource.purposes.length) {
    throw new TypeError(`Context resource '${id}' requires a purpose.`);
  }
  if (resource.purposes.some((purpose) => purpose !== "conversation")) {
    throw new TypeError(`Context resource '${id}' has an invalid purpose.`);
  }
  if (typeof resource.contribute !== "function") {
    throw new TypeError(`Context resource '${id}' requires contribute().`);
  }
  return ({
    id,
    type: "context",
    purposes: [...new Set(resource.purposes)] as const,
    contribute: resource.contribute,
    ...(resource.compact ? { compact: resource.compact } : {}),
  } as const);
}

export function isContextResource(value: unknown): value is ContextResource {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<ContextResource>;
  return typeof candidate.id === "string" && candidate.type === "context" &&
    Array.isArray(candidate.purposes) &&
    typeof candidate.contribute === "function";
}

export {
  collectContextContributions,
  type CollectedContextContribution,
  prepareContextContributions,
  renderContextContent,
} from "../../shared/contributions.ts";
export type {
  ContextContribution,
  ContextContributionInput,
  ContextPurpose,
  ContextResource,
  ContextSourceRef,
  FrozenContextContribution,
} from "../../shared/types.ts";
