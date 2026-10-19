import type { HostCommandJson } from "./host-command-types.ts";

/** Copy data properties only; bound work before serialization or admission awaits. */
export function captureHostCommandJson(value: unknown): HostCommandJson {
  let remaining = 1024 * 1024;
  let nodes = 0;
  const ancestors = new Set<object>();
  const charge = (bytes: number) => {
    remaining -= bytes;
    if (remaining < 0) throw new RangeError("Host command JSON exceeds 1 MiB.");
  };
  const string = (value: string) => {
    if (value.length > remaining) {
      throw new RangeError("Host command JSON exceeds 1 MiB.");
    }
    charge(2);
    for (let i = 0; i < value.length; i++) {
      const code = value.charCodeAt(i);
      if (code === 34 || code === 92) charge(2);
      else if (code < 32) charge([8, 9, 10, 12, 13].includes(code) ? 2 : 6);
      else if (code < 128) charge(1);
      else if (code < 2048) charge(2);
      else if (code >= 0xd800 && code <= 0xdbff) {
        const next = value.charCodeAt(i + 1);
        if (next >= 0xdc00 && next <= 0xdfff) {
          charge(4);
          i++;
        } else charge(6);
      } else if (code >= 0xdc00 && code <= 0xdfff) charge(6);
      else charge(3);
    }
    return value;
  };
  const visit = (value: unknown, depth: number): HostCommandJson => {
    if (++nodes > 100_000 || depth > 64) {
      throw new RangeError("Host command JSON is too complex.");
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
    if (!value || typeof value !== "object" || ancestors.has(value)) {
      throw new TypeError("Host commands require finite, acyclic JSON values.");
    }
    const array = Array.isArray(value);
    if (!array && Object.getPrototypeOf(value) !== Object.prototype) {
      throw new TypeError("Host commands require plain JSON objects.");
    }
    const keys = Reflect.ownKeys(value);
    if (keys.length > 100_001) {
      throw new RangeError("Host command JSON is too complex.");
    }
    ancestors.add(value);
    charge(2);
    try {
      if (array) {
        if (value.length > 100_000 || keys.length !== value.length + 1) {
          throw new TypeError("Host commands require dense JSON arrays.");
        }
        const result: HostCommandJson[] = [];
        for (let i = 0; i < value.length; i++) {
          const property = Object.getOwnPropertyDescriptor(value, String(i));
          if (!property || !("value" in property)) {
            throw new TypeError("Host command accessors are forbidden.");
          }
          charge(1);
          result.push(visit(property.value, depth + 1));
        }
        return Object.freeze(result);
      }
      const result: Record<string, HostCommandJson> = {};
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
        string(key);
        charge(2);
        Object.defineProperty(result, key, {
          value: visit(property.value, depth + 1),
          enumerable: true,
        });
      }
      return Object.freeze(result);
    } finally {
      ancestors.delete(value);
    }
  };
  return visit(value, 0);
}
