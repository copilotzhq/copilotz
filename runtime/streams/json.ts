type JsonValue = null | boolean | number | string | JsonValue[] | {
  readonly [key: string]: JsonValue;
};

export function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

function snapshotJson(
  value: unknown,
  ancestors = new Set<object>(),
): JsonValue {
  if (
    value === null || typeof value === "boolean" || typeof value === "string"
  ) {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (!value || typeof value !== "object") {
    throw new TypeError(
      "Stream output metadata must contain JSON values only.",
    );
  }
  if (ancestors.has(value)) {
    throw new TypeError("Stream output metadata must not contain cycles.");
  }
  if (Object.getOwnPropertySymbols(value).length) {
    throw new TypeError("Stream output metadata must not contain symbol keys.");
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) {
        throw new TypeError("Stream output metadata arrays must be plain.");
      }
      const names = Object.getOwnPropertyNames(value);
      if (names.length !== value.length + 1 || names.at(-1) !== "length") {
        throw new TypeError(
          "Stream output metadata arrays must be dense without extra keys.",
        );
      }
      const result: JsonValue[] = [];
      for (let index = 0; index < value.length; index++) {
        const key = String(index);
        if (names[index] !== key) {
          throw new TypeError("Stream output metadata arrays must be dense.");
        }
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
          throw new TypeError(
            "Stream output metadata must use enumerable data properties.",
          );
        }
        result.push(snapshotJson(descriptor.value, ancestors));
      }
      return deepFreeze(result);
    }
    if (Object.getPrototypeOf(value) !== Object.prototype) {
      throw new TypeError("Stream output metadata objects must be plain.");
    }
    const result: Record<string, JsonValue> = {};
    for (const key of Object.getOwnPropertyNames(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
        throw new TypeError(
          "Stream output metadata must use enumerable data properties.",
        );
      }
      Object.defineProperty(result, key, {
        value: snapshotJson(descriptor.value, ancestors),
        enumerable: true,
        configurable: false,
        writable: false,
      });
    }
    return deepFreeze(result);
  } finally {
    ancestors.delete(value);
  }
}

/** Captures stream metadata as immutable, transport-safe JSON without accessors. */
export function snapshotStreamMetadata(
  value: unknown,
): Readonly<Record<string, unknown>> {
  const snapshot = snapshotJson(value);
  if (Array.isArray(snapshot)) {
    throw new TypeError("Stream output metadata must be a plain object.");
  }
  return snapshot as Readonly<Record<string, unknown>>;
}
