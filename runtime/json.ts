import { dataProperties, walkDataOnly } from "./data-only-json.ts";

/** Structural JSON validation with explicit boundary policies; never invokes getters. */
export function assertJsonValue(
  value: unknown,
  options: {
    label?: string;
    omitUndefinedProperties?: boolean;
    rejectNegativeZero?: boolean;
    allowBytes?: boolean;
    maxDepth?: number;
    maxNodes?: number;
  } = {},
): void {
  const label = options.label ?? "Value";
  function fail(reason: string): never {
    throw new TypeError(`${label} ${reason}`);
  }
  walkDataOnly(value, {
    value(item, depth, nodes) {
      if (nodes > (options.maxNodes ?? Infinity)) {
        fail("exceeds maximum JSON node count.");
      }
      if (depth > (options.maxDepth ?? Infinity)) {
        fail("exceeds maximum JSON depth.");
      }
      if (
        item === null || typeof item === "string" || typeof item === "boolean"
      ) {
        return item;
      }
      if (typeof item === "number") {
        if (
          !Number.isFinite(item) ||
          (options.rejectNegativeZero && Object.is(item, -0))
        ) fail("must contain lossless JSON numbers.");
        return item;
      }
      if (!item || typeof item !== "object") {
        fail("must contain lossless JSON values.");
      }
      if (options.allowBytes && item instanceof Uint8Array) return item;
      return dataProperties;
    },
    cycle: () => fail("cannot be cyclic."),
    properties(item, array, visit) {
      if (
        !array && Object.getPrototypeOf(item) !== Object.prototype &&
        Object.getPrototypeOf(item) !== null
      ) fail("must contain plain JSON objects.");
      const keys = Reflect.ownKeys(item);
      const input = item as unknown[];
      if (
        array && (keys.length !== input.length + 1 || !keys.includes("length"))
      ) {
        fail("arrays must be dense and contain no extra properties.");
      }
      for (const key of keys) {
        if (array && key === "length") continue;
        if (typeof key !== "string") fail("cannot contain symbol keys.");
        if (
          array && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= input.length)
        ) {
          fail("arrays must be dense and contain no extra properties.");
        }
        const descriptor = Object.getOwnPropertyDescriptor(item, key)!;
        if (!descriptor.enumerable || !("value" in descriptor)) {
          fail("must contain enumerable data properties only.");
        }
        if (
          !array && descriptor.value === undefined &&
          options.omitUndefinedProperties
        ) continue;
        visit(key, descriptor.value);
      }
    },
  }, false);
}
