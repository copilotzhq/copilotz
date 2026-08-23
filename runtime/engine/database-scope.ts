import {
  type BodyStore,
  type ContentPreparer,
  createContentResolver,
  createDatabaseAssetRepository,
  createDatabaseBodyStore,
  type DatabaseAssetRepository,
  maintainProgressiveBodies,
} from "../content/index.ts";
import { collectionAssetAdopterFor } from "../content/database-repository.ts";
import {
  type ContentStreamFollowInput,
  createContentStreamRuntime,
} from "../streams/index.ts";
import {
  isRegisteredActionLifecycleEventType,
  isReservedActionLifecycleDeduplicationId,
} from "../actions/index.ts";
import {
  type CopilotzEvent,
  type CopilotzEventHub,
  createEphemeralEvent,
  createEventCoordinator,
  createEventStore,
  type EventCoordinator,
  type EventStore,
  waitForCopilotzEvent,
} from "../events/index.ts";
import type {
  DeliveryExecutor,
  LiveEventDispatchHandle,
} from "../execution/index.ts";
import {
  type CollectionDefinition,
  type CollectionRuntime,
  createCollectionRuntime,
} from "../collections/index.ts";
import type {
  PluginRegistry,
  TransientProcessorSet,
} from "../plugins/index.ts";
import type {
  CopilotzEngineDatabaseScope,
  CopilotzEngineMaintenanceResult,
  CreateCopilotzEngineOptions,
} from "./types.ts";

export type DatabaseScopeCapabilities = Readonly<{
  assets: DatabaseAssetRepository;
  collections: CollectionRuntime;
  streamBodyStore: BodyStore;
}>;

export type DatabaseScopeRuntime = Readonly<{
  public: CopilotzEngineDatabaseScope;
  store: EventStore;
  coordinator: EventCoordinator;
  capabilities: DatabaseScopeCapabilities;
  streamBodyStore: BodyStore;
  transients: TransientProcessorSet;
}>;

export type CreateDatabaseScopeOptions = Readonly<{
  databaseSchema: string;
  engine: CreateCopilotzEngineOptions;
  registry: PluginRegistry;
  executor: DeliveryExecutor;
  preparer: ContentPreparer;
  eventHub: CopilotzEventHub;
  now: () => Date;
  publishLive(
    event: CopilotzEvent,
    settlementScopeId?: string,
  ): Promise<LiveEventDispatchHandle>;
  store?: EventStore;
  transients: TransientProcessorSet;
}>;

function isKernelCollection(value: unknown): value is CollectionDefinition {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return typeof item.name === "string" && item.schema !== undefined &&
    !("keys" in item);
}

/** Builds database-bound repositories without owning execution or transport. */
export function createDatabaseScope(
  options: CreateDatabaseScopeOptions,
): DatabaseScopeRuntime {
  const { databaseSchema, engine } = options;
  const store = options.store ?? createEventStore({
    session: engine.session,
    schema: databaseSchema,
    createId: engine.createId,
    now: options.now,
    random: engine.random,
    leaseMs: engine.leaseMs,
    maxAttempts: engine.maxAttempts,
    retryBaseMs: engine.retryBaseMs,
    retryCapMs: engine.retryCapMs,
  });
  if (store.databaseSchema !== databaseSchema) {
    throw new TypeError(
      `Database scope '${databaseSchema}' received store '${store.databaseSchema}'.`,
    );
  }
  const coordinator = createEventCoordinator({
    store,
    registry: options.registry,
    executor: options.executor,
    async publish(event, context) {
      const dispatched = await options.publishLive(
        event,
        context?.settlementScopeId,
      );
      await dispatched.done;
    },
    onDispatchFailure: engine.onDispatchFailure,
  });
  const assets = createDatabaseAssetRepository({
    coordinator,
    session: engine.session,
    eventStore: store,
    databaseSchema,
    createId: engine.createId,
    now: engine.now,
    digest: engine.digest,
    storage: engine.assetStorage,
  });
  const resolver = createContentResolver({
    assets,
    authorize: engine.authorizeContent,
    digest: engine.digest,
  });
  const collections = createCollectionRuntime({
    coordinator,
    session: engine.session,
    eventStore: store,
    assets: collectionAssetAdopterFor(assets),
    createId: engine.createId,
    now: options.now,
  });
  for (const resource of Object.values(options.registry.collections)) {
    if (isKernelCollection(resource)) collections.bind(resource);
  }
  const streamBodyStore = engine.assetStorage?.adapter?.forScope({
    namespace: "@copilotz/stream",
    databaseSchema,
  }) ?? engine.assetStorage?.writer ??
    createDatabaseBodyStore({
      session: engine.session,
      schema: databaseSchema,
    });
  const capabilities: DatabaseScopeCapabilities = Object.freeze({
    assets,
    collections,
    streamBodyStore,
  });
  const deliveryInNamespace = async (namespace: string, id: string) => {
    const delivery = await store.getDelivery(id);
    if (!delivery) return null;
    const event = await store.getEvent(delivery.eventId);
    return event?.namespace === namespace ? delivery : null;
  };
  const events: CopilotzEngineDatabaseScope["events"] = Object.freeze({
    append(draft, appendOptions) {
      if (
        isReservedActionLifecycleDeduplicationId(draft.deduplicationId)
      ) {
        throw new TypeError(
          `Event deduplication identity '${
            draft.deduplicationId!.trim()
          }' is reserved for the Action lifecycle.`,
        );
      }
      if (
        isRegisteredActionLifecycleEventType(
          draft.type,
          options.registry.actions,
        )
      ) {
        throw new TypeError(
          `Event type '${draft.type.trim()}' is reserved for the registered Action lifecycle.`,
        );
      }
      return coordinator.append(draft, appendOptions);
    },
    async emit(input) {
      const event = createEphemeralEvent(input, options.now);
      const dispatched = await options.publishLive(event);
      await dispatched.done;
      return event;
    },
    subscribe: (filter) => options.eventHub.subscribe(filter),
    waitFor(filterInput, signal) {
      const { timeoutMs, pollIntervalMs, ...filter } = filterInput;
      return waitForCopilotzEvent({
        hub: options.eventHub,
        filter,
        signal,
        timeoutMs,
        pollIntervalMs,
        loadDurable: () =>
          store.listEvents({
            namespace: filter.namespace,
            threadId: filter.threadId,
            correlationId: filter.correlationId,
            afterPosition: filter.afterPosition,
            limit: 1_000,
          }),
      });
    },
    async get(namespace, id) {
      const event = await store.getEvent(id);
      return event?.namespace === namespace ? event : null;
    },
    list: (listOptions) => store.listEvents(listOptions),
    settlement: (namespace, settlementScopeId) =>
      store.scopeSettlement(namespace, settlementScopeId),
    cancel: (namespace, settlementScopeId, reason) =>
      store.cancelScope(namespace, settlementScopeId, reason),
  });
  const deliveries: CopilotzEngineDatabaseScope["deliveries"] = Object.freeze({
    get: deliveryInNamespace,
    list: (listOptions) => store.listDeliveries(listOptions),
    async retry(namespace, id) {
      if (!await deliveryInNamespace(namespace, id)) return false;
      const retried = await store.retryDeadLetter(id);
      if (retried) {
        await options.executor.dispatchDelivery(id, { databaseSchema }).catch(
          () => undefined,
        );
      }
      return retried;
    },
    async discard(namespace, id) {
      if (!await deliveryInNamespace(namespace, id)) return false;
      return await store.discardDeadLetter(id);
    },
  });
  const recover: CopilotzEngineDatabaseScope["recover"] = (recovery = {}) =>
    coordinator.recover({ ...recovery, databaseSchema });
  const maintenance: CopilotzEngineDatabaseScope["maintenance"] = async (
    maintenanceOptions = {},
  ) => {
    const recovery = await coordinator.recover({
      databaseSchema,
      namespace: maintenanceOptions.namespace,
      consumerIds: maintenanceOptions.consumerIds,
      limit: maintenanceOptions.limit,
    });
    const compacted = await store.compactDeliveries({
      retentionMs: maintenanceOptions.retentionMs,
      now: maintenanceOptions.now,
      limit: maintenanceOptions.limit,
    });
    const assetMaintenance = await assets.maintainBodies({
      now: maintenanceOptions.now,
      orphanAfterMs: maintenanceOptions.assetOrphanAfterMs,
      limit: maintenanceOptions.limit,
    });
    const progressiveBodies = await maintainProgressiveBodies(streamBodyStore, {
      limit: maintenanceOptions.limit,
    });
    const result: CopilotzEngineMaintenanceResult = Object.freeze({
      recovered: recovery.handles.length,
      dispatchFailures: recovery.failures.length,
      compacted: Object.freeze(compacted),
      progressiveBodies,
      assets: assetMaintenance,
    });
    return result;
  };
  const publicScope: CopilotzEngineDatabaseScope = Object.freeze({
    databaseSchema,
    content: Object.freeze({ assets, preparer: options.preparer, resolver }),
    collections,
    streams: Object.freeze({
      async follow(namespace: string, input: ContentStreamFollowInput) {
        const follower = await createContentStreamRuntime({
          namespace,
          store: streamBodyStore,
          createId: engine.createId,
        }).follow(input);
        return follower.body;
      },
    }),
    events,
    deliveries,
    recover,
    maintenance,
  });

  return Object.freeze({
    public: publicScope,
    store,
    coordinator,
    capabilities,
    streamBodyStore,
    transients: options.transients,
  });
}
