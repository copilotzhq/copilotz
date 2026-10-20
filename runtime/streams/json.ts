import { dataProperties, walkDataOnly } from "../data-only-json.ts";

/** Captures data once, without invoking user getters, iterators or toJSON. */
export function snapshotStreamMetadata(
  value: unknown,
  limits: Readonly<
    { maxDepth?: number; maxNodes?: number; maxBytes?: number }
  > = {},
): Readonly<Record<string, unknown>> {
  const fail = (): never => {
    throw new TypeError("Stream metadata must be bounded plain JSON data.");
  };
  const snapshot = walkDataOnly(value, {
    value(item, depth, nodes) {
      if (
        nodes > (limits.maxNodes ?? 100_000) || depth > (limits.maxDepth ?? 64)
      ) fail();
      if (
        item === null || typeof item === "boolean" || typeof item === "string"
      ) {
        return item;
      }
      if (typeof item === "number" && Number.isFinite(item)) return item;
      if (!item || typeof item !== "object") return fail();
      return dataProperties;
    },
    cycle: fail,
    properties(item, array, visit) {
      if (
        Object.getPrototypeOf(item) !==
          (array ? Array.prototype : Object.prototype)
      ) fail();
      const descriptors = Object.getOwnPropertyDescriptors(item);
      const names = Reflect.ownKeys(descriptors);
      if (names.some((name) => typeof name !== "string")) fail();
      if (array) {
        const length = descriptors.length?.value;
        if (
          !Number.isSafeInteger(length) || length < 0 ||
          names.length !== length + 1 || length > (limits.maxNodes ?? 100_000)
        ) fail();
        for (let index = 0; index < length; index++) {
          const d = descriptors[String(index)];
          if (!d || !d.enumerable || !("value" in d)) fail();
          visit(String(index), d.value);
        }
        return;
      }
      for (const name of names as string[]) {
        const d = descriptors[name];
        if (!d.enumerable || !("value" in d)) fail();
        visit(name, d.value);
      }
    },
  }, true);
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    fail();
  }
  if (
    new TextEncoder().encode(JSON.stringify(snapshot)).length >
      (limits.maxBytes ?? 64 * 1024)
  ) fail();
  return snapshot as Readonly<Record<string, unknown>>;
}
