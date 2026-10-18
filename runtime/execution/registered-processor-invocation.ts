import { createRegisteredReadSnapshot } from "./snapshot-capability.ts";
import { createCollectionReadCapability } from "./collection-read-capability.ts";
import { normalizeActionNamedPreparation } from "./preparation-call.ts";
/** Ordinary Processor context/invocation kernel, independent of placement.
 * Retry/onError semantics remain distinct from Action completion and effects. */
import type {
  ActionCallOptions,
  ActionTransactionOptions,
  RuntimeContext,
} from "../actions/types.ts";
import { isNonRetryableError } from "../failure.ts";
import { assertJsonValue } from "../json.ts";
import type { OwnerJson } from "../owner/boundary.ts";
import {
  createOwnerTransactionPlanner,
  type OwnerTransactionContext,
} from "../owner/transaction.ts";
import { matchProcessor } from "../plugins/match.ts";
import type { Processor, ProcessorContext } from "../plugins/processor.ts";
import type { PluginRegistry } from "../plugins/registry.ts";
import type {
  RegisteredContextCapabilities,
  RegisteredInvocationCalls,
  RegisteredInvocationLifetime,
  RegisteredProcessorCompletion,
  RegisteredProcessorInvocation,
} from "./registered-invocation.ts";

function failure(code: string) {
  return Object.assign(new Error(code), {
    name: "RegisteredProcessorError",
    code,
  });
}
function snapshot<T>(value: T): T {
  assertJsonValue(value, {
    maxDepth: 64,
    maxNodes: 100_000,
    rejectNegativeZero: true,
  });
  if (new TextEncoder().encode(JSON.stringify(value)).length > 1024 * 1024) {
    throw failure("processor_data_limit");
  }
  return structuredClone(value);
}
function text(value: unknown): asserts value is string {
  if (
    typeof value !== "string" || !value.trim() || value !== value.trim() ||
    value.length > 1024
  ) throw failure("processor_identity_invalid");
}
function unknownOutcome(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const value = error as {
    code?: unknown;
    indeterminate?: unknown;
    outcome?: unknown;
    execution?: unknown;
  };
  return value.indeterminate === true || value.outcome === "unknown" ||
    value.execution === "indeterminate" ||
    ["owner_commit_unknown", "persistence_indeterminate"].includes(
      String(value.code),
    );
}

export async function runRegisteredProcessorInvocation(
  options: Readonly<{
    registry: PluginRegistry;
    invocation: RegisteredProcessorInvocation;
    lifetime: RegisteredInvocationLifetime;
    calls: RegisteredInvocationCalls;
    createCapabilities():
      | RegisteredContextCapabilities
      | Promise<RegisteredContextCapabilities>;
  }>,
): Promise<RegisteredProcessorCompletion> {
  const { registry, createCapabilities } = options;
  const projection = snapshot(options.invocation);
  const { check, isCancelled, commandSignal, exposedSignal } = options.lifetime;
  const { execute, invokeAction } = options.calls;
  const prepareAction = options.calls.prepareAction?.bind(options.calls);
  const readCollection = options.calls.readCollection?.bind(options.calls);
  let registering = true;
  let capabilityFailure = false;
  let pendingFailure: unknown;
  let hasPendingFailure = false;
  let pendingFailures: unknown[] = [];
  // The bound counts calls over the whole invocation; settled calls stay here.
  const pending: Promise<unknown>[] = [];
  const unsupported = (): never => {
    capabilityFailure = true;
    throw failure("processor_capability_unsupported");
  };
  const unavailable = () => new Proxy({}, { get: unsupported });
  const supported = <T extends object>(target: T): T =>
    new Proxy(target, {
      get: (value, property) =>
        Object.hasOwn(value, property)
          ? Reflect.get(value, property)
          : unsupported(),
    });
  const plannedCollections = (
    context: OwnerTransactionContext<typeof registry.collections>,
  ) =>
    supported(Object.fromEntries(
      Object.entries(registry.collections).map(([alias, definition]) => {
        const collection = context.collections[alias];
        const method = <T extends (...args: never[]) => unknown>(
          call: T,
        ): T =>
          new Proxy(call, {
            get: unsupported,
            apply(target, receiver, args) {
              if (definition.content?.fields.length || args.length > 1) {
                return unsupported();
              }
              return Reflect.apply(target, receiver, args);
            },
          });
        return [
          alias,
          supported({
            create: method(collection.create),
            update: method(collection.update),
            delete: method(collection.delete),
            commands: supported(Object.fromEntries(
              Object.keys(definition.commands ?? {}).map((
                name,
              ) => [name, method(collection.commands[name])]),
            )),
          }),
        ];
      }),
    ));
  const track = <T>(start: () => Promise<T>): Promise<T> => {
    check();
    if (!registering) throw failure("processor_context_closed");
    if (pending.length >= 100) return unsupported();
    let task: Promise<T>;
    try {
      task = start();
    } catch (error) {
      task = Promise.reject(error);
    }
    pending.push(task.catch((error) => {
      pendingFailures.push(error);
      if (!hasPendingFailure || unknownOutcome(error)) {
        hasPendingFailure = true;
        pendingFailure = error;
      }
    }));
    return task;
  };
  const readSnapshot = createRegisteredReadSnapshot({
    collections: registry.collections,
    port: options.calls.snapshots,
    signal: commandSignal,
    check,
    unsupported,
    track,
  });
  const planner = createOwnerTransactionPlanner({
    collections: registry.collections,
    identity: {
      ownerId: projection.ownerId,
      invocationId: projection.deliveryId,
    },
    execute(command, callOptions) {
      check();
      if (capabilityFailure) return unsupported();
      return execute(command, callOptions);
    },
  });
  let transactionIndex = 0;
  let actionIndex = 0;
  const transaction: RuntimeContext["transaction"] = (
    callback,
    callOptions: ActionTransactionOptions = {},
  ) => {
    if (callOptions.identity !== undefined) return unsupported();
    const localKey = callOptions.operationKey ??
      `transaction:${++transactionIndex}`;
    text(localKey);
    return track(() =>
      planner({
        operationKey: `${projection.operationKey}:${localKey}`,
        signal: callOptions.signal
          ? AbortSignal.any([commandSignal, callOptions.signal])
          : commandSignal,
        execute: (context) =>
          callback(
            {
              ...context,
              collections: plannedCollections(context),
              relations: unavailable(),
              vectors: unavailable(),
            } as never,
          ),
      }).then(({ value }) => value)
    );
  };
  let result: RegisteredProcessorCompletion;
  try {
    check();
    const processor = Object.values(registry.processors).find((item) =>
      item.id === projection.processorId
    ) as Processor | undefined;
    if (
      !processor ||
      !matchProcessor(processor, projection.event, projection.event.data)
    ) throw failure("processor_unavailable");
    const handle = processor.handle;
    const onError = processor.onError;
    const capabilities = await createCapabilities();
    check();
    const prepareNamed =
      (actionAlias: string) => (request: unknown, callOptions: unknown) =>
        track(() => {
          if (!prepareAction) {
            capabilityFailure = true;
            throw failure("action_prepare_unavailable");
          }
          const normalized = normalizeActionNamedPreparation(
            request,
            callOptions,
          );
          return prepareAction({
            actionAlias,
            ...normalized.request,
            operationKey: normalized.operationKey,
          }, {
            signal: normalized.signal
              ? AbortSignal.any([commandSignal, normalized.signal])
              : commandSignal,
          });
        });
    const actions = Object.fromEntries(
      Object.keys(registry.actions).map((
        actionAlias,
      ) => [
        actionAlias,
        new Proxy(
          Object.assign(
            (input: unknown, callOptions: ActionCallOptions = {}) => {
              if (
                !invokeAction || callOptions.identity !== undefined ||
                callOptions.metadata !== undefined
              ) return unsupported();
              const localKey = callOptions.operationKey?.trim() ||
                String(++actionIndex);
              text(localKey);
              return track(() =>
                invokeAction({
                  actionAlias,
                  input: snapshot(input) as OwnerJson,
                  operationKey: localKey,
                }, {
                  signal: callOptions.signal
                    ? AbortSignal.any([commandSignal, callOptions.signal])
                    : commandSignal,
                })
              );
            },
            { prepareNamed: prepareNamed(actionAlias) },
          ),
          {
            get: (target, property) =>
              property === "prepareNamed"
                ? Reflect.get(target, property)
                : unsupported(),
          },
        ),
      ]),
    );
    const directCollections = Object.fromEntries(
      Object.entries(registry.collections).map((
        [alias, definition],
      ) => [
        alias,
        new Proxy({
          ...createCollectionReadCapability({
            alias,
            read: readCollection,
            signal: commandSignal,
            check,
            unsupported,
            track,
          }),
          create: (input: Record<string, unknown>, extra?: unknown) => {
            if (extra !== undefined) return unsupported();
            return transaction(({ collections }) =>
              collections[alias].create(input)
            );
          },
          update: (
            input: Record<string, unknown> & { id: string },
            extra?: unknown,
          ) => {
            if (extra !== undefined) return unsupported();
            return transaction(({ collections }) =>
              collections[alias].update(input)
            );
          },
          delete: (input: { id: string }, extra?: unknown) => {
            if (extra !== undefined) return unsupported();
            return transaction(({ collections }) =>
              collections[alias].delete(input)
            );
          },
          commands: new Proxy(
            Object.fromEntries(
              Object.keys(definition.commands ?? {}).map((
                name,
              ) => [
                name,
                (
                  input: Record<string, unknown> & { id: string },
                  extra?: unknown,
                ) => {
                  if (extra !== undefined) return unsupported();
                  return transaction(({ collections }) =>
                    collections[alias].commands[name](input)
                  );
                },
              ]),
            ),
            {
              get: (target, property) =>
                Object.hasOwn(target, property)
                  ? Reflect.get(target, property)
                  : unsupported(),
            },
          ),
        }, {
          get: (target, property) =>
            Object.hasOwn(target, property)
              ? Reflect.get(target, property)
              : unsupported(),
        }),
      ]),
    );
    const context = {
      namespace: projection.namespace,
      databaseSchema: projection.databaseSchema,
      operationKey: projection.operationKey,
      identity: snapshot(projection.identity),
      resources: capabilities.resources,
      adapters: capabilities.adapters,
      actions: new Proxy(actions, {
        get: (target, property) =>
          Object.hasOwn(target, property)
            ? Reflect.get(target, property)
            : unsupported(),
      }),
      collections: new Proxy(directCollections, {
        get: (target, property) =>
          Object.hasOwn(target, property)
            ? Reflect.get(target, property)
            : unsupported(),
      }),
      vectors: unavailable(),
      content: unavailable(),
      streams: unavailable(),
      signal: exposedSignal,
      now: () => new Date(),
      transaction,
      readSnapshot: readSnapshot as RuntimeContext["readSnapshot"],
      signalDeferredWait: unsupported,
    } as unknown as ProcessorContext;
    try {
      try {
        await handle.call(processor, snapshot(projection.event), context);
      } catch (error) {
        await Promise.all(pending);
        if (hasPendingFailure && unknownOutcome(pendingFailure)) {
          throw pendingFailure;
        }
        check();
        if (unknownOutcome(error)) throw error;
        const terminal = isNonRetryableError(error) ||
          projection.attempts >= projection.maxAttempts;
        const precedingFailures = pendingFailures.length;
        if (
          capabilityFailure || !terminal ||
          !await onError?.call(
            processor,
            error,
            snapshot(projection.event),
            context,
          )
        ) throw error;
        // onError may acknowledge precisely the known settled failure that
        // reached handle. Independent/unawaited failures and anything newly
        // raised by onError stay latched; uncertainty is never cleared.
        pendingFailures = pendingFailures.filter((failure, index) =>
          index >= precedingFailures || failure !== error
        );
        hasPendingFailure = pendingFailures.length > 0;
        pendingFailure = pendingFailures.find(unknownOutcome) ??
          pendingFailures[0];
      }
    } finally {
      registering = false;
      await Promise.all(pending);
    }
    if (hasPendingFailure) throw pendingFailure;
    check();
    if (capabilityFailure) unsupported();
    result = { status: "succeeded" };
  } catch (error) {
    if (
      unknownOutcome(error) ||
      (hasPendingFailure && unknownOutcome(pendingFailure))
    ) {
      throw hasPendingFailure && unknownOutcome(pendingFailure)
        ? pendingFailure
        : error;
    }
    result = isCancelled()
      ? { status: "cancelled", code: "processor_cancelled" }
      : {
        status: "failed",
        code: capabilityFailure
          ? "processor_capability_unsupported"
          : "processor_failed",
        retryable: !capabilityFailure && !isNonRetryableError(error),
      };
  } finally {
    registering = false;
  }
  return result;
}
