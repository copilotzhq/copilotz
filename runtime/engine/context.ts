import type { MutationIdentity } from "../domain/index.ts";
import { activeCollectionTransaction } from "../collections/kernel.ts";
import {
  createEphemeralEvent,
  matchesCopilotzEvent,
  waitForCopilotzEvent,
} from "../events/index.ts";
import {
  type AnyFeatureDefinition,
  createFeatureContextValues,
  createFeatureInvoker,
  type FeatureActionsFor,
  type FeatureHostContext,
} from "../features/index.ts";
import { createStreamWriter } from "../streams/writer.ts";
import { openStreamFollower } from "../streams/follower.ts";
import type {
  CopilotzCapabilityBase,
  CopilotzProcessorCapabilities,
  CreateCopilotzProcessorCapabilitiesOptions,
  ScopedMutationOptions,
} from "./types.ts";

function requiredText(value: string, name: string): string {
  const normalized = value.trim();
  if (!normalized) throw new TypeError(`${name} must be non-empty.`);
  return normalized;
}

function identity(
  options: CreateCopilotzProcessorCapabilitiesOptions,
  fallback: string,
  mutation: ScopedMutationOptions | undefined,
): MutationIdentity {
  const operationKey = requiredText(
    mutation?.operationKey ?? fallback,
    "Mutation operation key",
  );
  return options.base.createMutationIdentity(
    operationKey,
    mutation?.metadata,
  );
}

function capabilitySourceMetadata(
  base: CopilotzCapabilityBase,
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

function contentMutationContext(
  options: CreateCopilotzProcessorCapabilitiesOptions,
) {
  return {
    transaction: activeCollectionTransaction(options.collectionRuntime) ??
      options.session,
    tables: options.eventStore.tables,
  };
}

/** Binds typed processor capabilities to one delivery's tenant and identity. */
export function createCopilotzProcessorCapabilities(
  options: CreateCopilotzProcessorCapabilitiesOptions,
): CopilotzProcessorCapabilities {
  const namespace = requiredText(options.base.event.namespace, "Namespace");
  const mutation = (
    fallback: string,
    value?: ScopedMutationOptions,
  ): MutationIdentity => identity(options, fallback, value);

  const events: CopilotzProcessorCapabilities["events"] = Object.freeze({
    async emit(input) {
      const event = createEphemeralEvent({
        ...input,
        namespace,
        threadId: input.threadId ?? options.base.event.threadId,
        routing: input.routing ?? options.base.event.routing,
        visibility: input.visibility ?? options.base.event.visibility,
        metadata: {
          ...structuredClone(input.metadata ?? {}),
          ...capabilitySourceMetadata(options.base),
        },
        causationId: input.causationId ??
          (options.base.event.durable
            ? options.base.event.id
            : options.base.event.causationId),
        correlationId: input.correlationId ??
          options.base.event.correlationId,
      }, options.now);
      if (options.publishEvent) await options.publishEvent(event);
      else await options.eventHub.publish(event);
      return event;
    },
    async list(listOptions = {}) {
      const { limit, ...filterInput } = listOptions;
      const filter = { ...filterInput, namespace, durable: true } as const;
      const values = await options.eventStore.listEvents({
        namespace,
        threadId: filter.threadId,
        correlationId: filter.correlationId,
        afterPosition: filter.afterPosition,
        limit: limit ?? 1_000,
      });
      return Object.freeze(
        values.filter((event) => matchesCopilotzEvent(event, filter)),
      );
    },
    waitFor(waitOptions) {
      const { timeoutMs, pollIntervalMs, ...filterInput } = waitOptions;
      const filter = Object.freeze({ ...filterInput, namespace });
      return waitForCopilotzEvent({
        hub: options.eventHub,
        filter,
        signal: options.base.signal,
        timeoutMs,
        pollIntervalMs,
        loadDurable: () =>
          options.eventStore.listEvents({
            namespace,
            threadId: filter.threadId,
            correlationId: filter.correlationId,
            afterPosition: filter.afterPosition,
            limit: 1_000,
          }),
      });
    },
  });

  const resources: CopilotzProcessorCapabilities["resources"] = Object.freeze({
    list: <T extends object = object>(
      type: Parameters<typeof options.registry.list>[0],
    ) => options.registry.list<T>(type),
    get: <T extends object = object>(
      type: Parameters<typeof options.registry.get>[0],
      id: string,
    ) => options.registry.get<T>(type, id),
    require: <T extends object = object>(
      type: Parameters<typeof options.registry.require>[0],
      id: string,
    ) => options.registry.require<T>(type, id),
    origin: (type, id) => options.registry.origin(type, id),
  });

  const content: CopilotzProcessorCapabilities["content"] = Object.freeze({
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
      return options.assets.materialize(contentMutationContext(options), {
        namespace,
        content: input,
        origin: materializeOptions.origin,
      });
    },
    linkOwner(ownerId, content) {
      return options.assets.linkOwner(
        contentMutationContext(options),
        { namespace, ownerId, content },
      );
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

  const boundStreams = () => {
    const streams = options.collectionRuntime.withScope({
      namespace,
      createMutationIdentity: options.base.createMutationIdentity,
    }).stream;
    if (!streams) {
      throw new TypeError("Stream collection is not bound.");
    }
    return streams;
  };

  const streams: CopilotzProcessorCapabilities["streams"] = Object.freeze({
    write(input) {
      return createStreamWriter({
        streams: boundStreams(),
        store: options.streamBodyStore,
        namespace,
        threadId: input.threadId,
        lane: input.lane,
        mediaType: input.mediaType,
        ...(input.participantId ? { participantId: input.participantId } : {}),
        ...(input.metadata ? { metadata: input.metadata } : {}),
        ...(input.id ? { id: input.id } : {}),
        identity: mutation(`stream.write:${input.lane}:${input.mediaType}`),
        ...(input.routing ? { routing: input.routing } : {}),
        ...(input.visibility ? { visibility: input.visibility } : {}),
      });
    },
    follow(input) {
      return openStreamFollower({
        streams: boundStreams(),
        store: options.streamBodyStore,
        namespace,
        streamId: input.streamId,
        ...(input.offset !== undefined ? { offset: input.offset } : {}),
      });
    },
  });

  const relations: CopilotzProcessorCapabilities["relations"] = Object.freeze({
    create(input, mutationOptions) {
      return options.relations.create({
        ...input,
        namespace,
        identity: mutation(
          `relation.create:${
            input.id ?? `${input.source.id}:${input.type}:${input.target.id}`
          }`,
          mutationOptions,
        ),
      });
    },
    delete(input, mutationOptions) {
      return options.relations.delete({
        ...input,
        namespace,
        identity: mutation(`relation.delete:${input.id}`, mutationOptions),
      });
    },
    get: (id) => options.relations.get(namespace, id),
    list: (listOptions = {}) =>
      options.relations.list({ ...listOptions, namespace }),
  });

  const schedules: CopilotzProcessorCapabilities["schedules"] = Object.freeze({
    create(input, mutationOptions) {
      const key = input.id ?? input.name;
      return options.schedules.create({
        ...input,
        namespace,
        identity: mutation(`scheduled_job.create:${key}`, mutationOptions),
      });
    },
    update(input, mutationOptions) {
      return options.schedules.update({
        ...input,
        namespace,
        identity: mutation(
          `scheduled_job.update:${input.id}`,
          mutationOptions,
        ),
      });
    },
    pause(id, mutationOptions) {
      return options.schedules.pause(
        namespace,
        id,
        mutation(`scheduled_job.pause:${id}`, mutationOptions),
      );
    },
    resume(id, mutationOptions) {
      return options.schedules.resume(
        namespace,
        id,
        mutation(`scheduled_job.resume:${id}`, mutationOptions),
      );
    },
    cancel(id, mutationOptions) {
      return options.schedules.cancel(
        namespace,
        id,
        mutation(`scheduled_job.cancel:${id}`, mutationOptions),
      );
    },
    get: (id) => options.schedules.get(namespace, id),
    list: (listOptions) => options.schedules.list(namespace, listOptions),
    runNow(id, runOptions = {}) {
      const {
        operationKey,
        metadata,
        ...settlementOptions
      } = runOptions;
      return options.schedules.runNow({
        ...settlementOptions,
        namespace,
        id,
        identity: mutation(
          `scheduled_job.run_now:${id}`,
          { operationKey, metadata },
        ),
      });
    },
  });

  const knowledge: CopilotzProcessorCapabilities["knowledge"] = Object.freeze({
    create(input, mutationOptions) {
      const key = input.id ?? input.externalId ??
        (input.source.kind === "uri" ? input.source.uri : "document");
      return options.knowledge.create({
        ...input,
        namespace,
        identity: mutation(`document.create:${key}`, mutationOptions),
      });
    },
    begin(id, mutationOptions) {
      return options.knowledge.begin(
        namespace,
        id,
        mutation(`document.begin:${id}`, mutationOptions),
      );
    },
    complete(input, mutationOptions) {
      return options.knowledge.complete({
        ...input,
        namespace,
        identity: mutation(`document.complete:${input.id}`, mutationOptions),
      });
    },
    markDuplicate(input, mutationOptions) {
      return options.knowledge.markDuplicate({
        ...input,
        namespace,
        identity: mutation(
          `document.duplicate:${input.id}`,
          mutationOptions,
        ),
      });
    },
    fail(input, mutationOptions) {
      return options.knowledge.fail({
        ...input,
        namespace,
        identity: mutation(`document.fail:${input.id}`, mutationOptions),
      });
    },
    delete(id, mutationOptions) {
      return options.knowledge.delete(
        namespace,
        id,
        mutation(`document.delete:${id}`, mutationOptions),
      );
    },
    get: (id) => options.knowledge.get(namespace, id),
    getByHash: (hash) => options.knowledge.getByHash(namespace, hash),
    getBySourceUri: (sourceUri) =>
      options.knowledge.getBySourceUri(namespace, sourceUri),
    list: (listOptions) => options.knowledge.list(namespace, listOptions),
    listChunks: (documentId) =>
      options.knowledge.listChunks(namespace, documentId),
    search: (input) => options.knowledge.search({ ...input, namespace }),
  });

  const memory: CopilotzProcessorCapabilities["memory"] = Object.freeze({
    async commit(input, mutationOptions) {
      const committed = await options.memory.commit({
        ...input,
        namespace,
        identity: mutation(
          `memory.consolidation:${input.checkpointId}`,
          mutationOptions,
        ),
      });
      if (!committed.value) {
        throw new Error(
          `Memory checkpoint '${input.checkpointId}' committed without a result.`,
        );
      }
      return committed.value;
    },
  });

  const capabilities: Omit<
    CopilotzProcessorCapabilities,
    "features" | "feature"
  > = Object
    .freeze({
      namespace,
      events,
      resources,
      content,
      streams,
      collections: Object.freeze({
        ...options.collections.withScope({
          namespace,
          createMutationIdentity: options.base.createMutationIdentity,
        }),
        ...options.collectionRuntime.withScope({
          namespace,
          createMutationIdentity: options.base.createMutationIdentity,
        }),
      }),
      relations,
      schedules,
      knowledge,
      memory,
    });
  const attached = attachProcessorFeatures(options, capabilities);
  return Object.freeze({
    ...capabilities,
    features: attached.features,
    feature: attached.feature,
  });
}

function processorFeatureAliases(
  options: CreateCopilotzProcessorCapabilitiesOptions,
): Readonly<Record<string, AnyFeatureDefinition>> {
  const consumerId = options.base.source?.consumerId;
  const processor = consumerId
    ? options.registry.processorForConsumer(consumerId)
    : undefined;
  const aliases = processor?.requires?.features;
  if (!aliases) return {};
  return aliases as Readonly<Record<string, AnyFeatureDefinition>>;
}

function attachProcessorFeatures(
  options: CreateCopilotzProcessorCapabilitiesOptions,
  capabilities: Omit<CopilotzProcessorCapabilities, "features" | "feature">,
): Pick<CopilotzProcessorCapabilities, "features" | "feature"> {
  const holder: { current?: FeatureHostContext } = {};
  const transaction: Parameters<typeof createFeatureInvoker>[2] = (input) => {
    const source = options.base.createMutationIdentity(
      input.operationKey,
      input.identity?.metadata,
    );
    return options.collectionRuntime.transaction({
      ...input,
      identity: {
        causationId: input.identity?.causationId ?? source.causationId,
        correlationId: input.identity?.correlationId ?? source.correlationId,
        settlementScopeId: input.identity?.settlementScopeId ??
          source.settlementScopeId,
        ...(input.identity?.deduplicationId
          ? { deduplicationId: input.identity.deduplicationId }
          : {}),
        metadata: {
          ...source.metadata,
          ...input.identity?.metadata,
        },
      },
    });
  };
  const host = () => {
    if (!holder.current) throw new Error("Feature context is not ready.");
    return holder.current;
  };
  const features = createFeatureInvoker(
    processorFeatureAliases(options),
    host,
    transaction,
    {
      isTransactionActive: () =>
        activeCollectionTransaction(options.collectionRuntime) !== undefined,
    },
  );
  const feature = <F extends AnyFeatureDefinition>(definition: F) =>
    createFeatureInvoker({ bound: definition }, host, transaction, {
      isTransactionActive: () =>
        activeCollectionTransaction(options.collectionRuntime) !== undefined,
    }).bound as FeatureActionsFor<F>;
  holder.current = Object.freeze({
    namespace: capabilities.namespace,
    ...createFeatureContextValues(capabilities.resources),
    collections: capabilities.collections,
    collection(definition) {
      const collection = capabilities.collections[definition.name];
      if (!collection) {
        throw new TypeError(`Collection '${definition.name}' is not bound.`);
      }
      return collection as never;
    },
    transaction: async (execute, transactionOptions = {}) => {
      const operationKey = transactionOptions.operationKey?.trim() ||
        `processor-feature:${crypto.randomUUID()}`;
      const result = await transaction({
        operationKey,
        namespace: capabilities.namespace,
        ...(transactionOptions.identity
          ? { identity: transactionOptions.identity }
          : {}),
        execute: async () =>
          await execute(Object.freeze({
            collections: capabilities.collections,
            collection(definition) {
              const collection = capabilities.collections[definition.name];
              if (!collection) {
                throw new TypeError(
                  `Collection '${definition.name}' is not bound.`,
                );
              }
              return collection as never;
            },
          })),
      });
      return result.value;
    },
    content: Object.freeze({
      resolver: options.resolver,
      materialize: capabilities.content.materialize,
      linkOwner: capabilities.content.linkOwner,
    }),
    resources: capabilities.resources,
    features,
    feature,
    events: Object.freeze({ list: capabilities.events.list }),
    deliveries: Object.freeze({
      list: (listOptions = {}) =>
        options.eventStore.listDeliveries({
          ...listOptions,
          namespace: capabilities.namespace,
        }),
    }),
    relations: Object.freeze({ list: capabilities.relations.list }),
  });
  return Object.freeze({ features, feature });
}
