/** Track the JSON observations a policy makes, without retaining caller objects. */
import { captureHostCommandJson } from "../application/host-command-json.ts";

type Path = readonly string[];
export type PolicyReadPath = Readonly<{ path: Path; kind: "value" | "shape" }>;
export type PolicyReadSet = readonly PolicyReadPath[];
type JsonObject = Record<string, unknown> | unknown[];
function object(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object";
}
function at(root: unknown, path: Path): unknown {
  for (const key of path) {
    if (!object(root) || !Object.hasOwn(root, key)) return undefined;
    root = Reflect.get(root, key);
  }
  return root;
}
function observed(value: unknown, kind: PolicyReadPath["kind"]): unknown {
  if (value === undefined) return ["missing"];
  if (object(value) && kind === "shape") {
    return [Array.isArray(value) ? "array" : "object"];
  }
  return ["value", value];
}
export function policyReadValues(root: unknown, reads: PolicyReadSet): string {
  // Enumeration order is observable through Object.keys and JSON.stringify.
  return JSON.stringify(
    reads.map(({ path, kind }) => observed(at(root, path), kind)),
  );
}

export function trackPolicyReads(values: Record<string, unknown>) {
  // JSON snapshots have no aliases, accessors, prototypes or caller-owned state.
  const snapshot = captureHostCommandJson(values) as Record<string, unknown>;
  let active = true;
  const lifetime = { valid: true };
  const paths = new Map<string, PolicyReadPath>();
  const proxies = new Map<string, object>();
  const proxyIdentities = new WeakSet<object>();
  const remember = (path: Path, kind: PolicyReadPath["kind"]) => {
    if (!active) {
      lifetime.valid = false;
      return;
    }
    paths.set(JSON.stringify([path, kind]), { path, kind });
  };
  const unsupported = () => {
    lifetime.valid = false;
  };
  const wrap = (value: unknown, path: Path): unknown => {
    if (!object(value)) return value;
    const identity = JSON.stringify(path);
    const saved = proxies.get(identity);
    if (saved) return saved;
    // Ordinary property access wraps only the inspected path. Reflection
    // materializes one frozen level with child proxies, preserving descriptor
    // invariants without traversing unobserved payloads or history rows.
    const target = Array.isArray(value) ? [] : {};
    let prepared = false;
    const prepare = () => {
      if (prepared) return;
      prepared = true;
      for (const key of Object.keys(value)) {
        Object.defineProperty(target, key, {
          value: wrap(Reflect.get(value, key), [...path, key]),
          enumerable: true,
          configurable: false,
          writable: false,
        });
      }
      Object.freeze(target);
    };
    const proxy = new Proxy(target, {
      get(_target, key, receiver) {
        if (typeof key === "symbol") {
          if (key === Symbol.iterator && Array.isArray(value)) {
            remember(path, "shape");
            return Array.prototype[Symbol.iterator];
          }
          unsupported();
          return Reflect.get(value, key, receiver);
        }
        const child = [...path, key];
        if (Object.hasOwn(value, key)) {
          const result = Reflect.get(value, key);
          remember(child, object(result) ? "shape" : "value");
          return wrap(result, child);
        }
        remember(child, "value");
        if (
          key === "__proto__" || key === "constructor" && !Array.isArray(value)
        ) {
          unsupported();
        }
        // Native JSON object/array methods operate on the proxy receiver, so
        // their element/property reads are observed too.
        return Reflect.get(value, key, receiver);
      },
      has(_target, key) {
        if (typeof key !== "string") unsupported();
        else remember([...path, key], "value");
        return key in value;
      },
      ownKeys() {
        remember(path, "value");
        return Reflect.ownKeys(value);
      },
      isExtensible() {
        prepare();
        return false;
      },
      getOwnPropertyDescriptor(_target, key) {
        if (typeof key !== "string") {
          unsupported();
          return undefined;
        }
        remember([...path, key], "value");
        prepare();
        return Object.getOwnPropertyDescriptor(target, key);
      },
      getPrototypeOf() {
        unsupported();
        remember(path, "value");
        return Object.getPrototypeOf(value);
      },
      set() {
        unsupported();
        return false;
      },
      defineProperty(_target, key, descriptor) {
        unsupported();
        prepare();
        return Reflect.defineProperty(target, key, descriptor);
      },
      deleteProperty(_target, key) {
        unsupported();
        prepare();
        return Reflect.deleteProperty(target, key);
      },
      setPrototypeOf(_target, prototype) {
        unsupported();
        prepare();
        return Reflect.setPrototypeOf(target, prototype);
      },
      preventExtensions() {
        unsupported();
        prepare();
        return true;
      },
    });
    proxies.set(identity, proxy);
    proxyIdentities.add(proxy);
    return proxy;
  };
  const all = () => {
    for (const name of Object.keys(snapshot)) remember([name], "value");
  };
  const known = new WeakSet<object>();
  const escapes = (value: unknown): boolean => {
    if (!object(value)) return false;
    if (proxyIdentities.has(value)) return true;
    if (known.has(value)) return false;
    known.add(value);
    return Object.values(Object.getOwnPropertyDescriptors(value)).some((d) =>
      "value" in d && escapes(d.value)
    );
  };
  return {
    lifetime,
    escapes(value: unknown) {
      if (escapes(value)) unsupported();
    },
    value<T>(name: string): T {
      remember([name], object(snapshot[name]) ? "shape" : "value");
      return wrap(snapshot[name], [name]) as T;
    },
    all,
    context<T extends object>(value: T): T {
      // Reflection over the mixed context observes all JSON inputs. It does
      // not invoke accessors such as commandTime; ordinary spread does.
      return new Proxy(value, {
        ownKeys(target) {
          all();
          return Reflect.ownKeys(target);
        },
      });
    },
    finish() {
      active = false;
      // A whole-subtree observation subsumes its descendant reads. In particular,
      // spreading a large input must not serialize it once per property as well.
      const reads = [...paths.values()].filter(({ path, kind }) => {
        for (let length = 0; length <= path.length; length++) {
          if (length === path.length && kind === "value") continue;
          if (paths.has(JSON.stringify([path.slice(0, length), "value"]))) {
            return false;
          }
        }
        return true;
      }).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
      return { reads, values: policyReadValues(snapshot, reads), lifetime };
    },
  };
}
