/** Carry owner-created policy into local and reverse-called Action capabilities. */
import {
  type OwnerCommandAuthorization,
  withoutOwnerCommandAuthorization,
  withOwnerCommandAuthorization,
} from "../engine/command-authorization.ts";
import { inheritActionCaller } from "./caller-identity.ts";
import type { ActionContext } from "./types.ts";
const readResourceOwners = new WeakMap<object, object>();
export function authorizeActionCapabilities(
  context: ActionContext,
  guard: OwnerCommandAuthorization,
  check: () => void,
  onError?: (error: unknown) => void,
  authorizeDisclosure?: () => Promise<void>,
  trackCleanup?: (pending: Promise<void>) => void,
): ActionContext {
  const owner = {};
  const delivered = new WeakSet<object>();
  const isReadResource = (value: unknown): value is object =>
    value instanceof ReadableStream ||
    value instanceof ReadableStreamDefaultReader ||
    value instanceof ReadableStreamBYOBReader;
  const own = (value: unknown) => {
    if (isReadResource(value) && !readResourceOwners.has(value)) {
      readResourceOwners.set(value, owner);
    }
  };
  const observeCleanup = (pending: Promise<unknown>): Promise<void> => {
    const settled = pending.then(() => undefined, () => undefined);
    // The invoker retains its physical assignment until this promise settles.
    // Merely handling a rejection would not preserve occupied capacity.
    trackCleanup?.(settled);
    return settled;
  };
  const disposeUndisclosed = (value: unknown) => {
    if (
      !isReadResource(value) || readResourceOwners.get(value) !== owner ||
      delivered.has(value)
    ) return;
    // Physical cleanup may be noncooperative. Start it without reviving a policy
    // lifetime; observe it until actual settlement, never treating timeout as release.
    const disposal = value instanceof ReadableStream
      ? () => ReadableStream.prototype.cancel.call(value)
      : value instanceof ReadableStreamDefaultReader
      ? () =>
        ReadableStreamDefaultReader.prototype.cancel.call(value).finally(() =>
          value.releaseLock()
        )
      : () =>
        ReadableStreamBYOBReader.prototype.cancel.call(value).finally(() =>
          (value as ReadableStreamBYOBReader).releaseLock()
        );
    try {
      void observeCleanup(Promise.resolve(disposal()));
    } catch { /* Already closed or otherwise undisposable. */ }
  };
  const cache = new WeakMap<object, object>();
  const streamHandles = new WeakSet<object>();
  const nativeStreams = new WeakSet<object>();
  const disclose = async () => {
    check();
    if (authorizeDisclosure) {
      await withoutOwnerCommandAuthorization(authorizeDisclosure);
    }
    check();
  };
  const call = (
    invoke: () => unknown,
    disclosure = true,
    cleanupOnFailure?: () => Promise<unknown>,
  ) => {
    const pending = (async () => {
      let acquired: unknown;
      try {
        if (disclosure) await disclose();
        const value = await withOwnerCommandAuthorization(guard, async () => {
          check();
          const result = acquired = await invoke();
          own(result);
          check();
          return result;
        });
        if (disclosure) await disclose();
        if (isReadResource(value)) delivered.add(value);
        return value;
      } catch (error) {
        disposeUndisclosed(acquired);
        // Reserve the physical cleanup tail before revocation wakes the invoker.
        if (cleanupOnFailure) {
          try {
            void observeCleanup(cleanupOnFailure());
          } catch { /* Already closed. */ }
        }
        onError?.(error);
        throw error;
      }
    })();
    // Reserve before returning the capability promise: even fire-and-forget
    // acquisition must keep the invocation occupied through late disposal.
    void observeCleanup(pending);
    return pending;
  };
  // Native piping consumes internally rather than through a public reader. Give
  // it an explicitly guarded source so every pull checks policy and lifetime.
  const pipingSource = (source: ReadableStream) => {
    let bytes = false;
    try {
      const probe = ReadableStream.prototype.getReader.call(source, {
        mode: "byob",
      });
      probe.releaseLock();
      bytes = true;
    } catch (error) {
      if (!(error instanceof TypeError)) throw error;
    }
    const reader = ReadableStream.prototype.getReader.call(
      source,
    ) as ReadableStreamDefaultReader<unknown>;
    const callbacks = {
      async pull(
        controller:
          | ReadableStreamDefaultController<unknown>
          | ReadableByteStreamController,
      ) {
        try {
          const item = await call(
            () => reader.read(),
            true,
            () => reader.cancel(),
          ) as ReadableStreamReadResult<unknown>;
          if (item.done) {
            reader.releaseLock();
            controller.close();
          } else controller.enqueue(item.value as Uint8Array<ArrayBuffer>);
        } catch (error) {
          controller.error(error);
          await observeCleanup(reader.cancel());
          reader.releaseLock();
        }
      },
      async cancel(reason: unknown) {
        // Native consumers may call the prototype directly, bypassing the
        // instance facade. Retain that cancellation at the underlying source.
        const cancellation = reader.cancel(reason);
        void observeCleanup(cancellation);
        try {
          await cancellation;
        } finally {
          reader.releaseLock();
        }
      },
    };
    return bytes
      ? new ReadableStream({ ...callbacks, type: "bytes" }, {
        highWaterMark: 0,
      })
      : new ReadableStream(callbacks, { highWaterMark: 0 });
  };
  const wrap = (
    value: unknown,
    receiver?: object,
    name?: PropertyKey,
  ): unknown => {
    if (!value || (typeof value !== "object" && typeof value !== "function")) {
      return value;
    }
    if (Array.isArray(value)) return value.map((item) => wrap(item));
    if (!receiver) {
      const existing = cache.get(value);
      if (existing) return existing;
    }
    if (value instanceof ReadableStream) {
      if (nativeStreams.has(value)) return value;
      const stream = pipingSource(value);
      nativeStreams.add(stream);
      readResourceOwners.set(stream, owner);
      delivered.add(stream);
      cache.set(value, stream);
      for (
        const key of [
          "getReader",
          "tee",
          "pipeThrough",
          "pipeTo",
          "cancel",
          "values",
          Symbol.asyncIterator,
        ] as const
      ) {
        const method = Reflect.get(ReadableStream.prototype, key);
        Object.defineProperty(stream, key, {
          configurable: true,
          value: (...args: unknown[]) => {
            const invoke = () => Reflect.apply(method, stream, args);
            if (key === "cancel") {
              const cancellation = Promise.resolve(invoke());
              void observeCleanup(cancellation);
              return cancellation.then(() => undefined);
            }
            check();
            if (key === "pipeTo") return call(invoke);
            const result = invoke();
            if (
              key === "getReader" || key === "values" ||
              key === Symbol.asyncIterator
            ) {
              streamHandles.add(result);
              own(result);
              if (isReadResource(result)) delivered.add(result);
            }
            return wrap(result);
          },
        });
      }
      return stream;
    }
    const methods = new Map<PropertyKey, unknown>();
    const cleanup = (
      target: object | undefined,
      key: PropertyKey | undefined,
    ) =>
      Boolean(
        target && streamHandles.has(target) &&
          ["cancel", "releaseLock", "return"].includes(key as string),
      );
    const invoke = (originalReceiver: unknown, args: unknown[]) => {
      if (cleanup(receiver, name)) {
        const result = Reflect.apply(
          value as (...args: unknown[]) => unknown,
          receiver,
          args,
        );
        if (name === "releaseLock") return undefined;
        const cancellation = Promise.resolve(result);
        void observeCleanup(cancellation);
        return cancellation.then(() =>
          name === "return" ? { done: true, value: undefined } : undefined
        );
      }
      check();
      const target = receiver ?? originalReceiver;
      const fn = value as (...args: unknown[]) => unknown;
      const run = () => Reflect.apply(fn, target, args);
      // A writer's offset is already-held local state, not an asynchronous read
      // or mutation. Preserve its synchronous contract at the wire boundary.
      if (
        name === "offset" && receiver &&
        typeof Reflect.get(receiver, "append") === "function" &&
        typeof Reflect.get(receiver, "abort") === "function"
      ) {
        const result = run();
        check();
        return result;
      }
      if (
        [
          "getReader",
          "getWriter",
          "releaseLock",
          "tee",
          "pipeThrough",
          "values",
          Symbol.asyncIterator,
        ].includes(name as string | symbol)
      ) {
        const result = run();
        check();
        return wrap(result);
      }
      return call(
        run,
        !(receiver && streamHandles.has(receiver) &&
          (name === "cancel" || name === "return")),
      ).then((result) => {
        if (
          typeof result === "function" || result === receiver ||
          result === value
        ) return wrap(result);
        if (
          result && typeof result === "object" &&
          (result instanceof ReadableStream ||
            ["append", "getReader", "read"].some((key) =>
              typeof Reflect.get(result, key) === "function"
            ))
        ) return wrap(result);
        return result;
      });
    };
    // Never proxy a frozen capability itself: wrapping a nonconfigurable value
    // violates Proxy invariants. This fresh facade has no immutable own slots.
    const target = typeof value === "function"
      ? (..._args: unknown[]) => {}
      : Object.create(Object.getPrototypeOf(value));
    const facade: object = new Proxy(target, {
      get(_target, key) {
        if (!cleanup(value, key)) check();
        const property = Reflect.get(value, key, value);
        if (typeof property !== "function") return wrap(property);
        if (!methods.has(key)) methods.set(key, wrap(property, value, key));
        return methods.get(key);
      },
      apply(_target, originalReceiver, args) {
        return invoke(originalReceiver, args);
      },
      ownKeys() {
        return Reflect.ownKeys(value);
      },
      getOwnPropertyDescriptor(_target, key): PropertyDescriptor | undefined {
        const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
        if (!descriptor) return;
        if ("value" in descriptor) {
          return {
            ...descriptor,
            configurable: true,
            value: Reflect.get(facade, key),
          };
        }
        return {
          enumerable: descriptor.enumerable,
          configurable: true,
          get: () => Reflect.get(facade, key),
        };
      },
      set() {
        throw new TypeError("Action capability is read-only.");
      },
      defineProperty() {
        throw new TypeError("Action capability is read-only.");
      },
      deleteProperty() {
        throw new TypeError("Action capability is read-only.");
      },
    });
    inheritActionCaller(value, facade);
    if (!receiver) cache.set(value, facade);
    return facade;
  };
  const descriptors = Object.getOwnPropertyDescriptors(context);
  for (
    const key of [
      "actions",
      "collections",
      "content",
      "streams",
      "vectors",
      "operations",
      "effect",
      "transaction",
      "readSnapshot",
      "progress",
    ]
  ) {
    if (descriptors[key] && "value" in descriptors[key]) {
      descriptors[key] = {
        ...descriptors[key],
        value: wrap(descriptors[key].value),
      };
    }
  }
  return Object.defineProperties({}, descriptors) as ActionContext;
}
