import {
  type AttachmentRuntime,
  createAttachmentRuntime,
} from "../attachments/index.ts";
import {
  type AssetBodyStore,
  type ContentPreparer,
  createContentResolver,
  createDatabaseAssetBodyStore,
  createDatabaseAssetRepository,
  type DatabaseAssetRepository,
} from "../content/index.ts";
import {
  type ConversationRepository,
  createDomainRelationRepository,
  createEventCollections,
  type DomainRelationRepository,
  type EventCollections,
  type LlmAttemptRepository,
  type ToolExecutionRepository,
} from "../domain/index.ts";
import {
  type CopilotzEvent,
  type CopilotzEventHub,
  createEphemeralEvent,
  createEventCoordinator,
  createEventStore,
  type EventCoordinator,
  type EventStore,
  type SqlExecutor,
  waitForCopilotzEvent,
} from "../events/index.ts";
import type {
  DeliveryExecutor,
  LiveEventDispatchHandle,
} from "../execution/index.ts";
import {
  createKnowledgeRepository,
  type KnowledgeRepository,
} from "../knowledge/index.ts";
import {
  createMemoryConsolidationRepository,
  type MemoryConsolidationRepository,
} from "../memory/repository.ts";
import {
  createCollectionRuntime,
  type CollectionDefinition,
  type CollectionRuntime,
} from "../collections/index.ts";
import {
  coreCollectionsBound,
  createCollectionConversationRepository,
  createCollectionLlmAttemptRepository,
  createCollectionToolExecutionRepository,
} from "./collection-ingress.ts";
import type { FeatureContextBindings } from "../features/index.ts";
import type { PluginRegistry, TransientProcessorSet } from "../plugins/index.ts";
import {
  createScheduledJobRepository,
  type ScheduledJobRepository,
} from "../schedules/index.ts";
import type {
  CopilotzEngineDatabaseScope,
  CopilotzEngineMaintenanceResult,
  CreateCopilotzEngineOptions,
} from "./types.ts";

function unboundCoreRepository<T extends object>(kind: string): T {
  const message =
    `Core ${kind} collections are not bound. Register the core conversation collections before using ${kind}.`;
  return new Proxy({} as T, {
    get(_target, property) {
      if (property === "then") return undefined;
      return () => {
        throw new Error(message);
      };
    },
  });
}

export type DatabaseScopeCapabilities = Readonly<{
  assets: DatabaseAssetRepository;
  session: SqlExecutor;
  conversation: ConversationRepository;
  collections: EventCollections;
  llmAttempts: LlmAttemptRepository;
  toolExecutions: ToolExecutionRepository;
  relations: DomainRelationRepository;
  schedules: ScheduledJobRepository;
  knowledge: KnowledgeRepository;
  memory: MemoryConsolidationRepository;
  collectionRuntime: CollectionRuntime;
  streamBodyStore: AssetBodyStore;
}>;

export type DatabaseScopeRuntime = Readonly<{
  public: CopilotzEngineDatabaseScope;
  store: EventStore;
  coordinator: EventCoordinator;
  attachmentRuntime: AttachmentRuntime;
  capabilities: DatabaseScopeCapabilities;
  streamBodyStore: AssetBodyStore;
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
  const collections = createEventCollections({
    registry: options.registry,
    coordinator,
    session: engine.session,
    eventStore: store,
    assets,
    validate: engine.validateCollection,
    createId: engine.createId,
    now: engine.now,
  });
  const collectionRuntime = createCollectionRuntime({
    coordinator,
    session: engine.session,
    eventStore: store,
    createId: engine.createId,
    now: options.now,
  });
  for (const resource of options.registry.list("collections")) {
    if (isKernelCollection(resource)) collectionRuntime.bind(resource);
  }
  const relations = createDomainRelationRepository({
    coordinator,
    session: engine.session,
    eventStore: store,
    createId: engine.createId,
  });
  const featureBindings: Omit<FeatureContextBindings, "namespace"> =
    Object.freeze({
      plugins: options.registry,
      collections,
      collectionRuntime,
      contentResolver: resolver,
      events: {
        list: (listOptions) => store.listEvents(listOptions),
      },
      deliveries: {
        list: (listOptions) => store.listDeliveries(listOptions),
      },
      relations: {
        list: (listOptions) => relations.list(listOptions),
      },
    });
  const ingress = {
    collectionRuntime,
    session: engine.session,
    eventStore: store,
    assets,
    featureBindings,
    createId: engine.createId,
    now: engine.now ?? options.now,
  };
  const useKernelIngress = coreCollectionsBound(collectionRuntime);
  const conversation = useKernelIngress
    ? createCollectionConversationRepository(ingress)
    : unboundCoreRepository<ConversationRepository>("conversation");
  const llmAttempts = useKernelIngress
    ? createCollectionLlmAttemptRepository(ingress)
    : unboundCoreRepository<LlmAttemptRepository>("llm_attempt");
  const toolExecutions = useKernelIngress
    ? createCollectionToolExecutionRepository(ingress)
    : unboundCoreRepository<ToolExecutionRepository>("tool_execution");
  const schedules = createScheduledJobRepository({
    collections,
    coordinator,
    session: engine.session,
    eventStore: store,
    preparer: options.preparer,
    now: options.now,
  });
  const knowledge = createKnowledgeRepository({
    coordinator,
    session: engine.session,
    eventStore: store,
    assets,
    preparer: options.preparer,
    createId: engine.createId,
    now: options.now,
  });
  const memory = createMemoryConsolidationRepository({
    coordinator,
    eventStore: store,
    assets,
    validate: engine.validateCollection,
  });
  const streamBodyStore = engine.assetStorage?.writer ??
    createDatabaseAssetBodyStore({
      session: engine.session,
      schema: databaseSchema,
    });
  const capabilities: DatabaseScopeCapabilities = Object.freeze({
    assets,
    session: engine.session,
    conversation,
    collections,
    llmAttempts,
    toolExecutions,
    relations,
    schedules,
    knowledge,
    memory,
    collectionRuntime,
    streamBodyStore,
  });
  const attachmentRuntime = createAttachmentRuntime({
    databaseSchema,
    coordinator,
    store,
    session: engine.session,
    assets,
    preparer: options.preparer,
    eventHub: options.eventHub,
    executor: options.executor,
    collectionRuntime,
    transients: options.transients,
    featureBindings,
    streamBodyStore,
    dispatchEvent: options.publishLive,
    createId: engine.createId,
    now: options.now,
    settlementPollMs: engine.attachments?.settlementPollMs,
  });

  const deliveryInNamespace = async (namespace: string, id: string) => {
    const delivery = await store.getDelivery(id);
    if (!delivery) return null;
    const event = await store.getEvent(delivery.eventId);
    return event?.namespace === namespace ? delivery : null;
  };
  const events: CopilotzEngineDatabaseScope["events"] = Object.freeze({
    append: (draft, appendOptions) => coordinator.append(draft, appendOptions),
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
    const compacted = await store.compact({
      retentionMs: maintenanceOptions.retentionMs,
      now: maintenanceOptions.now,
      limit: maintenanceOptions.limit,
    });
    const assetMaintenance = await assets.maintainBodies({
      now: maintenanceOptions.now,
      orphanAfterMs: maintenanceOptions.assetOrphanAfterMs,
      limit: maintenanceOptions.limit,
    });
    const result: CopilotzEngineMaintenanceResult = Object.freeze({
      recovered: recovery.handles.length,
      dispatchFailures: recovery.failures.length,
      compacted: Object.freeze(compacted),
      assets: assetMaintenance,
    });
    return result;
  };
  const publicScope: CopilotzEngineDatabaseScope = Object.freeze({
    databaseSchema,
    content: Object.freeze({ assets, preparer: options.preparer, resolver }),
    conversation,
    collections,
    collectionRuntime,
    llmAttempts,
    toolExecutions,
    relations,
    schedules,
    knowledge,
    connect(input) {
      return attachmentRuntime.connect({
        ...input,
        databaseSchema: input.databaseSchema ?? databaseSchema,
      });
    },
    run(input) {
      return attachmentRuntime.run({
        ...input,
        databaseSchema: input.databaseSchema ?? databaseSchema,
      });
    },
    disconnectAttachments(
      error: unknown = new Error("Application persistence is unavailable."),
    ) {
      return attachmentRuntime.terminate(error);
    },
    events,
    deliveries,
    recover,
    maintenance,
  });

  return Object.freeze({
    public: publicScope,
    store,
    coordinator,
    attachmentRuntime,
    capabilities,
    streamBodyStore,
    transients: options.transients,
  });
}
