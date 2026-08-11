import {
  type AttachmentRuntime,
  COPILOTZ_STREAM_WORKLOAD,
  createAttachmentRuntime,
  createRealtimeProviderContext,
  createRealtimeStreamWorkload,
} from "../attachments/index.ts";
import {
  createContentPreparer,
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
  createCopilotzEventHub,
  createCoreSchemaStatements,
  createEphemeralEvent,
  createEventCoordinator,
  createEventStore,
  type EventCoordinator,
  type EventStore,
  waitForCopilotzEvent,
} from "../events/index.ts";
import {
  COPILOTZ_LIVE_WORKLOAD,
  createDeliveryExecutor,
  createLiveEventDispatcher,
  createLiveProcessorWorkload,
  type DeliveryContextBase,
  type DeliveryExecutor,
  invokeLiveProcessors,
  type LiveEventDispatchHandle,
  type LiveProcessorContextBase,
} from "../execution/index.ts";
import { createCopilotzProcessorCapabilities } from "./context.ts";
import type {
  CopilotzCapabilityBase,
  CopilotzEngine,
  CopilotzEngineMaintenanceResult,
  CopilotzProcessorCapabilities,
  CreateCopilotzEngineOptions,
} from "./types.ts";
import {
  createScheduledJobRepository,
  type ScheduledJobRepository,
} from "../schedules/index.ts";
import {
  createKnowledgeRepository,
  type KnowledgeRepository,
} from "../knowledge/index.ts";

type EngineCapabilities = Readonly<{
  assets: DatabaseAssetRepository;
  conversation: ConversationRepository;
  collections: EventCollections;
  llmAttempts: LlmAttemptRepository;
  toolExecutions: ToolExecutionRepository;
  relations: DomainRelationRepository;
  schedules: ScheduledJobRepository;
  knowledge: KnowledgeRepository;
}>;

async function initializeSchema(
  options: CreateCopilotzEngineOptions,
  schema: string,
): Promise<void> {
  if (options.initializeSchema === false) return;
  for (const statement of createCoreSchemaStatements(schema)) {
    await options.session.query(statement);
  }
}

function streamWorkloadName(value: string | undefined): string {
  if (value === undefined) return COPILOTZ_STREAM_WORKLOAD;
  const workload = value.trim();
  if (!workload) {
    throw new TypeError("Realtime stream workload must be non-empty.");
  }
  return workload;
}

function workerOriginated(event: CopilotzEvent): boolean {
  return [
    event.metadata.sourceDeliveryId,
    event.metadata.sourceStreamId,
    event.metadata.sourceLiveDispatchId,
  ].some((value) => typeof value === "string" && value.trim().length > 0);
}

/** Composes the event-native Copilotz core without taking session ownership. */
export async function createCopilotzEngine(
  options: CreateCopilotzEngineOptions,
): Promise<CopilotzEngine> {
  const schema = options.schema ?? "public";
  await initializeSchema(options, schema);
  const now = options.now ?? (() => new Date());
  const eventHub = options.eventHub ?? createCopilotzEventHub();
  const ownsEventHub = options.eventHub === undefined;
  const streamWorkload = streamWorkloadName(
    options.attachments?.streamWorkload,
  );

  const store: EventStore = createEventStore({
    session: options.session,
    schema,
    createId: options.createId,
    now,
    random: options.random,
    leaseMs: options.leaseMs,
    maxAttempts: options.maxAttempts,
    retryBaseMs: options.retryBaseMs,
    retryCapMs: options.retryCapMs,
  });

  let capabilities: EngineCapabilities | undefined;
  const preparer = createContentPreparer({
    createId: options.createId,
    digest: options.digest,
  });
  let resolver: ReturnType<typeof createContentResolver> | undefined;
  const createCapabilities = (
    base: CopilotzCapabilityBase,
  ): CopilotzProcessorCapabilities => {
    if (!capabilities || !resolver) {
      throw new Error("Copilotz engine context is not initialized.");
    }
    return createCopilotzProcessorCapabilities({
      base,
      registry: options.registry,
      preparer,
      resolver,
      eventHub,
      async publishEvent(event) {
        const dispatched = await publishLive(event, {
          inline: true,
          signal: base.signal,
        });
        await dispatched.done;
      },
      eventStore: store,
      now,
      ...capabilities,
    });
  };
  const createContext = (
    base: DeliveryContextBase,
  ): CopilotzProcessorCapabilities =>
    createCapabilities({
      ...base,
      source: {
        kind: "delivery",
        id: base.delivery.id,
        consumerId: base.delivery.consumerId,
      },
    });
  const createLiveContext = (
    base: LiveProcessorContextBase,
  ): CopilotzProcessorCapabilities =>
    createCapabilities({
      ...base,
      source: {
        kind: "live",
        id: base.dispatchAttemptId,
        consumerId: `processor:${base.processorId}`,
      },
    });

  const configuredWorkloads = options.execution?.workloads ?? {};
  const configuredLocalWorkers = options.execution?.localWorkloadWorkers ?? {};
  for (const reserved of [streamWorkload, COPILOTZ_LIVE_WORKLOAD]) {
    if (Object.prototype.hasOwnProperty.call(configuredWorkloads, reserved)) {
      throw new TypeError(
        `Execution workload '${reserved}' is reserved by the Copilotz engine.`,
      );
    }
  }
  if (
    !options.execution?.dispatcher &&
    Object.prototype.hasOwnProperty.call(
      configuredLocalWorkers,
      streamWorkload,
    )
  ) {
    throw new TypeError(
      `Local workload worker '${streamWorkload}' is configured through engine attachments.`,
    );
  }
  const executor: DeliveryExecutor = createDeliveryExecutor({
    ...(options.execution ?? {}),
    workloads: Object.freeze({
      ...configuredWorkloads,
      [streamWorkload]: createRealtimeStreamWorkload({
        registry: options.registry,
        eventStore: store,
        createContext: (base) =>
          createRealtimeProviderContext({
            base,
            capabilities: createCapabilities({
              ...base,
              source: { kind: "stream", id: base.metadata.streamId },
            }),
          }),
      }),
      [COPILOTZ_LIVE_WORKLOAD]: createLiveProcessorWorkload({
        registry: options.registry,
        createContext: createLiveContext,
      }),
    }),
    localWorkloadWorkers: options.execution?.dispatcher
      ? configuredLocalWorkers
      : Object.freeze({
        ...configuredLocalWorkers,
        [streamWorkload]: Object.freeze({
          workerId: options.attachments?.streamWorkerId,
          capacity: options.attachments?.streamCapacity,
        }),
      }),
    store,
    registry: options.registry,
    createContext,
    async onOutputEvent(event) {
      await options.execution?.onOutputEvent?.(event);
      if (!event.durable) return;
      const deliveries = await store.listDeliveries({
        namespace: event.namespace,
        eventId: event.id,
        status: "pending",
        limit: 1_000,
      });
      for (const delivery of deliveries) executor.scheduleDelivery(delivery);
    },
  });
  const liveDispatcher = createLiveEventDispatcher({
    registry: options.registry,
    executor,
  });
  const publishLive = async (
    event: CopilotzEvent,
    publishOptions: { inline?: boolean; signal?: AbortSignal } = {},
  ): Promise<LiveEventDispatchHandle> => {
    await eventHub.publish(event);
    await options.publish?.(event);
    if (!publishOptions.inline && !workerOriginated(event)) {
      return await liveDispatcher.dispatch(event);
    }

    const abort = new AbortController();
    const relay = () => abort.abort(publishOptions.signal?.reason);
    if (publishOptions.signal?.aborted) relay();
    else {publishOptions.signal?.addEventListener("abort", relay, {
        once: true,
      });}
    const done = invokeLiveProcessors({
      registry: options.registry,
      event,
      signal: abort.signal,
      createContext: createLiveContext,
    }).finally(() => {
      publishOptions.signal?.removeEventListener("abort", relay);
    });
    done.catch(() => undefined);
    return Object.freeze({
      event,
      processorIds: Object.freeze(
        options.registry.matchLive(event).map((processor) => processor.id),
      ),
      done,
      async cancel(reason = "live_event_cancelled") {
        abort.abort(new Error(reason));
        await done.catch(() => undefined);
      },
    });
  };
  let attachmentRuntime: AttachmentRuntime | undefined;

  try {
    const coordinator: EventCoordinator = createEventCoordinator({
      store,
      registry: options.registry,
      executor,
      async publish(event) {
        const dispatched = await publishLive(event);
        await dispatched.done;
      },
      onDispatchFailure: options.onDispatchFailure,
    });
    const assets = createDatabaseAssetRepository({
      coordinator,
      session: options.session,
      eventStore: store,
      createId: options.createId,
      now: options.now,
      digest: options.digest,
      maxDatabaseBytes: options.maxDatabaseBytes,
    });
    resolver = createContentResolver({
      assets,
      authorize: options.authorizeContent,
      digest: options.digest,
    });
    const conversation = createConversationRepository({
      coordinator,
      session: options.session,
      eventStore: store,
      assets,
      createId: options.createId,
    });
    const collections = createEventCollections({
      registry: options.registry,
      coordinator,
      session: options.session,
      eventStore: store,
      assets,
      validate: options.validateCollection,
      createId: options.createId,
      now: options.now,
    });
    const llmAttempts = createLlmAttemptRepository({
      coordinator,
      session: options.session,
      eventStore: store,
      assets,
      createId: options.createId,
      now: options.now,
    });
    const toolExecutions = createToolExecutionRepository({
      coordinator,
      session: options.session,
      eventStore: store,
      assets,
      createId: options.createId,
      now: options.now,
    });
    const relations = createDomainRelationRepository({
      coordinator,
      session: options.session,
      eventStore: store,
      createId: options.createId,
    });
    const schedules = createScheduledJobRepository({
      collections,
      coordinator,
      session: options.session,
      eventStore: store,
      preparer,
      now,
    });
    const knowledge = createKnowledgeRepository({
      coordinator,
      session: options.session,
      eventStore: store,
      assets,
      preparer,
      createId: options.createId,
      now,
    });
    capabilities = Object.freeze({
      assets,
      conversation,
      collections,
      llmAttempts,
      toolExecutions,
      relations,
      schedules,
      knowledge,
    });
    attachmentRuntime = createAttachmentRuntime({
      schema,
      coordinator,
      store,
      conversation,
      preparer,
      eventHub,
      executor,
      registry: options.registry,
      dispatchEvent: (event) => publishLive(event),
      workload: streamWorkload,
      createId: options.createId,
      now,
      settlementPollMs: options.attachments?.settlementPollMs,
    });

    const deliveryInNamespace = async (namespace: string, id: string) => {
      const delivery = await store.getDelivery(id);
      if (!delivery) return null;
      const event = await store.getEvent(delivery.eventId);
      return event?.namespace === namespace ? delivery : null;
    };

    let closed = false;
    const engine: CopilotzEngine = {
      plugins: options.registry,
      execution: Object.freeze({
        ownership: executor.ownership,
        workload: executor.workload,
        liveWorkload: liveDispatcher.workload,
        streamWorkload,
        workloads: executor.workloads,
      }),
      content: Object.freeze({ assets, preparer, resolver }),
      conversation,
      collections,
      llmAttempts,
      toolExecutions,
      relations,
      schedules,
      knowledge,
      connect: attachmentRuntime.connect,
      run: attachmentRuntime.run,
      events: Object.freeze({
        append: (draft, appendOptions) =>
          coordinator.append(draft, appendOptions),
        async emit(input) {
          const event = createEphemeralEvent(input, now);
          const dispatched = await publishLive(event);
          await dispatched.done;
          return event;
        },
        subscribe: (filter) => eventHub.subscribe(filter),
        waitFor(filterInput, signal) {
          const { timeoutMs, pollIntervalMs, ...filter } = filterInput;
          return waitForCopilotzEvent({
            hub: eventHub,
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
      }),
      deliveries: Object.freeze({
        get: deliveryInNamespace,
        list: (listOptions) => store.listDeliveries(listOptions),
        async retry(namespace, id) {
          if (!await deliveryInNamespace(namespace, id)) return false;
          const retried = await store.retryDeadLetter(id);
          if (retried) {
            await executor.dispatchDelivery(id).catch(() => undefined);
          }
          return retried;
        },
        async discard(namespace, id) {
          if (!await deliveryInNamespace(namespace, id)) return false;
          return await store.discardDeadLetter(id);
        },
      }),
      recover: (recoverOptions) => coordinator.recover(recoverOptions),
      async maintenance(maintenanceOptions = {}) {
        const recovery = await coordinator.recover({
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
      },
      async shutdown(reason = "copilotz_engine_shutdown") {
        if (closed) return;
        closed = true;
        await attachmentRuntime?.shutdown(reason);
        await executor.shutdown(reason);
        if (ownsEventHub) eventHub.close();
      },
    };
    return Object.freeze(engine);
  } catch (error) {
    await attachmentRuntime?.shutdown(
      "copilotz_engine_initialization_failed",
    ).catch(() => undefined);
    await executor.shutdown("copilotz_engine_initialization_failed").catch(
      () => undefined,
    );
    if (ownsEventHub) eventHub.close(error);
    throw error;
  }
}
