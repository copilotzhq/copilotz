import type { ActionInvocationMetadata } from "./types.ts";

function freezeValue<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) {
      freezeValue(child);
    }
    Object.freeze(value);
  }
  return value;
}

function invalidMetadata(path: string): never {
  throw new TypeError(
    `Action invocation metadata must be a strict JSON-safe object; invalid value at ${path}.`,
  );
}

function metadataValue(
  value: unknown,
  path: string,
  ancestors: WeakSet<object>,
): unknown {
  if (
    value === null || typeof value === "string" || typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) invalidMetadata(path);
    return Object.is(value, -0) ? 0 : value;
  }
  if (!value || typeof value !== "object") invalidMetadata(path);
  if (ancestors.has(value)) invalidMetadata(path);
  if (Object.getOwnPropertySymbols(value).length > 0) invalidMetadata(path);

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const keys = Object.keys(value);
      if (
        keys.length !== value.length ||
        keys.some((key, index) => key !== String(index))
      ) invalidMetadata(path);
      return Object.freeze(
        value.map((child, index) =>
          metadataValue(child, `${path}[${index}]`, ancestors)
        ),
      );
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      invalidMetadata(path);
    }
    const names = Object.getOwnPropertyNames(value);
    const entries = names.sort().map((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !("value" in descriptor)) {
        invalidMetadata(`${path}.${key}`);
      }
      return [
        key,
        metadataValue(descriptor.value, `${path}.${key}`, ancestors),
      ] as const;
    });
    return Object.freeze(Object.fromEntries(entries));
  } finally {
    ancestors.delete(value);
  }
}

/** Captures one canonical immutable Action invocation metadata snapshot. */
export function durableActionMetadata(
  value: unknown,
): ActionInvocationMetadata {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    invalidMetadata("metadata");
  }
  return metadataValue(
    value,
    "metadata",
    new WeakSet(),
  ) as ActionInvocationMetadata;
}

/** Normalizes one Action input/output to the exact JSON value EventBodyStore persists. */
export function durableActionValue(value: unknown): unknown {
  try {
    const text = JSON.stringify(value === undefined ? null : value);
    if (text === undefined) {
      throw new TypeError("Value is not JSON serializable.");
    }
    return freezeValue(JSON.parse(text));
  } catch (cause) {
    throw new TypeError("Action input/output must be JSON serializable.", {
      cause,
    });
  }
}

function ordered(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(ordered);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, ordered(child)]),
    );
  }
  return value;
}

export function sameActionValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(ordered(durableActionValue(left))) ===
    JSON.stringify(ordered(durableActionValue(right)));
}
