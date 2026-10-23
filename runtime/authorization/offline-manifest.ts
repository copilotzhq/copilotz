import { dataProperties, walkDataOnly } from "../data-only-json.ts";

/** Detached data-only snapshot of an offline inventory, without an online request's aggregate budget. */
export function captureOfflineManifest<T>(value: T): T {
  const invalid = (): never => {
    throw new TypeError(
      "Offline manifests require finite, acyclic plain JSON data.",
    );
  };
  return walkDataOnly(value, {
    value(value, depth) {
      if (depth > 64) {
        throw new RangeError("Offline manifest is too deeply nested.");
      }
      if (
        value === null || typeof value === "string" ||
        typeof value === "boolean"
      ) return value;
      if (typeof value === "number" && Number.isFinite(value)) {
        return Object.is(value, -0) ? 0 : value;
      }
      if (value && typeof value === "object") return dataProperties;
      return invalid();
    },
    cycle: invalid,
    properties(value, array, visit) {
      if (!array && Object.getPrototypeOf(value) !== Object.prototype) {
        invalid();
      }
      const keys = Reflect.ownKeys(value);
      if (array) {
        const input = value as unknown[];
        if (keys.length !== input.length + 1) invalid();
        for (let i = 0; i < input.length; i++) {
          const property = Object.getOwnPropertyDescriptor(value, String(i));
          if (!property || !("value" in property)) return invalid();
          visit(String(i), property.value);
        }
      } else {
        for (const key of keys) {
          if (typeof key !== "string") return invalid();
          const property = Object.getOwnPropertyDescriptor(value, key)!;
          if (!("value" in property) || !property.enumerable) invalid();
          visit(key, property.value);
        }
      }
    },
  }, true) as T;
}
