/** Owner-created invocation bindings. No binding can be selected over a worker call. */
import { createAsyncContextStorage } from "../../dependencies/async-hooks.ts";
import { captureJsonValue } from "../json.ts";
import type { ProtectedActionSource } from "../actions/protected-action-types.ts";
import type { ActionInvocationFrame } from "../actions/invoker.ts";
import type { SqlExecutor } from "../events/session.ts";
import type {
  CollectionPolicyIntent,
  CollectionPolicyInvocation,
} from "./intent.ts";

type OwnerBinding = Readonly<{
  /** Direct ingress has no executing Action, Processor or alarm identity. */
  direct?: boolean;
  /** Minted only by the in-process host surface, never by a wire binding. */
  trustedHost?: boolean;
  /** Worker-local forwarding to the opaque context retained by the owner. */
  callHostCapability?(
    path: readonly string[],
    args: readonly unknown[],
    scope: Readonly<{ databaseSchema: string; namespace: string }>,
  ): Promise<unknown>;
  authority?: import("./authority.ts").AuthenticatedAuthority;
  /** Owner-resolved logical Processor run, independent of its current attempt. */
  logicalRunId?: string;
  operationId?: string;
  sourceEventId?: string;
  sourceDeliveryId?: string;
  scope: Readonly<{ databaseSchema: string; namespace: string }>;
  signal: AbortSignal;
  resolveSource(transaction: SqlExecutor): Promise<ProtectedActionSource>;
  assertCurrent?(
    read: Readonly<{ transaction: SqlExecutor; commandTime: string }>,
    invocation: CollectionPolicyInvocation,
  ): Promise<void>;
}>;
export type CollectionInvocationAuthority =
  & OwnerBinding
  & Readonly<{
    invocation: CollectionPolicyInvocation;
    check(): void;
    /** Owner-created bounded directory delegation; never serialized. */
    authorizeDirectoryIntent?(
      intent: CollectionPolicyIntent,
      read: Readonly<{ transaction: SqlExecutor; commandTime: string }>,
    ): Promise<import("./contracts.ts").ServerConstraints>;
    authorizeIntent?(
      intent: CollectionPolicyIntent,
      read: Readonly<{ transaction: SqlExecutor; commandTime: string }>,
    ): Promise<void>;
  }>;
type Binding = CollectionInvocationAuthority & { root: object; close(): void };
type CallScope = { authority: Binding; active: boolean };
const calls = /* @__PURE__ */ createAsyncContextStorage<
  CallScope | undefined
>();
const contexts = new WeakMap<object, Binding>();
const commandAuthorities = new WeakMap<
  CollectionInvocationAuthority,
  CollectionInvocationAuthority
>();
const trustedReads = /* @__PURE__ */ createAsyncContextStorage<
  { active: boolean } | undefined
>();
function closed(): never {
  throw Object.assign(new Error("Collection invocation authority has ended."), {
    code: "ActionOwnershipLost",
  });
}
export function captureCollectionInvocation():
  | CollectionInvocationAuthority
  | undefined {
  const scope = calls.getStore();
  if (!scope) return undefined;
  if (!scope.active) closed();
  scope.authority.check();
  return scope.authority;
}
export const withoutCollectionPolicyInvocation = <T>(
  run: () => T | Promise<T>,
): Promise<T> => calls.run(undefined, () => trustedReads.run(undefined, run));

/** Unwrap a call scope only for owner command authorization. */
export function collectionInvocationOwner(
  authority: CollectionInvocationAuthority,
) {
  return commandAuthorities.get(authority) ?? authority;
}

function bind<T extends object>(context: T, binding: Binding): T {
  const cache = new WeakMap<object, object>();
  const wrap = (value: unknown): unknown => {
    if (!value || typeof value !== "object") return value;
    const hit = cache.get(value);
    if (hit) return hit;
    // Owner RPC deliberately resolves own data descriptors rather than getters.
    // Materialize wrapped data descriptors so local and remote calls agree.
    const result = Object.create(Object.getPrototypeOf(value));
    cache.set(value, result);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    for (const key of Reflect.ownKeys(descriptors)) {
      const descriptor = Reflect.get(descriptors, key) as PropertyDescriptor;
      if (!("value" in descriptor)) continue;
      const member = descriptor.value;
      if (typeof member !== "function") {
        if (key !== "definition") descriptor.value = wrap(member);
        continue;
      }
      descriptor.value = (...args: unknown[]) => {
        binding.check();
        const previous = calls.getStore();
        if (previous && !previous.active) closed();
        const authority = previous?.authority.root === binding.root &&
            previous.authority.invocation.kind === "action" &&
            binding.invocation.kind === "processor"
          ? previous.authority
          : binding;
        const scope: CallScope = { authority, active: true };
        if (
          (key === "transaction" || key === "read") &&
          typeof args[0] === "function"
        ) {
          const callback = args[0] as (value: object) => unknown;
          args[0] = (value: object) => callback(surface(value, authority));
        }
        return calls.run(scope, async () => {
          try {
            authority.check();
            const result = await Reflect.apply(member, value, args);
            authority.check();
            return result;
          } finally {
            scope.active = false;
          }
        });
      };
    }
    return Object.defineProperties(result, descriptors);
  };
  const surface = (value: object, authority: Binding): object => {
    if (authority !== binding) return bind(value, authority);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    for (
      const key of [
        "collections",
        "vectors",
        "relations",
        "sessions",
        "flows",
        "directory",
        "authentication",
      ]
    ) {
      if (descriptors[key] && "value" in descriptors[key]) {
        descriptors[key] = {
          ...descriptors[key],
          value: wrap(descriptors[key].value),
        };
      }
    }
    for (const key of ["transaction", "read"]) {
      if (descriptors[key] && "value" in descriptors[key]) {
        descriptors[key] = {
          ...descriptors[key],
          value: Reflect.get(
            wrap({ [key]: descriptors[key].value }) as object,
            key,
          ),
        };
      }
    }
    return Object.defineProperties({}, descriptors);
  };
  const result = surface(context, binding) as T;
  contexts.set(result, binding);
  return result;
}
function binding(
  owner: OwnerBinding,
  invocation: CollectionPolicyInvocation,
  root: object,
): Binding {
  let active = true;
  return {
    ...owner,
    scope: Object.freeze({ ...owner.scope }),
    invocation: Object.freeze({ ...invocation }),
    root,
    check() {
      owner.signal.throwIfAborted();
      if (!active) closed();
    },
    close() {
      active = false;
    },
  };
}
/** Fixed internal authority scopes one owner-selected operation, never worker metadata. */
export async function withOwnerCollectionInvocation<T>(
  authority: CollectionInvocationAuthority,
  run: () => T | Promise<T>,
): Promise<T> {
  let active = true;
  const owner = Object.freeze({
    ...authority,
    scope: Object.freeze({ ...authority.scope }),
    invocation: captureJsonValue(
      authority.invocation,
      { label: "Owner invocation", maxDepth: 64, maxNodes: 100_000 },
    ) as CollectionPolicyInvocation,
  });
  const bound: Binding = {
    ...owner,
    root: (authority as Partial<Binding>).root ?? {},
    check() {
      owner.check();
      if (!active) closed();
    },
    close() {
      active = false;
    },
  };
  commandAuthorities.set(bound, owner);
  const scope: CallScope = { authority: bound, active: true };
  try {
    return await calls.run(scope, () => {
      const value = run();
      if (!(value instanceof Promise)) {
        scope.active = false;
        active = false;
      }
      return value;
    });
  } finally {
    scope.active = false;
    active = false;
  }
}
/** Execute user code with the same revocable authority as its context proxies. */
export function withContextCollectionInvocation<T>(
  context: object,
  run: () => T | Promise<T>,
): Promise<T> {
  const authority = contexts.get(context);
  return authority
    ? withOwnerCollectionInvocation(authority, run)
    : Promise.resolve().then(run);
}

export function bindOwnerCollectionInvocation<T extends object>(
  context: T,
  owner: OwnerBinding,
  invocation: CollectionPolicyInvocation,
): T {
  return bind(context, binding(owner, invocation, {}));
}
export const bindProcessorCollectionInvocation = bindOwnerCollectionInvocation;
/** RPC methods already enforce lifetime and track their own staged promises. */
export function bindWorkerCollectionInvocation<T extends object>(
  context: T,
  owner: OwnerBinding,
  invocation: CollectionPolicyInvocation,
): T {
  contexts.set(context, binding(owner, invocation, {}));
  return context;
}
export function bindActionCollectionInvocation<T extends object>(
  context: T,
  host: object,
  frame: ActionInvocationFrame,
): T {
  const parent = contexts.get(host);
  if (!parent) return context;
  return bind(
    context,
    binding({ ...parent, direct: false, signal: frame.signal }, {
      kind: "action",
      id: frame.actionId,
      runId: frame.actionRunId,
      ...(frame.parentActionRunId
        ? { parentRunId: frame.parentActionRunId }
        : {}),
    }, parent.root),
  );
}
/** Preserve the same revocable binding when the trusted invoker adds capabilities. */
export function preserveCollectionInvocation<T extends object>(
  context: T,
  source: object,
): T {
  const authority = contexts.get(source);
  if (authority) {
    authority.check();
    contexts.set(context, authority);
  }
  return context;
}

/** Owner-only logical receipt identity; public context fields cannot select it. */
export function collectionReceiptInvocation(context: object):
  | Readonly<{
    scope: OwnerBinding["scope"];
    invocation: Readonly<
      { kind: "action" | "processor"; id: string; runId: string }
    >;
  }>
  | undefined {
  const authority = contexts.get(context);
  if (
    !authority ||
    (authority.invocation.kind !== "action" &&
      authority.invocation.kind !== "processor")
  ) return undefined;
  authority.check();
  const { kind, id } = authority.invocation;
  const runId = kind === "action"
    ? authority.invocation.runId
    : authority.logicalRunId;
  if (!runId) return undefined;
  return Object.freeze({
    scope: authority.scope,
    invocation: Object.freeze({ kind, id, runId }),
  });
}

export function closeCollectionPolicyInvocation(context: object): void {
  contexts.get(context)?.close();
}

/** Only the configured owner authentication/policy callbacks receive this scope. */
export async function withTrustedCollectionPolicyRead<T>(
  run: () => T | Promise<T>,
): Promise<T> {
  const scope = { active: true };
  try {
    return await trustedReads.run(scope, () => {
      const result = run();
      if (!(result instanceof Promise)) scope.active = false;
      return result;
    });
  } finally {
    scope.active = false;
  }
}
export function hasTrustedCollectionPolicyRead(): boolean {
  const scope = trustedReads.getStore();
  if (scope && !scope.active) closed();
  return !!scope && !calls.getStore();
}
