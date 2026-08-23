function freezeValue<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) {
      freezeValue(child);
    }
    Object.freeze(value);
  }
  return value;
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
