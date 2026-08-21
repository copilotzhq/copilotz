import {
  type MutationIdentity,
  projectDomainRelation,
} from "../domain/index.ts";
import { activeCollectionTransaction } from "../collections/kernel.ts";
import { createContentStreamRuntime } from "../content/index.ts";
import {
  createEphemeralEvent,
  type EventRouting,
  type EventVisibility,
  matchesCopilotzEvent,
  waitForCopilotzEvent,
} from "../events/index.ts";
import {
  type AnyFeatureDefinition,
  createFeatureContextValues,
  createFeatureInvoker,
  type FeatureActionsFor,
  type FeatureHostContext,
  type FeatureTransactionContext,
} from "../features/index.ts";
import type {
  CopilotzCapabilityBase,
  CopilotzProcessorCapabilities,
  CreateCopilotzProcessorCapabilitiesOptions,
  ScopedMutationOptions,
} from "./types.ts";
import type { MemoryKindDefinition } from "../memory/ontology.ts";

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

  const contextValues = createFeatureContextValues(options.registry.context);
  const memoryKinds = Object.freeze({
    ...(options.registry.context.memoryKinds ?? {}),
  }) as Readonly<Record<string, MemoryKindDefinition | undefined>>;

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
    stream: createContentStreamRuntime({
      namespace,
      store: options.streamBodyStore,
      async onOpen(output) {
        const threadId = output.threadId ?? options.base.event.threadId;
        if (!threadId) return;
        const event = createEphemeralEvent({
          type: "stream.output",
          namespace,
          threadId,
          streamId: output.id,
          payload: {
            streamId: output.id,
            mediaType: output.mediaType,
            role: output.role,
            ...(output.participantId
              ? { participantId: output.participantId }
              : {}),
          },
          routing: (output.routing as EventRouting | undefined) ??
            options.base.event.routing,
          visibility: (output.visibility as EventVisibility | undefined) ??
            options.base.event.visibility,
          metadata: {
            ...structuredClone(output.metadata),
            ...capabilitySourceMetadata(options.base),
            contentStream: true,
            role: output.role,
          },
          causationId: options.base.event.durable
            ? options.base.event.id
            : options.base.event.causationId,
          correlationId: output.correlationId ??
            options.base.event.correlationId,
        }, options.now);
        if (options.publishEvent) await options.publishEvent(event);
        else await options.eventHub.publish(event);
      },
    }),
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

  const capabilities: Omit<
    CopilotzProcessorCapabilities,
    "features" | "feature"
  > = Object
    .freeze({
      namespace,
      ...contextValues,
      events,
      content,
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
      memoryKinds,
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
    ? options.registry.processors.processorForConsumer(consumerId)
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
      upsertRelation: (input) => {
        const tx = activeCollectionTransaction(options.collectionRuntime);
        if (!tx) {
          throw new Error(
            "Feature transaction relation projection requires an active transaction.",
          );
        }
        return projectDomainRelation(tx, options.eventStore.tables, input);
      },
    },
  );
  const feature = <F extends AnyFeatureDefinition>(definition: F) =>
    createFeatureInvoker({ bound: definition }, host, transaction, {
      isTransactionActive: () =>
        activeCollectionTransaction(options.collectionRuntime) !== undefined,
      upsertRelation: (input) => {
        const tx = activeCollectionTransaction(options.collectionRuntime);
        if (!tx) {
          throw new Error(
            "Feature transaction relation projection requires an active transaction.",
          );
        }
        return projectDomainRelation(tx, options.eventStore.tables, input);
      },
    }).bound as FeatureActionsFor<F>;
  holder.current = Object.freeze({
    ...(capabilities as unknown as Record<string, unknown>),
    namespace: capabilities.namespace,
    now: options.now ?? (() => new Date()),
    agents: capabilities.agents,
    tools: capabilities.tools,
    llm: capabilities.llm,
    apis: capabilities.apis,
    mcp: capabilities.mcp,
    skills: capabilities.skills,
    embeddings: capabilities.embeddings,
    promptContext: capabilities.promptContext,
    featureDefinitions: capabilities.featureDefinitions,
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
            collection(
              definition: Parameters<
                FeatureTransactionContext["collection"]
              >[0],
            ) {
              const collection = capabilities.collections[definition.name];
              if (!collection) {
                throw new TypeError(
                  `Collection '${definition.name}' is not bound.`,
                );
              }
              return collection as never;
            },
            relations: Object.freeze({
              upsert(
                input: Parameters<
                  FeatureTransactionContext["relations"]["upsert"]
                >[0],
              ) {
                const tx = activeCollectionTransaction(
                  options.collectionRuntime,
                );
                if (!tx) {
                  throw new Error(
                    "Feature transaction relation projection requires an active transaction.",
                  );
                }
                return projectDomainRelation(
                  tx,
                  options.eventStore.tables,
                  { ...input, namespace: capabilities.namespace },
                );
              },
            }),
          }) as FeatureTransactionContext),
      });
      return result.value;
    },
    content: Object.freeze({
      resolver: options.resolver,
      stream: createContentStreamRuntime({
        namespace: capabilities.namespace,
        store: options.streamBodyStore,
        async onOpen(output) {
          const threadId = output.threadId ?? options.base.event.threadId;
          if (!threadId) return;
          const event = createEphemeralEvent({
            type: "stream.output",
            namespace: capabilities.namespace,
            threadId,
            streamId: output.id,
            payload: {
              streamId: output.id,
              mediaType: output.mediaType,
              role: output.role,
              ...(output.participantId
                ? { participantId: output.participantId }
                : {}),
            },
            routing: (output.routing as EventRouting | undefined) ??
              options.base.event.routing,
            visibility: (output.visibility as EventVisibility | undefined) ??
              options.base.event.visibility,
            metadata: {
              ...structuredClone(output.metadata),
              ...capabilitySourceMetadata(options.base),
              contentStream: true,
              role: output.role,
            },
            causationId: options.base.event.durable
              ? options.base.event.id
              : options.base.event.causationId,
            correlationId: output.correlationId ??
              options.base.event.correlationId,
          }, options.now);
          if (options.publishEvent) await options.publishEvent(event);
          else await options.eventHub.publish(event);
        },
      }),
      bodies: options.streamBodyStore,
      materialize: capabilities.content.materialize,
      linkOwner: capabilities.content.linkOwner,
    }),
    features,
    feature,
    events: capabilities.events,
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
