import {
  type ActionEffectClient,
  wrapEffectConfirmation,
} from "./effect-client.ts";
/** Carry owner-created policy into local and reverse-called Action capabilities. */
import {
  type OwnerCommandAuthorization,
  withoutOwnerCommandAuthorization,
  withOwnerCommandAuthorization,
} from "../engine/command-authorization.ts";
import { inheritActionCaller } from "./caller-identity.ts";
import {
  bindContentStreamCommands,
  inheritContentStreamFailure,
} from "../streams/stream.ts";
import type { ActionContext } from "./types.ts";
const readResourceOwners = new WeakMap<object, object>();
export function authorizeActionCapabilities(
  context: ActionContext,
  guard: OwnerCommandAuthorization | undefined,
  check: () => void,
  onError?: (error: unknown) => void,
  authorizeDisclosure?: () => Promise<void>,
  trackCleanup?: (pending: Promise<void>) => void,
): ActionContext {
  const owner = {};
  const delivered = new WeakSet<object>();
  const readResource = (value: unknown): ReadableStream | undefined =>
    value instanceof ReadableStream
      ? value
      : value && typeof value === "object" && "body" in value &&
          value.body instanceof ReadableStream
      ? value.body
      : undefined;
  const own = (value: unknown) => {
    if (value && typeof value === "object") {
      // Bind before the acquisition scope closes or post-open disclosure waits.
      // Scheduled work keeps this invocation's guard, with a fresh call lifetime.
      bindContentStreamCommands(
        value,
        <T>(run: () => T | Promise<T>) =>
          withoutOwnerCommandAuthorization(() => call(run)) as Promise<T>,
      );
    }
    const resource = readResource(value);
    if (resource && !readResourceOwners.has(resource)) {
      readResourceOwners.set(resource, owner);
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
    const resource = readResource(value);
    if (
      !resource || readResourceOwners.get(resource) !== owner ||
      delivered.has(resource)
    ) return;
    try {
      void observeCleanup(ReadableStream.prototype.cancel.call(resource));
    } catch { /* Already closed or otherwise undisposable. */ }
  };
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
    beforeDisclosure = false,
    cleanupOnFailure?: () => Promise<unknown>,
  ) => {
    const pending = (async () => {
      let acquired: unknown;
      try {
        if (beforeDisclosure && authorizeDisclosure) await disclose();
        const invokeOwned = async () => {
          check();
          const result = acquired = await invoke();
          own(result);
          check();
          return result;
        };
        const value = await (guard
          ? withOwnerCommandAuthorization(guard, invokeOwned)
          : invokeOwned());
        if (authorizeDisclosure) {
          await disclose();
        }
        const resource = readResource(value);
        if (resource) {
          delivered.add(resource);
        }
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
  // Bind only the declared interfaces. Data results are never recursively wrapped.
  const method = (
    target: object,
    key: PropertyKey,
    result: (value: unknown) => unknown = (value) => value,
  ) => {
    const fn = Reflect.get(target, key);
    if (typeof fn !== "function") return undefined;
    const bind =
      (fn: ActionEffectClient["confirm"]) => (...args: unknown[]) => {
        check();
        return call(() => Reflect.apply(fn, target, args)).then(result);
      };
    return wrapEffectConfirmation(
      fn as ActionEffectClient["confirm"],
      (confirm) => bind(confirm) as ActionEffectClient["confirm"],
    );
  };
  const methods = (
    target: object | undefined,
    keys: readonly PropertyKey[],
    result?: (value: unknown) => unknown,
  ) =>
    Object.fromEntries(keys.flatMap((key) => {
      const bound = target && method(target, key, result);
      return bound ? [[key, bound]] : [];
    }));
  const named = (target: object | undefined) =>
    methods(target, Object.keys(target ?? {}));
  const writer = (value: unknown) => {
    const source = value as import("../streams/types.ts").ContentStreamWriter;
    const facade = Object.freeze({
      id: source.id,
      offset: () => {
        check();
        return source.offset();
      },
      ...methods(source, [
        "append",
        "close",
        "abort",
        "retain",
        Symbol.asyncDispose,
      ]),
    });
    inheritContentStreamFailure(source, facade);
    return facade;
  };
  const native = (value: unknown): ReadableStream => {
    const source = value as ReadableStream;
    if (nativeStreams.has(source)) return source;
    const stream = pipingSource(source);
    nativeStreams.add(stream);
    readResourceOwners.set(stream, owner);
    delivered.add(stream);
    // Native consumers use the guarded source. Reader facades also protect bytes
    // already buffered by BYOB, tee, or a transform before revocation.
    const reader = (
      value: ReadableStreamDefaultReader | ReadableStreamBYOBReader,
    ) => ({
      get closed() {
        check();
        return value.closed;
      },
      read: method(value, "read"),
      cancel: (reason?: unknown) => observeCleanup(value.cancel(reason)),
      releaseLock: () => value.releaseLock(),
    });
    Object.defineProperties(stream, {
      getReader: {
        value: (options?: ReadableStreamGetReaderOptions) => {
          check();
          return reader(
            ReadableStream.prototype.getReader.call(stream, options),
          );
        },
      },
      tee: {
        value: () => {
          check();
          return ReadableStream.prototype.tee.call(stream).map(native);
        },
      },
      pipeThrough: {
        value: (
          transform: ReadableWritablePair,
          options?: StreamPipeOptions,
        ) => {
          check();
          return native(
            ReadableStream.prototype.pipeThrough.call(
              stream,
              transform,
              options,
            ),
          );
        },
      },
      pipeTo: {
        value: (destination: WritableStream, options?: StreamPipeOptions) => {
          check();
          const pending = ReadableStream.prototype.pipeTo.call(
            stream,
            destination,
            options,
          );
          observeCleanup(pending);
          return pending;
        },
      },
      cancel: {
        value: (reason?: unknown) =>
          observeCleanup(ReadableStream.prototype.cancel.call(stream, reason)),
      },
    });
    const values = (options?: ReadableStreamIteratorOptions) => {
      check();
      const iterator = ReadableStream.prototype.values.call(stream, options);
      return {
        next: method(iterator, "next"),
        return: async (value?: unknown) => {
          await observeCleanup(iterator.return!(value));
          return { done: true, value: undefined };
        },
        [Symbol.asyncIterator]() {
          return this;
        },
      };
    };
    Object.defineProperty(stream, "values", { value: values });
    Object.defineProperty(stream, Symbol.asyncIterator, { value: values });
    return stream;
  };
  const actions = Object.fromEntries(
    Object.entries(context.actions ?? {}).map(([name, action]) => {
      const bound = Object.assign(
        method(context.actions, name)!,
        methods(action, ["prepare"]),
      );
      inheritActionCaller(action, bound);
      return [name, bound];
    }),
  );
  const collections = Object.fromEntries(
    Object.entries(context.collections ?? {}).map((
      [name, collection],
    ) => [
      name,
      Object.freeze({
        definition: collection.definition,
        ...methods(collection, [
          "get",
          "list",
          "aggregate",
          "search",
          "create",
          "update",
          "delete",
        ]),
        relations: methods(collection.relations, ["list"]),
        commands: named(collection.commands),
        queries: named(collection.queries),
      }),
    ]),
  );
  const bindings = {
    actions,
    collections,
    content: {
      ...methods(context.content, [
        "authorize",
        "capture",
        "prepare",
        "materialize",
        "publish",
        "get",
        "getMany",
        "resolve",
        "resolveMany",
      ]),
      ...methods(context.content, ["open"], native),
      ...methods(context.content, ["openCapture"], writer),
    },
    streams: {
      ...methods(context.streams, ["open"], writer),
      ...methods(context.streams, ["follow"], (value) => {
        const follower =
          value as import("../content/progressive.ts").ProgressiveBodyFollower;
        return { ...follower, body: native(follower.body) };
      }),
    },
    vectors: methods(context.vectors, ["search"]),
    operations: methods(context.operations, ["start"]),
    effect: methods(context.effect, [
      "begin",
      "inspect",
      "confirm",
      "notStarted",
    ]),
    ...methods(context, ["transaction", "readSnapshot", "progress"]),
  };
  const descriptors = Object.getOwnPropertyDescriptors(context);
  for (const [key, value] of Object.entries(bindings)) {
    if (descriptors[key]) descriptors[key] = { ...descriptors[key], value };
  }
  return Object.defineProperties({}, descriptors) as ActionContext;
}
