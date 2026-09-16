import { assertJsonValue } from "../json.ts";
import type { ActionInvocationMetadata } from "./types.ts";

function invalidMetadata(path: string): never {
  throw new TypeError(
    `Action invocation metadata must be a strict JSON-safe object; invalid value at ${path}.`,
  );
}

/** Captures one canonical immutable Action invocation metadata snapshot. */
export function durableActionMetadata(
  value: unknown,
): ActionInvocationMetadata {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    invalidMetadata("metadata");
  }
  try {
    assertJsonValue(value);
  } catch (cause) {
    throw new TypeError(
      "Action invocation metadata must be a strict JSON-safe object.",
      { cause },
    );
  }
  return (ordered(value)) as ActionInvocationMetadata;
}

/** Normalizes one Action input/output to the exact JSON value EventBodyStore persists. */
export function durableActionValue(value: unknown): unknown {
  try {
    const text = JSON.stringify(value === undefined ? null : value);
    if (text === undefined) {
      throw new TypeError("Value is not JSON serializable.");
    }
    return (JSON.parse(text));
  } catch (cause) {
    throw new TypeError("Action input/output must be JSON serializable.", {
      cause,
    });
  }
}

function ordered(value: unknown): unknown {
  if (Object.is(value, -0)) return 0;
  if (Array.isArray(value)) return value.map(ordered);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
        .map(([key, child]) => [key, ordered(child)]),
    );
  }
  return value;
}

export function sameActionValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(ordered(durableActionValue(left))) ===
    JSON.stringify(ordered(durableActionValue(right)));
}
