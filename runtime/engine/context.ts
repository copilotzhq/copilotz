import type { CollectionDefinition } from "../collections/index.ts";
import { createContentStreamRuntime } from "../streams/index.ts";
import { createStreamOutputDescriptor } from "../streams/index.ts";
import {
  type ActionTransactionContext,
  type ActionTransactionOptions,
  createActionCallers,
} from "../actions/index.ts";
import { createActionInvocationContext } from "../actions/host.ts";
import type { ProcessorContext } from "../plugins/index.ts";
import type {
  CreateProcessorContextOptions,
  EngineContextSeed,
} from "./types.ts";

function requiredText(value: string, name: string): string {
  const normalized = value.trim();
  if (!normalized) throw new TypeError(`${name} must be non-empty.`);
  return normalized;
}

function capabilitySourceMetadata(
  base: EngineContextSeed,
): Record<string, unknown> {
  if (!base.source) return {};
  if (base.source.kind === "delivery") {
    return {
      sourceDeliveryId: base.source.id,
      ...(base.source.consumerId
        ? { sourceConsumerId: base.source.consumerId }
        : {}),
    };
  }
  if (base.source.kind === "stream") {
    return { sourceStreamId: base.source.id };
  }
  return { sourceLiveDispatchId: base.source.id };
}

/** Constructs the complete runtime-neutral context for one Processor run. */
export function createProcessorContext(
  options: CreateProcessorContextOptions,
): ProcessorContext {
  const namespace = requiredText(options.base.event.namespace, "Namespace");
  const databaseSchema = requiredText(
    options.base.databaseSchema,
    "Database schema",
  );
  const mutation = (operationKey: string) =>
    options.base.createMutationIdentity(
      requiredText(operationKey, "Mutation operation key"),
    );

  const streams = createContentStreamRuntime({
    namespace,
    store: options.streamBodyStore,
    async onOpen(output) {
      const descriptor = createStreamOutputDescriptor(output, {
        namespace,
        causationId: options.base.event.durable
          ? options.base.event.id
          : options.base.event.causationId,
        correlationId: output.correlationId ?? options.base.event.correlationId,
        metadata: {
          ...capabilitySourceMetadata(options.base),
          contentStream: true,
        },
      });
      await options.publishOutput?.(descriptor);
    },
  });

  const content: ProcessorContext["content"] = Object.freeze({
    prepare(input, prepareOptions) {
      const preparedIdentity = mutation(
        `content.prepare:${prepareOptions.operationKey}`,
      );
      return options.preparer.prepare(input, {
        namespace,
        idempotencyKey: preparedIdentity.deduplicationId,
        origin: prepareOptions.origin,
      });
    },
    materialize(input, materializeOptions = {}) {
      return options.assets.materialize({
        namespace,
        content: input,
        origin: materializeOptions.origin,
      });
    },
    publish(input, publishOptions) {
      const publishIdentity = mutation(
        `content.publish:${publishOptions.operationKey}`,
      );
      return options.assets.publish({
        ...input,
        namespace,
        idempotencyKey: publishIdentity.deduplicationId,
      });
    },
    get: (assetId) => options.assets.get(namespace, assetId),
    getMany: (assetIds) => options.assets.getMany(namespace, assetIds),
    resolve: (ref) => options.resolver.get(ref, { namespace }),
    resolveMany: (refs) => options.resolver.getMany(refs, { namespace }),
    open: (ref) => options.resolver.open(ref, { namespace }),
  });

  const collectionsByName = options.collections.withScope({
    namespace,
    createMutationIdentity: options.base.createMutationIdentity,
  });
  const collections = Object.freeze(Object.fromEntries(
    Object.entries(options.registry.collections).map(([alias, definition]) => {
      const collection = collectionsByName[
        (definition as CollectionDefinition).name
      ];
      if (!collection) {
        throw new Error(
          `Collection '${definition.name}' for alias '${alias}' is not bound.`,
        );
      }
      return [alias, collection];
    }),
  ));

  const processorOperationKey = requiredText(
    options.base.idempotencyKey,
    "Processor operation key",
  );
  let transactionIndex = 0;

  const transaction = async <T>(
    execute: (context: ActionTransactionContext<typeof collections>) =>
      | T
      | Promise<T>,
    transactionOptions: ActionTransactionOptions = {},
  ): Promise<T> => {
    const transactionOperationKey = transactionOptions.operationKey?.trim() ||
      `${processorOperationKey}:transaction:${++transactionIndex}`;
    const source = options.base.createMutationIdentity(
      transactionOperationKey,
      transactionOptions.identity?.metadata,
    );
    const result = await options.collections.transaction({
      operationKey: transactionOperationKey,
      namespace,
      identity: {
        causationId: transactionOptions.identity?.causationId ??
          source.causationId,
        correlationId: transactionOptions.identity?.correlationId ??
          source.correlationId,
        settlementScopeId: transactionOptions.identity?.settlementScopeId ??
          source.settlementScopeId,
        deduplicationId: transactionOptions.identity?.deduplicationId ??
          source.deduplicationId,
        metadata: {
          ...source.metadata,
          ...transactionOptions.identity?.metadata,
        },
      },
      execute: async ({ collections: byName, relations }) => {
        const transactionCollections = Object.freeze(Object.fromEntries(
          Object.entries(options.registry.collections).map(
            ([alias, definition]) => {
              const collection = byName[definition.name];
              if (!collection) {
                throw new Error(
                  `Collection '${definition.name}' for alias '${alias}' is not bound.`,
                );
              }
              return [alias, collection];
            },
          ),
        )) as ActionTransactionContext<typeof collections>["collections"];
        return await execute(Object.freeze({
          collections: transactionCollections,
          relations,
        }));
      },
    });
    return result.value;
  };

  const contextIdentity = Object.freeze({
    ...(options.base.event.durable
      ? { causationId: options.base.event.id }
      : options.base.event.causationId
      ? { causationId: options.base.event.causationId }
      : {}),
    correlationId: options.base.event.correlationId,
    deduplicationId: processorOperationKey,
    ...(options.base.settlementScopeId
      ? { settlementScopeId: options.base.settlementScopeId }
      : {}),
  });
  let rootActionIndex = 0;
  const actions = createActionCallers(options.registry.actions, {
    actionLifecycle: options.actionLifecycle,
    signal: options.base.signal,
    createInvocationKey: (actionId) =>
      `${processorOperationKey}:action:${++rootActionIndex}:${actionId}`,
    identity: contextIdentity,
    createContext({ frame, actions: nestedActions, progress }) {
      return createActionInvocationContext({
        host: context,
        frame,
        actions: nestedActions,
        progress,
      });
    },
  });

  const context: ProcessorContext = Object.freeze({
    namespace,
    databaseSchema,
    operationKey: processorOperationKey,
    identity: contextIdentity,
    resources: options.registry.resources,
    adapters: options.registry.adapters,
    actions,
    content,
    streams,
    collections,
    signal: options.base.signal,
    now: options.now ?? (() => new Date()),
    transaction,
  });
  return context;
}
