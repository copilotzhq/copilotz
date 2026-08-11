import {
  type AttachmentRuntime,
  createAttachmentRuntime,
} from "../attachments/index.ts";
import {
  type ContentPreparer,
  createContentResolver,
  createDatabaseAssetRepository,
  type DatabaseAssetRepository,
} from "../content/index.ts";
import {
  type ConversationRepository,
  createConversationRepository,
  createDomainRelationRepository,
  createEventCollections,
  createLlmAttemptRepository,
  createToolExecutionRepository,
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
import type { PluginRegistry } from "../plugins/index.ts";
import {
  createScheduledJobRepository,
  type ScheduledJobRepository,
} from "../schedules/index.ts";
import type {
  CopilotzEngineDatabaseScope,
  CopilotzEngineMaintenanceResult,
  CreateCopilotzEngineOptions,
} from "./types.ts";

export type DatabaseScopeCapabilities = Readonly<{
  assets: DatabaseAssetRepository;
  conversation: ConversationRepository;
  collections: EventCollections;
  llmAttempts: LlmAttemptRepository;
  toolExecutions: ToolExecutionRepository;
  relations: DomainRelationRepository;
  schedules: ScheduledJobRepository;
  knowledge: KnowledgeRepository;
}>;

export type DatabaseScopeRuntime = Readonly<{
  public: CopilotzEngineDatabaseScope;
  store: EventStore;
  coordinator: EventCoordinator;
  attachmentRuntime: AttachmentRuntime;
  capabilities: DatabaseScopeCapabilities;
}>;

export type CreateDatabaseScopeOptions = Readonly<{
  databaseSchema: string;
  engine: CreateCopilotzEngineOptions;
  registry: PluginRegistry;
  executor: DeliveryExecutor;
  preparer: ContentPreparer;
  eventHub: CopilotzEventHub;
  streamWorkload: string;
  now: () => Date;
  publishLive(event: CopilotzEvent): Promise<LiveEventDispatchHandle>;
  store?: EventStore;
}>;

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
    async publish(event) {
      const dispatched = await options.publishLive(event);
      await dispatched.done;
    },
    onDispatchFailure: engine.onDispatchFailure,
  });
  const assets = createDatabaseAssetRepository({
    coordinator,
    session: engine.session,
    eventStore: store,
    createId: engine.createId,
    now: engine.now,
    digest: engine.digest,
    maxDatabaseBytes: engine.maxDatabaseBytes,
  });
  const resolver = createContentResolver({
    assets,
    authorize: engine.authorizeContent,
    digest: engine.digest,
  });
  const conversation = createConversationRepository({
    coordinator,
    session: engine.session,
    eventStore: store,
    assets,
    createId: engine.createId,
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
  const llmAttempts = createLlmAttemptRepository({
    coordinator,
    session: engine.session,
    eventStore: store,
    assets,
    createId: engine.createId,
    now: engine.now,
  });
  const toolExecutions = createToolExecutionRepository({
    coordinator,
    session: engine.session,
    eventStore: store,
    assets,
    createId: engine.createId,
    now: engine.now,
  });
  const relations = createDomainRelationRepository({
    coordinator,
    session: engine.session,
    eventStore: store,
    createId: engine.createId,
  });
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
  const capabilities: DatabaseScopeCapabilities = Object.freeze({
    assets,
    conversation,
    collections,
    llmAttempts,
    toolExecutions,
    relations,
    schedules,
    knowledge,
  });
  const attachmentRuntime = createAttachmentRuntime({
    databaseSchema,
    coordinator,
    store,
    conversation,
    preparer: options.preparer,
    eventHub: options.eventHub,
    executor: options.executor,
    registry: options.registry,
    dispatchEvent: options.publishLive,
    workload: options.streamWorkload,
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
    settlement: (namespace, rootEventId) =>
      store.scopeSettlement(namespace, rootEventId),
    cancel: (namespace, rootEventId, reason) =>
      store.cancelScope(namespace, rootEventId, reason),
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
    });
    const result: CopilotzEngineMaintenanceResult = Object.freeze({
      recovered: recovery.handles.length,
      dispatchFailures: recovery.failures.length,
      compacted: Object.freeze(compacted),
    });
    return result;
  };
  const publicScope: CopilotzEngineDatabaseScope = Object.freeze({
    databaseSchema,
    content: Object.freeze({ assets, preparer: options.preparer, resolver }),
    conversation,
    collections,
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
  });
}
