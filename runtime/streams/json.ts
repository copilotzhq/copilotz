type JsonValue = null | boolean | number | string | readonly JsonValue[] | {
  readonly [key: string]: JsonValue;
};

/** Captures data once, without invoking user getters, iterators or toJSON. */
export function snapshotStreamMetadata(
  value: unknown,
  limits: Readonly<
    { maxDepth?: number; maxNodes?: number; maxBytes?: number }
  > = {},
): Readonly<Record<string, unknown>> {
  const ancestors = new Set<object>();
  let nodes = 0;
  const fail = (): never => {
    throw new TypeError("Stream metadata must be bounded plain JSON data.");
  };
  const visit = (item: unknown, depth: number): JsonValue => {
    if (
      ++nodes > (limits.maxNodes ?? 100_000) || depth > (limits.maxDepth ?? 64)
    ) fail();
    if (
      item === null || typeof item === "boolean" || typeof item === "string"
    ) return item;
    if (typeof item === "number" && Number.isFinite(item)) return item;
    if (!item || typeof item !== "object" || ancestors.has(item)) return fail();
    const array = Array.isArray(item);
    if (
      Object.getPrototypeOf(item) !==
        (array ? Array.prototype : Object.prototype)
    ) fail();
    const descriptors = Object.getOwnPropertyDescriptors(item);
    const names = Reflect.ownKeys(descriptors);
    if (names.some((name) => typeof name !== "string")) fail();
    ancestors.add(item);
    try {
      if (array) {
        const length = descriptors.length?.value;
        if (
          !Number.isSafeInteger(length) || length < 0 ||
          names.length !== length + 1 || length > (limits.maxNodes ?? 100_000)
        ) fail();
        const result: JsonValue[] = [];
        for (let index = 0; index < length; index++) {
          const d = descriptors[String(index)];
          if (!d || !d.enumerable || !("value" in d)) fail();
          result.push(visit(d.value, depth + 1));
        }
        return Object.freeze(result);
      }
      const result: Record<string, JsonValue> = {};
      for (const name of names as string[]) {
        const d = descriptors[name];
        if (!d.enumerable || !("value" in d)) fail();
        Object.defineProperty(result, name, {
          value: visit(d.value, depth + 1),
          enumerable: true,
        });
      }
      return Object.freeze(result);
    } finally {
      ancestors.delete(item);
    }
  };
  const snapshot = visit(value, 0);
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    fail();
  }
  if (
    new TextEncoder().encode(JSON.stringify(snapshot)).length >
      (limits.maxBytes ?? 64 * 1024)
  ) fail();
  return snapshot as Readonly<Record<string, unknown>>;
}
