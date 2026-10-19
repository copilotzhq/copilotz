import { dataProperties, walkDataOnly } from "./data-only-json.ts";

type JsonOptions = {
  label?: string;
  omitUndefinedProperties?: boolean;
  rejectNegativeZero?: boolean;
  normalizeNegativeZero?: boolean;
  rejectPrototypeKey?: boolean;
  plainArrays?: boolean;
  allowBytes?: boolean;
  maxDepth?: number;
  maxNodes?: number;
};

/** Structural JSON validation with explicit boundary policies; never invokes getters. */
export function assertJsonValue(
  value: unknown,
  options: JsonOptions = {},
): void {
  jsonValue(value, options, false);
}

/** Ordered detached data using the same descriptor checks as validation. */
export function captureJsonValue(
  value: unknown,
  options: JsonOptions = {},
): unknown {
  return jsonValue(value, options, true);
}

/** Validate and encode finite JSON in one descriptor-aware traversal. */
export function encodeJsonValue(
  value: unknown,
  options: JsonOptions = {},
): string {
  return jsonValue(value, options, "json") as string;
}

function jsonValue(
  value: unknown,
  options: JsonOptions,
  capture: boolean | "json",
): unknown {
  const label = options.label ?? "Value";
  function fail(reason: string): never {
    throw new TypeError(`${label} ${reason}`);
  }
  return walkDataOnly(value, {
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
        return options.normalizeNegativeZero && Object.is(item, -0) ? 0 : item;
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
      if (
        array && options.plainArrays &&
        Object.getPrototypeOf(item) !== Array.prototype
      ) {
        fail("must contain plain JSON arrays.");
      }
      const keys = Reflect.ownKeys(item);
      if (capture && !array && keys.every((key) => typeof key === "string")) {
        keys.sort();
      }
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
        if (options.rejectPrototypeKey && key === "__proto__") {
          fail("cannot contain '__proto__'.");
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
  }, capture);
}
