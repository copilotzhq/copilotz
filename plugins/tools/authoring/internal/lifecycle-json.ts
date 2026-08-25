/** Validates and snapshots lossless JSON used by Tool lifecycles. @module */

function validate(
  value: unknown,
  label: string,
  path: string,
  ancestors: Set<object>,
): void {
  if (
    value === null || typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Object.is(value, -0)) {
      throw new TypeError(`${label} '${path}' is not lossless JSON.`);
    }
    return;
  }
  if (typeof value !== "object") {
    throw new TypeError(`${label} '${path}' is not lifecycle-safe JSON.`);
  }
  if (ancestors.has(value)) {
    throw new TypeError(`${label} '${path}' contains a cycle.`);
  }
  const isArray = Array.isArray(value);
  const prototype = Object.getPrototypeOf(value);
  if (!isArray && prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(
      `${label} '${path}' must use arrays and plain JSON objects only.`,
    );
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (isArray && key === "length") continue;
    if (typeof key !== "string") {
      throw new TypeError(`${label} '${path}' contains a symbol key.`);
    }
    if (isArray && !/^(?:0|[1-9][0-9]*)$/.test(key)) {
      throw new TypeError(
        `${label} '${path}' contains a non-JSON array property.`,
      );
    }
    const descriptor = descriptors[key];
    if (!descriptor.enumerable || !("value" in descriptor)) {
      throw new TypeError(
        `${label} '${path}.${key}' is not a plain JSON data property.`,
      );
    }
  }
  if (isArray && Object.keys(value).length !== value.length) {
    throw new TypeError(
      `${label} '${path}' contains an out-of-range array property.`,
    );
  }
  ancestors.add(value);
  try {
    if (isArray) {
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) {
          throw new TypeError(`${label} '${path}' contains a sparse array.`);
        }
        validate(value[index], label, `${path}[${index}]`, ancestors);
      }
      return;
    }
    for (const [key, child] of Object.entries(value)) {
      validate(child, label, `${path}.${key}`, ancestors);
    }
  } finally {
    ancestors.delete(value);
  }
}

/** Rejects values whose JSON encoding would be lossy or host-dependent. */
export function assertLosslessJson(value: unknown, label: string): void {
  validate(value, label, "$", new Set());
}

/** Copies a validated value into an immutable lifecycle-safe JSON tree. */
export function cloneLosslessJson<T>(value: T, label: string): T {
  assertLosslessJson(value, label);
  const clone = (candidate: unknown): unknown => {
    if (Array.isArray(candidate)) {
      return Object.freeze(candidate.map(clone));
    }
    if (candidate && typeof candidate === "object") {
      return Object.freeze(Object.fromEntries(
        Object.entries(candidate).map(([key, child]) => [key, clone(child)]),
      ));
    }
    return candidate;
  };
  return clone(value) as T;
}
