import type { ContextResource } from "./types.ts";

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
  if (
    resource.purposes.some((purpose) =>
      purpose !== "conversation" && purpose !== "memory_consolidation"
    )
  ) {
    throw new TypeError(`Context resource '${id}' has an invalid purpose.`);
  }
  if (typeof resource.contribute !== "function") {
    throw new TypeError(`Context resource '${id}' requires contribute().`);
  }
  return Object.freeze({
    id,
    type: "context",
    purposes: Object.freeze([...new Set(resource.purposes)]),
    contribute: resource.contribute,
  });
}

export function isContextResource(value: unknown): value is ContextResource {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<ContextResource>;
  return typeof candidate.id === "string" && candidate.type === "context" &&
    Array.isArray(candidate.purposes) &&
    typeof candidate.contribute === "function";
}
