import { chargeJsonString } from "../data-only-json.ts";
import {
  awaitOperation,
  isActionContinuation,
} from "../actions/continuation.ts";
/** Bounded, data-only owner capability protocol. No executable values cross it. */
import { ActionError } from "../actions/errors.ts";
import { markNonRetryable } from "../failure.ts";

export const OWNER_CAPABILITY_WORKLOAD = "copilotz.owner.capability.v1";
export const OWNER_CAPABILITY_BYTES = 1024 * 1024;
export const OWNER_CAPABILITY_NODES = 100_000;
export const OWNER_CAPABILITY_DEPTH = 64;
export type CapabilityPath = readonly string[];
export type CapabilityCall = Readonly<{
  kind:
    | "open"
    | "next"
    | "complete"
    | "call"
    | "transaction"
    | "read"
    | "close"
    | "receipt";
  name?: string;
  id?: string;
  context?: string;
  path?: CapabilityPath;
  args?: readonly unknown[];
  value?: unknown;
  error?: unknown;
  plan?: readonly Readonly<
    { path: CapabilityPath; args: readonly unknown[] }
  >[];
  options?: Readonly<Record<string, unknown>>;
  receipt?: Readonly<{ key: string; databaseSchema: string; intent?: unknown }>;
}>;
export type CapabilityInvocation = Readonly<{
  id: string;
  context: string;
  kind:
    | "processor"
    | "processorError"
    | "action"
    | "resume"
    | "reconcile"
    | "prepare";
  alias: string;
  args: readonly unknown[];
  scope: Readonly<Record<string, unknown>>;
}>;
export type CapabilityPoll = Readonly<{
  invocation?: CapabilityInvocation;
  aborted?: string;
  done?: boolean;
  result?: unknown;
  error?: unknown;
}>;

export function capabilityError(code: string, message = code): Error {
  return Object.assign(new Error(message), { code });
}

// Capture built-in accessors once: special values may have hostile own methods.
const dateTime = Date.prototype.getTime;
const dateISO = Date.prototype.toISOString;
const typedArrayLength = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype),
  "length",
)!.get!;
const copyBytes = Uint8Array.prototype.set;

/** Copies only own data properties; accessors and prototypes never execute. */
export function encodeCapability(value: unknown): Uint8Array {
  let nodes = 0, remaining = OWNER_CAPABILITY_BYTES;
  const charge = (bytes: number) => {
    remaining -= bytes;
    if (remaining < 0) throw capabilityError("owner_data_limit");
  };
  const string = (value: string) => chargeJsonString(value, remaining, charge);
  const ancestors = new Set<object>();
  const visit = (
    value: unknown,
    depth: number,
    plainContinuation = false,
  ): unknown => {
    if (++nodes > OWNER_CAPABILITY_NODES || depth > OWNER_CAPABILITY_DEPTH) {
      throw capabilityError("owner_data_limit");
    }
    if (value === undefined) {
      charge(3);
      return [0];
    }
    if (typeof value === "string") {
      charge(4);
      return [1, string(value)];
    }
    if (value === null || typeof value === "boolean") {
      charge(4 + String(value).length);
      return [1, value];
    }
    if (
      typeof value === "number" && Number.isFinite(value) &&
      !Object.is(value, -0)
    ) {
      charge(4 + String(value).length);
      return [1, value];
    }
    if (!plainContinuation && isActionContinuation(value)) {
      charge(4);
      // Traverse the original descriptors rather than spreading and invoking getters.
      return [7, visit(value, depth + 1, true)];
    }
    if (value instanceof Date) {
      if (!Number.isFinite(dateTime.call(value))) {
        throw capabilityError("owner_data_invalid");
      }
      charge(4);
      return [6, string(dateISO.call(value))];
    }
    if (value instanceof Uint8Array) {
      const length = typedArrayLength.call(value) as number;
      if (length > OWNER_CAPABILITY_BYTES / 2) {
        throw capabilityError("owner_data_limit");
      }
      charge(6 + 4 * Math.ceil(length / 3));
      // Typed-array set reads the internal buffer, without iterator/species hooks.
      const owned = new Uint8Array(length);
      copyBytes.call(owned, value);
      let bytes = "";
      for (let index = 0; index < length; index += 8192) {
        const chunk: number[] = [];
        for (
          let offset = index;
          offset < Math.min(length, index + 8192);
          offset++
        ) {
          chunk.push(owned[offset]);
        }
        bytes += String.fromCharCode(...chunk);
      }
      return [4, btoa(bytes)];
    }
    if (value instanceof Error) {
      const property = (key: string, fallback: unknown): unknown => {
        let source: object | null = value;
        while (source) {
          const descriptor = Object.getOwnPropertyDescriptor(source, key);
          if (descriptor) {
            if (!("value" in descriptor)) {
              throw capabilityError("owner_data_invalid");
            }
            return descriptor.value;
          }
          source = Object.getPrototypeOf(source);
        }
        return fallback;
      };
      const code = property("code", null),
        name = property("name", "Error"),
        message = property("message", ""),
        status = value instanceof ActionError ? property("status", null) : null;
      if (
        typeof name !== "string" || typeof message !== "string" ||
        status !== null &&
          (typeof status !== "number" || !Number.isInteger(status))
      ) {
        throw capabilityError("owner_data_invalid");
      }
      const disposition = () => {
        let current: unknown = value, causeDepth = depth;
        const seen = new Set<object>();
        while (
          current &&
          (typeof current === "object" || typeof current === "function")
        ) {
          if (seen.has(current)) return null;
          seen.add(current);
          if (
            current !== value &&
            (++nodes > OWNER_CAPABILITY_NODES ||
              ++causeDepth > OWNER_CAPABILITY_DEPTH)
          ) {
            throw capabilityError("owner_data_limit");
          }
          const marker = Object.getOwnPropertyDescriptor(current, "retryable");
          if (marker && !("value" in marker)) {
            throw capabilityError("owner_data_invalid");
          }
          if (marker && typeof marker.value === "boolean") {
            return marker.value;
          }
          const cause = Object.getOwnPropertyDescriptor(current, "cause");
          if (!cause) return null;
          if (!("value" in cause)) throw capabilityError("owner_data_invalid");
          current = cause.value;
        }
        return null;
      };
      const retryable = disposition();
      const hint = property("retryAfterMs", null);
      const retryAfterMs = typeof hint === "number" && Number.isFinite(hint)
        ? Math.min(30_000, Math.max(0, hint))
        : null;
      charge(
        9 + String(retryable).length + String(status).length +
          String(retryAfterMs).length,
      );
      string(name);
      string(message);
      if (typeof code === "string") string(code);
      else charge(4);
      return [
        5,
        name,
        message,
        typeof code === "string" ? code : null,
        retryable,
        status,
        retryAfterMs,
      ];
    }
    if (!value || typeof value !== "object" || ancestors.has(value)) {
      throw capabilityError("owner_data_invalid");
    }
    const array = Array.isArray(value);
    if (
      !array && Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null
    ) throw capabilityError("owner_data_invalid");
    charge(6);
    ancestors.add(value);
    try {
      const entries: unknown[] = [];
      for (const key of Reflect.ownKeys(value)) {
        if (array && key === "length") continue;
        const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
        if (
          typeof key !== "string" || !("value" in descriptor) ||
          !descriptor.enumerable
        ) {
          throw capabilityError("owner_data_invalid");
        }
        if (
          array &&
          (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) !== entries.length)
        ) {
          throw capabilityError("owner_data_invalid");
        }
        if (entries.length) charge(1);
        if (!array) {
          charge(3);
          string(key);
        }
        const child = visit(descriptor.value, depth + 1);
        entries.push(array ? child : [key, child]);
      }
      if (array && entries.length !== value.length) {
        throw capabilityError("owner_data_invalid");
      }
      return [array ? 2 : 3, entries];
    } finally {
      ancestors.delete(value);
    }
  };
  const bytes = new TextEncoder().encode(JSON.stringify(visit(value, 0)));
  if (bytes.length > OWNER_CAPABILITY_BYTES) {
    throw capabilityError("owner_data_limit");
  }
  return bytes;
}

export function decodeCapability(bytes: Uint8Array): unknown {
  if (bytes.length > OWNER_CAPABILITY_BYTES) {
    throw capabilityError("owner_data_limit");
  }
  const input: unknown = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(bytes),
  );
  let nodes = 0;
  const visit = (value: unknown, depth: number): unknown => {
    if (++nodes > OWNER_CAPABILITY_NODES || depth > OWNER_CAPABILITY_DEPTH) {
      throw capabilityError("owner_data_limit");
    }
    if (!Array.isArray(value)) throw capabilityError("owner_data_invalid");
    const [tag, body] = value;
    if (tag === 0 && value.length === 1) return undefined;
    if (
      tag === 1 && value.length === 2 &&
      (body === null || typeof body === "string" || typeof body === "boolean" ||
        typeof body === "number" && Number.isFinite(body))
    ) return body;
    if (tag === 7 && value.length === 2) {
      return awaitOperation(
        visit(body, depth + 1) as Parameters<typeof awaitOperation>[0],
      );
    }
    if (
      tag === 6 && value.length === 2 && typeof body === "string" &&
      Number.isFinite(Date.parse(body))
    ) return new Date(body);
    if (tag === 4 && value.length === 2 && typeof body === "string") {
      return Uint8Array.from(atob(body), (byte) => byte.charCodeAt(0));
    }
    if (
      tag === 5 && value.length === 7 && typeof body === "string" &&
      typeof value[2] === "string" &&
      (value[4] === null || typeof value[4] === "boolean") &&
      (value[6] === null ||
        typeof value[6] === "number" && Number.isFinite(value[6]) &&
          value[6] >= 0 && value[6] <= 30_000)
    ) {
      const error = Object.assign(
        body === "ActionError" && typeof value[3] === "string" &&
          Number.isInteger(value[5])
          ? new ActionError(value[2], { code: value[3], status: value[5] })
          : new Error(value[2]),
        {
          name: body,
          ...(typeof value[3] === "string" ? { code: value[3] } : {}),
        },
      );
      if (value[6] !== null) Object.assign(error, { retryAfterMs: value[6] });
      return value[4] === false
        ? markNonRetryable(error)
        : value[4] === true
        ? Object.assign(error, { retryable: true })
        : error;
    }
    if (value.length !== 2 || !Array.isArray(body)) {
      throw capabilityError("owner_data_invalid");
    }
    if (tag === 2) return body.map((item) => visit(item, depth + 1));
    if (tag !== 3) throw capabilityError("owner_data_invalid");
    const result: Record<string, unknown> = {};
    for (const entry of body) {
      if (
        !Array.isArray(entry) || entry.length !== 2 ||
        typeof entry[0] !== "string" || Object.hasOwn(result, entry[0])
      ) throw capabilityError("owner_data_invalid");
      Object.defineProperty(result, entry[0], {
        value: visit(entry[1], depth + 1),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return result;
  };
  return visit(input, 0);
}

export async function readCapability(
  input: ReadableStream<Uint8Array>,
): Promise<unknown> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of input) {
    size += chunk.length;
    if (size > OWNER_CAPABILITY_BYTES) {
      throw capabilityError("owner_data_limit");
    }
    chunks.push(chunk);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return decodeCapability(bytes);
}
