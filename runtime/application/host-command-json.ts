import {
  chargeJsonString,
  dataProperties,
  walkDataOnly,
} from "../data-only-json.ts";
import type { HostCommandJson } from "./host-command-types.ts";

// Only this boundary's own deeply frozen outputs qualify. A caller-frozen
// object (or proxy around an output) still goes through descriptor validation.
const capturedJson = new WeakMap<
  object,
  { bytes: number; nodes: number; depth: number }
>();

/**
 * Copy data properties only; bound work before serialization or admission awaits.
 * `omitUndefinedProperties` is for caller arguments only, never for policy
 * output, where a dropped field would widen authority.
 */
export function captureHostCommandJson(
  value: unknown,
  options: { omitUndefinedProperties?: boolean } = {},
): HostCommandJson {
  let remaining = 1024 * 1024;
  const charge = (bytes: number) => {
    remaining -= bytes;
    if (remaining < 0) throw new RangeError("Host command JSON exceeds 1 MiB.");
  };
  const string = (value: string) => chargeJsonString(value, remaining, charge);
  const invalid = (): never => {
    throw new TypeError("Host commands require finite, acyclic JSON values.");
  };
  let skippedNodes = 0;
  let totalNodes = 0;
  let maxDepth = 0;
  const frames: { remaining: number; nodes: number; depth: number }[] = [];
  const captured = walkDataOnly(value, {
    value(value, depth, nodes) {
      const saved = value && typeof value === "object"
        ? capturedJson.get(value)
        : undefined;
      if (saved) skippedNodes += saved.nodes - 1;
      totalNodes = nodes + skippedNodes;
      maxDepth = Math.max(maxDepth, depth + (saved?.depth ?? 0));
      if (totalNodes > 100_000 || maxDepth > 64) {
        throw new RangeError("Host command JSON is too complex.");
      }
      const parent = frames.at(-1);
      if (parent) {
        parent.depth = Math.max(parent.depth, 1 + (saved?.depth ?? 0));
      }
      if (saved) {
        charge(saved.bytes);
        return value;
      }
      if (typeof value === "string") return string(value);
      if (value === null || typeof value === "boolean") {
        charge(5);
        return value;
      }
      if (typeof value === "number" && Number.isFinite(value)) {
        charge(String(value).length);
        return Object.is(value, -0) ? 0 : value;
      }
      if (!value || typeof value !== "object") return invalid();
      frames.push({ remaining, nodes: totalNodes, depth: 0 });
      return dataProperties;
    },
    captured(value) {
      const frame = frames.pop()!;
      capturedJson.set(value, {
        bytes: frame.remaining - remaining,
        nodes: totalNodes - frame.nodes + 1,
        depth: frame.depth,
      });
      const parent = frames.at(-1);
      if (parent) parent.depth = Math.max(parent.depth, 1 + frame.depth);
    },
    cycle: invalid,
    properties(value, array, visit) {
      if (!array && Object.getPrototypeOf(value) !== Object.prototype) {
        throw new TypeError("Host commands require plain JSON objects.");
      }
      const keys = Reflect.ownKeys(value);
      if (keys.length > 100_001) {
        throw new RangeError("Host command JSON is too complex.");
      }
      charge(2);
      if (array) {
        const input = value as unknown[];
        if (input.length > 100_000 || keys.length !== input.length + 1) {
          throw new TypeError("Host commands require dense JSON arrays.");
        }
        for (let i = 0; i < input.length; i++) {
          const property = Object.getOwnPropertyDescriptor(value, String(i));
          if (!property || !("value" in property)) {
            throw new TypeError("Host command accessors are forbidden.");
          }
          charge(1);
          visit(String(i), property.value);
        }
        return;
      }
      for (const key of keys) {
        if (typeof key !== "string") {
          throw new TypeError("Host command symbol keys are forbidden.");
        }
        const property = Object.getOwnPropertyDescriptor(value, key)!;
        if (!("value" in property) || !property.enumerable) {
          throw new TypeError(
            "Host commands require enumerable data properties.",
          );
        }
        if (property.value === undefined && options.omitUndefinedProperties) {
          continue;
        }
        string(key);
        charge(2);
        visit(key, property.value);
      }
    },
  }, true) as HostCommandJson;
  return captured;
}
