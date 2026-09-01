import {
  assetBodySchemaPrefix,
  type BodyStore,
  type ContentPreparer,
  createContentResolver,
  createDatabaseAssetRepository,
  createDatabaseBodyStore,
  type DatabaseAssetRepository,
  maintainProgressiveBodies,
  readBodyBytes,
  type ReadBodyRangeInput,
} from "../content/index.ts";
import { collectionAssetAdopterFor } from "../content/database-repository.ts";
import {
  type ContentStreamFollowInput,
  createContentStreamRuntime,
  DEFAULT_OPERATION_REPLAY_RETENTION_MS,
} from "../streams/index.ts";
import type { OperationCatalog } from "../streams/catalog.ts";
import {
  isRegisteredActionLifecycleEventType,
  isReservedActionLifecycleDeduplicationId,
} from "../actions/index.ts";
import {
  createProtectedValueRuntime,
  PROTECTED_VALUE_NODE_TYPE,
  type ProtectedValueRuntime,
} from "../actions/protected-value.ts";
import {
  actionDefinitionById,
  hydrateActionLifecycleBody,
  protectedActionLifecycleRefs,
  publicActionLifecycleData,
} from "../actions/protected-lifecycle.ts";
import {
  prepareProtectedEventBody,
  protectedEventRefs,
  resolveProtectedEventData,
  samePreparedProtectedEventBody,
} from "../actions/protected-event.ts";
import { parseActionLifecycleEvent } from "../actions/event.ts";
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
import {
  eventDataRef,
  readEventBody,
  writeEventBody,
} from "../events/body-store.ts";
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
import { resolveProcessorEvent } from "../plugins/index.ts";
import { withProcessorEventData } from "../plugins/processor.ts";
import type {
  CopilotzEngineDatabaseScope,
  CopilotzEngineMaintenanceResult,
  CreateCopilotzEngineOptions,
} from "./types.ts";

export type DatabaseScopeCapabilities = Readonly<{
  assets: DatabaseAssetRepository;
  collections: CollectionRuntime;
  streamBodyStore: BodyStore;
  protectedValues?: ProtectedValueRuntime;
}>;

export type DatabaseScopeRuntime = Readonly<{
  public: CopilotzEngineDatabaseScope;
  store: EventStore;
  coordinator: EventCoordinator;
  capabilities: DatabaseScopeCapabilities;
  streamBodyStore: BodyStore;
  transients: TransientProcessorSet;
  operationCatalog: OperationCatalog;
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
  operationCatalog: OperationCatalog;
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
    indexOperationEvent: (transaction, input) =>
      options.operationCatalog.indexEvent(transaction, input),
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
  const streamBodyStore = engine.assetStorage?.adapter?.forScope({
    namespace: "@copilotz/stream",
    databaseSchema,
  }) ?? engine.assetStorage?.writer ??
    createDatabaseBodyStore({
      session: engine.session,
      schema: databaseSchema,
    });
  const protectedValues = engine.secretAdapter
    ? createProtectedValueRuntime({
      databaseSchema,
      session: engine.session,
      storage: engine.assetStorage!,
      adapter: engine.secretAdapter,
      createId: engine.createId,
    })
    : undefined;
  const streamBodyPrefix = assetBodySchemaPrefix({
    prefix: engine.assetStorage?.prefix,
    databaseSchema,
  });
  const collections = createCollectionRuntime({
    coordinator,
    session: engine.session,
    eventStore: store,
    assets: collectionAssetAdopterFor(assets),
    createId: engine.createId,
    now: options.now,
    ...(protectedValues
      ? {
        runtimeProjections: Object.freeze({
          nodeTypes: Object.freeze([PROTECTED_VALUE_NODE_TYPE]),
          async projectBody(context, namespace, body) {
            for (
              const ref of [
                ...protectedActionLifecycleRefs(body),
                ...protectedEventRefs(body),
              ]
            ) {
              await protectedValues.project(context, namespace, ref);
            }
          },
        }),
      }
      : {}),
  });
  for (const resource of Object.values(options.registry.collections)) {
    if (isKernelCollection(resource)) collections.bind(resource);
  }
  const capabilities: DatabaseScopeCapabilities = Object.freeze({
    assets,
    collections,
    streamBodyStore,
    ...(protectedValues ? { protectedValues } : {}),
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
    async appendProtected(draft, schema, ownerId) {
      const deduplicationId = draft.deduplicationId?.trim();
      if (!deduplicationId) {
        throw new TypeError(
          "Protected Event ingress requires deduplicationId.",
        );
      }
      const prepared = await prepareProtectedEventBody({
        namespace: draft.namespace,
        ownerId,
        data: draft.payload,
        schema,
        protectedValues,
      });
      const bodyId = `event-body:${draft.namespace}:${deduplicationId}`;
      const payload = Object.freeze({
        dataRef: Object.freeze({
          eventBodyId: bodyId,
          schemaVersion: 1,
          mediaType: "application/json" as const,
        }),
      });
      return await coordinator.commitMutation({
        draft: { ...draft, payload },
        matchData: prepared.publicData,
        mutate: async (context) => {
          for (const value of prepared.prepared) {
            await protectedValues!.adopt(context, draft.namespace, value);
          }
          await writeEventBody(context, {
            namespace: draft.namespace,
            id: bodyId,
            json: prepared.body,
          });
        },
        recoverDuplicate: async (event, context) => {
          const existing = await readEventBody(
            context,
            event.namespace,
            eventDataRef(event.payload),
          );
          if (!samePreparedProtectedEventBody(existing, prepared.body)) {
            throw new Error(
              `Protected Event '${event.id}' was retried with different data.`,
            );
          }
        },
      });
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
    async resolve(namespace, id) {
      const event = await store.getEvent(id);
      if (!event || event.namespace !== namespace) return null;
      return await resolveProcessorEvent(store, event);
    },
    async resolveProtected(namespace, id, schema) {
      const event = await store.getEvent(id);
      if (!event || event.namespace !== namespace) return null;
      if (!protectedValues) {
        throw new Error("Protected Event recovery requires a Secret Adapter.");
      }
      return withProcessorEventData(
        event,
        await resolveProtectedEventData({
          store,
          event,
          schema,
          protectedValues,
        }),
      );
    },
    async resolveActionLifecycle(namespace, id) {
      const event = await store.getEvent(id);
      if (!event || event.namespace !== namespace) return null;
      let raw: unknown;
      try {
        raw = await readEventBody(
          { transaction: store.session, tables: store.tables },
          namespace,
          eventDataRef(event.payload),
        );
      } catch {
        return null;
      }
      const parsed = parseActionLifecycleEvent(withProcessorEventData(
        event,
        publicActionLifecycleData(raw),
      ));
      if (!parsed) return null;
      return await hydrateActionLifecycleBody({
        namespace,
        body: raw as never,
        action: actionDefinitionById(options.registry.actions, parsed.actionId),
        protectedValues,
      });
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
  let progressiveMaintenanceAfter: string | undefined;
  let openStreamReconcileAfter: string | undefined;
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
    // Catalog-owned published lanes are reconciled before generic progressive
    // maintenance can settle unknown staging. Publication changes an expired
    // writer from disposable staging into a replay obligation.
    const openStreams = await options.operationCatalog.listOpenStreams({
      ...(openStreamReconcileAfter
        ? { afterReplayKey: openStreamReconcileAfter }
        : {}),
      limit: maintenanceOptions.limit,
    });
    let reconciledStreams = 0;
    for (const stream of openStreams) {
      openStreamReconcileAfter = stream.replayKey;
      const head = await streamBodyStore.head({ bodyId: stream.bodyId });
      const intendedOutcome = stream.state === "terminating"
        ? stream.outcome
        : undefined;
      if (!head) {
        const transitioned = await options.operationCatalog
          .markStreamUnavailable({
            namespace: stream.namespace,
            operationId: stream.operationId,
            streamId: stream.streamId,
            outcome: intendedOutcome === "completed"
              ? "abandoned"
              : intendedOutcome ?? "abandoned",
            availability: "missing",
            capture: stream.capture ?? "truncated",
          });
        if (transitioned) reconciledStreams += 1;
        continue;
      }
      if (head.state === "aborted") {
        const transitioned = await options.operationCatalog
          .markStreamUnavailable({
            namespace: stream.namespace,
            operationId: stream.operationId,
            streamId: stream.streamId,
            outcome: intendedOutcome === "completed"
              ? "abandoned"
              : intendedOutcome ?? "abandoned",
            availability: "purged",
            capture: stream.capture ?? "truncated",
          });
        if (transitioned) reconciledStreams += 1;
        continue;
      }
      if (head.state === "ready") {
        const transitioned = await options.operationCatalog.sealStream({
          namespace: stream.namespace,
          operationId: stream.operationId,
          streamId: stream.streamId,
          body: head,
        });
        if (transitioned) reconciledStreams += 1;
        else if (intendedOutcome && intendedOutcome !== "completed") {
          const unavailable = await options.operationCatalog
            .markStreamUnavailable({
              namespace: stream.namespace,
              operationId: stream.operationId,
              streamId: stream.streamId,
              outcome: intendedOutcome,
              availability: "missing",
              capture: stream.capture ?? "truncated",
            });
          if (unavailable) reconciledStreams += 1;
        }
        continue;
      }
      if (head.state === "incomplete") {
        const outcome = intendedOutcome === "completed"
          ? undefined
          : intendedOutcome ?? "abandoned";
        const transitioned = outcome
          ? await options.operationCatalog.terminateStream({
            namespace: stream.namespace,
            operationId: stream.operationId,
            streamId: stream.streamId,
            body: head,
            outcome,
            capture: stream.capture ?? "truncated",
          })
          : await options.operationCatalog.markStreamUnavailable({
            namespace: stream.namespace,
            operationId: stream.operationId,
            streamId: stream.streamId,
            outcome: "abandoned",
            availability: "missing",
            capture: "truncated",
          });
        if (transitioned) reconciledStreams += 1;
        continue;
      }
      if (head.writerLeaseRemainingMs > 0) continue;
      const outcome = intendedOutcome ??
        (head.state === "sealing" ? "completed" : "abandoned");
      const capture = outcome === "completed"
        ? "complete"
        : stream.capture ?? "truncated";
      if (
        !await options.operationCatalog.beginStreamTerminalization({
          namespace: stream.namespace,
          operationId: stream.operationId,
          streamId: stream.streamId,
          outcome,
          capture,
        })
      ) continue;
      const writer = await streamBodyStore.reserve({
        bodyId: head.bodyId,
        mediaType: head.mediaType,
        expectedGeneration: head.writerGeneration,
      });
      if (outcome === "completed") {
        const ready = await streamBodyStore.seal({
          writer,
          expectedByteLength: head.byteLength,
        });
        if (
          await options.operationCatalog.sealStream({
            namespace: stream.namespace,
            operationId: stream.operationId,
            streamId: stream.streamId,
            body: ready,
          })
        ) reconciledStreams += 1;
      } else {
        const incomplete = await streamBodyStore.terminate({
          writer,
          expectedByteLength: head.byteLength,
        });
        if (
          await options.operationCatalog.terminateStream({
            namespace: stream.namespace,
            operationId: stream.operationId,
            streamId: stream.streamId,
            body: incomplete,
            outcome,
            capture,
          })
        ) reconciledStreams += 1;
      }
    }
    if (
      openStreams.length < (maintenanceOptions.limit ?? 1_000)
    ) openStreamReconcileAfter = undefined;
    const reconciled = await options.operationCatalog.reconcile({
      limit: maintenanceOptions.limit,
    });
    const progressiveBodies = await maintainProgressiveBodies(streamBodyStore, {
      limit: maintenanceOptions.limit,
      ...(progressiveMaintenanceAfter
        ? { after: progressiveMaintenanceAfter }
        : {}),
    });
    progressiveMaintenanceAfter = progressiveBodies.after;
    const assetMaintenance = await assets.maintainBodies({
      now: maintenanceOptions.now,
      orphanAfterMs: maintenanceOptions.assetOrphanAfterMs,
      limit: maintenanceOptions.limit,
      isBodyRetained: (bodyId) =>
        options.operationCatalog.hasStreamBody(bodyId),
    });
    const operationRetentionMs = maintenanceOptions.operationRetentionMs ??
      DEFAULT_OPERATION_REPLAY_RETENTION_MS;
    const expired = maintenanceOptions.operationRetentionMs === null
      ? Object.freeze([])
      : await options.operationCatalog.listExpiredObservationStreams({
        now: maintenanceOptions.now,
        operationRetentionMs,
        limit: maintenanceOptions.operationObservationLimit ??
          maintenanceOptions.limit,
      });
    let prunedCatalogEntries = 0;
    let observationRetirementBlocked = 0;
    const readyGarbageCollection =
      engine.assetStorage?.adapter?.deployment.readyGarbageCollection ?? true;
    for (const stream of expired) {
      if (
        stream.availability === "retained" &&
        !await options.operationCatalog.markStreamPurgePending({
          namespace: stream.namespace,
          operationId: stream.operationId,
          streamId: stream.streamId,
        })
      ) continue;
      const head = await streamBodyStore.head({ bodyId: stream.bodyId });
      let retired = head === null;
      if (head?.state === "ready" && readyGarbageCollection) {
        const retirement = await assets.retireUnownedReadyBody({
          store: streamBodyStore,
          body: head,
        });
        retired = retirement.status !== "blocked";
      } else if (head?.state === "incomplete" || head?.state === "aborted") {
        retired = await streamBodyStore.maintenance.delete({
          bodyId: head.bodyId,
          expectedState: head.state,
          expectedMaintenanceVersion: head.maintenanceVersion,
          idleForMs: 0,
        });
      }
      if (!retired) {
        observationRetirementBlocked += 1;
        // Purge is monotonic. A losing concurrent worker must never restore
        // retained after another worker deleted the Body. Leaving the row
        // purge_pending is crash-safe and makes the exact-CAS retirement
        // retryable on the next maintenance pass.
        continue;
      }
      // A graph-owned Ready Body remains under Asset authority. Other retained
      // terminal Bodies were removed with exact state/version CAS above.
      if (
        await options.operationCatalog.pruneStream({
          namespace: stream.namespace,
          operationId: stream.operationId,
          streamId: stream.streamId,
        })
      ) prunedCatalogEntries += 1;
    }
    const terminal = maintenanceOptions.operationRetentionMs === null
      ? Object.freeze({ streams: 0, events: 0, operations: 0 })
      : await options.operationCatalog.pruneTerminalMetadata({
        now: maintenanceOptions.now,
        retentionMs: operationRetentionMs,
        limit: maintenanceOptions.limit,
      });
    const result: CopilotzEngineMaintenanceResult = Object.freeze({
      recovered: recovery.handles.length,
      dispatchFailures: recovery.failures.length,
      compacted: Object.freeze(compacted),
      progressiveBodies,
      assets: assetMaintenance,
      operations: Object.freeze({
        reconciled,
        reconciledStreams,
        expiredObservationStreams: expired.length,
        observationRetirementBlocked,
        prunedCatalogEntries,
        prunedTerminalStreams: terminal.streams,
        prunedOperationEvents: terminal.events,
        prunedOperations: terminal.operations,
      }),
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
          bodyPrefix: streamBodyPrefix,
        }).follow(input);
        return follower.body;
      },
      async readCommittedRange(input: ReadBodyRangeInput) {
        if (streamBodyStore.readRange) {
          return await streamBodyStore.readRange(input);
        }
        // Compatibility fallback for third-party stores compiled before finite
        // range reads. Never attach their polling follower: wait until an
        // immutable terminal Body, then perform one bounded replay read.
        const head = await streamBodyStore.head({ bodyId: input.bodyId });
        if (head?.state !== "ready" && head?.state !== "incomplete") {
          return null;
        }
        const bytes = await readBodyBytes(streamBodyStore, {
          bodyId: input.bodyId,
        });
        const start = Math.min(input.offset, bytes.byteLength);
        const end = Math.min(input.end, bytes.byteLength);
        return bytes.slice(start, end);
      },
    }),
    operations: options.operationCatalog,
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
    operationCatalog: options.operationCatalog,
  });
}
