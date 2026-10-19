import type { CollectionProjectionRegistrations } from "../collections/projection-registration.ts";
import { validateCollectionPolicies } from "../collections/policy-registration.ts";
import { createProtectedActions } from "../actions/protected-actions.ts";
import {
  assertOwnerIngressReplay,
  recordOwnerIngress,
} from "../application/ingress/authority.ts";
import { readLogicalHead } from "../content/catalog.ts";
import { registerDeliveryAlarms } from "../execution/alarms.ts";
import { registerCollectionAlarms } from "../collections/alarms.ts";
import { completeOwnerDeadline } from "./alarms.ts";
import {
  attachOwnerPush,
  type OwnerPushSubscription,
  watchOwnerPush,
} from "../events/push.ts";
import {
  activateDatabaseOwner,
  type CommandContext,
  createSchemaCommandRunner,
  type DatabaseOwner,
} from "./commands.ts";
import { scheduleResumptions } from "../actions/continuation-work.ts";
import {
  cancelScopeActions,
  recoverDeliveryActions,
} from "../actions/recovery.ts";
import {
  assetBodySchemaPrefix,
  type BodyStore,
  type ContentPreparer,
  createContentResolver,
  createDatabaseAssetRepository,
  createDatabaseBodyStore,
  type DatabaseAssetRepository,
  maintainProgressiveBodies,
  type ReadBodyRangeInput,
} from "../content/index.ts";
import { collectionAssetAdopterFor } from "../content/database-repository.ts";
import {
  type ContentStreamFollowInput,
  createContentStreamRuntime,
  DEFAULT_OPERATION_REPLAY_RETENTION_MS,
} from "../streams/index.ts";
import {
  createOperationCatalogTables,
  type OperationCatalog,
} from "../streams/catalog.ts";
import {
  isRegisteredActionLifecycleEventType,
  isReservedActionLifecycleDeduplicationId,
} from "../actions/index.ts";
import {
  createProtectedValueRuntime,
  type ProtectedValueRuntime,
} from "../actions/protected-value.ts";
import {
  actionDefinitionById,
  hydrateActionLifecycleBody,
  publicActionLifecycleData,
} from "../actions/protected-lifecycle.ts";
import {
  prepareProtectedEventBody,
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
  matchesCopilotzEvent,
  waitForCopilotzEvent,
} from "../events/index.ts";
import { eventDataRef, readEventBody } from "../events/body-store.ts";
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
import {
  hydrateProcessorEventContent,
  resolveProcessorEvent,
} from "../plugins/index.ts";
import { readViews } from "../collections/read-view.ts";
import { canonicalizeContentRefs } from "../content/input.ts";
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
  owner: DatabaseOwner;
  activate(): Promise<void>;
  closePush(): void;
  publishActivation(): Promise<void>;
  closeAlarms(): void;
  deferPublication(publish: () => Promise<void>): () => Promise<void>;
  public: CopilotzEngineDatabaseScope;
  store: EventStore;
  coordinator: EventCoordinator;
  capabilities: DatabaseScopeCapabilities;
  streamBodyStore: BodyStore;
  transients: TransientProcessorSet;
  operationCatalog: OperationCatalog;
  onScopeCancellation: NonNullable<
    Parameters<typeof createEventStore>[0]["onScopeCancellation"]
  >;
  resumeSettled(
    input?: Readonly<
      { namespace?: string; operationId?: string; limit?: number }
    >,
  ): Promise<void>;
  settleActionOwners: NonNullable<
    Parameters<typeof createEventStore>[0]["settleActionOwners"]
  >;
}>;

export type CreateDatabaseScopeOptions = Readonly<{
  collectionProjections?: CollectionProjectionRegistrations;
  owner: DatabaseOwner;
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
    actionScopeId?: string,
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
  const store: EventStore = options.store ?? createEventStore({
    session: engine.session,
    schema: databaseSchema,
    createId: engine.createId,
    now: options.now,
    random: engine.random,
    leaseMs: engine.leaseMs,
    maxAttempts: engine.maxAttempts,
    retryBaseMs: engine.retryBaseMs,
    retryCapMs: engine.retryCapMs,
    onScopeCancellation: (transaction, input) =>
      onScopeCancellation(transaction, input),
    settleActionOwners: (transaction, delivery) =>
      settleActionOwners(transaction, delivery),
    admitOperationEventSql: (input, param) =>
      options.operationCatalog.admitEventSql(input, param),
    indexOperationEvent: (transaction, input) =>
      options.operationCatalog.indexEvent(transaction, input),
    indexOperationEventSql: (input, param) =>
      options.operationCatalog.indexEventSql(input, param),
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
        context?.actionScopeId,
      );
      await dispatched.done;
    },
    onDispatchFailure: engine.onDispatchFailure,
  });
  const activationPublications: Array<() => Promise<void>> = [];
  const deferPublication = (publish: () => Promise<void>) => async () => {
    if (options.owner.state === "acquired") {
      activationPublications.push(publish);
    } else await publish();
  };
  const onScopeCancellation: DatabaseScopeRuntime["onScopeCancellation"] = (
    transaction,
    input,
  ) =>
    cancelScopeActions(
      {
        store,
        coordinator,
        catalog: options.operationCatalog,
        actions: options.registry.actions,
        protectedValues,
      },
      transaction,
      input,
    );
  const settleActionOwners: DatabaseScopeRuntime["settleActionOwners"] = (
    transaction,
    delivery,
  ) => settleDelivery(transaction, delivery);
  const settleDelivery: DatabaseScopeRuntime["settleActionOwners"] = async (
    transaction: CommandContext["transaction"],
    delivery,
  ) => {
    const recovered = await recoverDeliveryActions(
      {
        store,
        coordinator,
        catalog: options.operationCatalog,
        actions: options.registry.actions,
        protectedValues,
      },
      transaction,
      delivery,
    );
    const advanced = await scheduleResumptions(
      { store, coordinator, catalog: options.operationCatalog },
      { operationId: delivery.settlementScopeId },
      transaction,
    );
    return deferPublication(async () => {
      await recovered();
      await advanced();
    });
  };
  const resumeSettled: DatabaseScopeRuntime["resumeSettled"] = async (
    input = {},
  ) => {
    const flush = await scheduleResumptions({
      store,
      coordinator,
      catalog: options.operationCatalog,
    }, input);
    await deferPublication(flush)();
  };
  const assets = createDatabaseAssetRepository({
    coordinator,
    session: engine.session,
    eventStore: store,
    databaseSchema,
    createId: engine.createId,
    now: engine.now,
    digest: engine.digest,
    storage: engine.assetStorage,
    readViews,
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
  assets.registerStore(streamBodyStore);
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
    projections: options.collectionProjections,
    policies: validateCollectionPolicies(
      engine.collectionPolicies,
      options.registry.collections,
    ),
    coordinator,
    session: engine.session,
    eventStore: store,
    assets: collectionAssetAdopterFor(assets),
    contentResolver: resolver,
    createId: engine.createId,
    now: options.now,
  });
  for (const resource of Object.values(options.registry.collections)) {
    if (isKernelCollection(resource)) collections.bind(resource);
  }
  const capabilities: DatabaseScopeCapabilities = {
    assets,
    collections,
    streamBodyStore,
    ...(protectedValues ? { protectedValues } : {}),
  } as const;
  const deliveryInNamespace = async (namespace: string, id: string) => {
    const delivery = await store.getDelivery(id);
    if (!delivery) return null;
    const event = await store.getEvent(delivery.eventId);
    return event?.namespace === namespace ? delivery : null;
  };
  const events: CopilotzEngineDatabaseScope["events"] = {
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
      return coordinator.append({
        ...draft,
        payload: canonicalizeContentRefs(draft.payload),
        ...(draft.delta === undefined
          ? {}
          : { delta: canonicalizeContentRefs(draft.delta) }),
      }, appendOptions);
    },
    async appendProtected(draft, schema, ownerId, ingress) {
      if (
        isReservedActionLifecycleDeduplicationId(draft.deduplicationId) ||
        isRegisteredActionLifecycleEventType(
          draft.type,
          options.registry.actions,
        )
      ) {
        throw new TypeError(
          "Protected Event ingress cannot publish runtime-owned Action events.",
        );
      }
      const deduplicationId = draft.deduplicationId?.trim();
      if (!deduplicationId) {
        throw new TypeError(
          "Protected Event ingress requires deduplicationId.",
        );
      }
      const payload = canonicalizeContentRefs(draft.payload);
      const prepared = await prepareProtectedEventBody({
        namespace: draft.namespace,
        ownerId,
        data: payload,
        schema,
        protectedValues,
      });
      const bodyId = `event-body:${draft.namespace}:${deduplicationId}`;
      const persistedPayload = {
        dataRef: {
          eventBodyId: bodyId,
          schemaVersion: 1,
          mediaType: "application/json" as const,
        } as const,
      } as const;
      const eventId = crypto.randomUUID();
      return await coordinator.commitMutation({
        eventId,
        draft: { ...draft, payload: persistedPayload },
        matchData: prepared.publicData,
        body: { id: bodyId, json: prepared.body },
        mutate: async (context) => {
          for (const value of prepared.prepared) {
            await protectedValues!.adopt(context, draft.namespace, value);
          }
          await recordOwnerIngress(
            context,
            options.databaseSchema,
            { ...draft, id: eventId, payload: persistedPayload },
            prepared.body,
            ingress,
          );
        },
        recoverDuplicate: async (event, context) => {
          const existing = await readEventBody(
            context,
            event.namespace,
            eventDataRef(event.payload),
          );
          await assertOwnerIngressReplay(
            context,
            options.databaseSchema,
            event,
            existing,
            ingress,
          );
          if (!samePreparedProtectedEventBody(existing, prepared.body)) {
            throw Object.assign(
              new Error(
                `Protected Event '${event.id}' was retried with different data.`,
              ),
              { code: "event_deduplication_conflict" },
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
      const { timeoutMs, ...filter } = filterInput;
      let afterPosition = filter.afterPosition;
      const deadline = timeoutMs === undefined
        ? undefined
        : Date.now() + timeoutMs;
      return waitForCopilotzEvent({
        hub: options.eventHub,
        filter,
        signal,
        timeoutMs,
        ...(filter.durable === false ? {} : {
          attachDurable: () =>
            watchOwnerPush(engine.session, databaseSchema, {
              namespace: filter.namespace,
              relevant: (change) =>
                !!change.event && matchesCopilotzEvent(change.event, filter),
            }),
          loadDurable: async () => {
            for (;;) {
              signal?.throwIfAborted();
              if (deadline !== undefined && Date.now() >= deadline) {
                throw new Error(
                  `Timed out waiting for event after ${timeoutMs}ms.`,
                );
              }
              const page = await store.listEvents({
                namespace: filter.namespace,
                metadata: filter.metadata,
                correlationId: filter.correlationId,
                afterPosition,
                afterSeq: filter.afterSeq,
                limit: 1_000,
              });
              const match = page.find((event) =>
                matchesCopilotzEvent(event, filter)
              );
              if (match) return [match];
              afterPosition = page.at(-1)?.position ?? afterPosition;
              if (page.length < 1_000) return [];
            }
          },
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
      return await resolveProcessorEvent(store, event, resolver);
    },
    async resolveProtected(namespace, id, schema) {
      const event = await store.getEvent(id);
      if (!event || event.namespace !== namespace) return null;
      if (!protectedValues) {
        throw new Error("Protected Event recovery requires a Secret Adapter.");
      }
      return withProcessorEventData(
        event,
        await hydrateProcessorEventContent(
          await resolveProtectedEventData({
            store,
            event,
            schema,
            protectedValues,
          }),
          resolver,
          namespace,
        ),
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
      const restore = (
        transaction?: import("../events/session.ts").SqlExecutor,
      ) =>
        hydrateActionLifecycleBody({
          namespace,
          body: raw as never,
          action: actionDefinitionById(
            options.registry.actions,
            parsed.actionId,
          ),
          protectedValues,
          transaction,
        });
      const data = options.engine.protectedActions?.[parsed.actionId]
        ? await createSchemaCommandRunner(
          store.session,
          options.databaseSchema,
        )(
          "actions.readAuthorizedResult",
          {},
          async (_, command) => {
            const guard = createProtectedActions({
              definitions: options.engine.protectedActions ?? {},
              streamBodyPrefix,
              collections: {
                runtime: collections,
                definitions: options.registry.collections,
              },
              actions: options.registry.actions,
              store,
              coordinator,
              namespace,
              protectedValues,
              signal: command.signal,
            }).output({
              actionId: parsed.actionId,
              actionRunId: parsed.actionRunId,
              parentActionRunId: parsed.parentActionRunId,
              signal: command.signal,
            });
            await guard.authorize?.(command.transaction);
            return await restore(command.transaction);
          },
        )
        : await restore();
      if (data.status !== "completed") return data;
      return {
        ...data,
        output: await hydrateProcessorEventContent(
          data.output,
          resolver,
          namespace,
        ),
      };
    },
    list: (listOptions) => store.listEvents(listOptions),
    settlement: (namespace, settlementScopeId) =>
      store.scopeSettlement(namespace, settlementScopeId),
    outstanding: (namespace, settlementScopeId) =>
      store.scopeOutstanding(namespace, settlementScopeId),
    cancel: (namespace, settlementScopeId, reason) =>
      store.cancelScope(namespace, settlementScopeId, reason),
  } as const;
  const deliveries: CopilotzEngineDatabaseScope["deliveries"] = {
    get: deliveryInNamespace,
    list: (listOptions) => store.listDeliveries(listOptions),
  } as const;
  const recover: CopilotzEngineDatabaseScope["recover"] = async (
    recovery = {},
  ) => {
    await options.operationCatalog.reconcile({
      namespace: recovery.namespace,
      limit: recovery.limit,
    });
    await resumeSettled({
      namespace: recovery.namespace,
      limit: recovery.limit,
    });
    return await coordinator.recover({ ...recovery, databaseSchema });
  };
  let progressiveMaintenanceAfter: string | undefined;
  let openStreamReconcileAfter: string | undefined;
  const recoverCatalog = async (
    maintenanceOptions: { limit?: number } = {},
  ) => {
    const recoveredBodies = await maintainProgressiveBodies(
      {
        ...assets.catalog,
        async recordFailure(content) {
          const stream = (await engine.session.query<{
            namespace: string;
            operation_id: string;
            stream_id: string;
          }>(
            `SELECT namespace,operation_id,stream_id FROM ${
              createOperationCatalogTables(databaseSchema).operationStreams
            }
            WHERE body_id=$1`,
            [content.bodyId],
          )).rows[0];
          return stream
            ? await options.operationCatalog.acceptStreamFailure({
              namespace: stream.namespace,
              operationId: stream.operation_id,
              streamId: stream.stream_id,
              content,
            })
            : await assets.catalog.recordFailure(content);
        },
      },
      assets.storeForCopy,
      {
        limit: maintenanceOptions.limit,
        ...(progressiveMaintenanceAfter
          ? { after: progressiveMaintenanceAfter }
          : {}),
      },
    );
    progressiveMaintenanceAfter = recoveredBodies.after;
    const openStreams = await options.operationCatalog.listOpenStreams({
      ...(openStreamReconcileAfter
        ? { afterReplayKey: openStreamReconcileAfter }
        : {}),
      limit: maintenanceOptions.limit,
    });
    let reconciledStreams = 0;
    for (const stream of openStreams) {
      openStreamReconcileAfter = stream.replayKey;
      const observed = await readLogicalHead(
        assets.catalog,
        stream.bodyId,
        assets.storeForCopy,
      );
      const logical = observed?.body, physical = observed?.head;
      if (!logical?.terminal) continue;
      if (
        !physical || physical.state === "aborted" ||
        physical.byteLength < logical.terminal.length
      ) {
        if (
          await options.operationCatalog.markStreamUnavailable({
            namespace: stream.namespace,
            operationId: stream.operationId,
            streamId: stream.streamId,
            outcome: logical.terminal.outcome,
            reason: logical.terminal.reason,
            availabilityReason: "missing",
          })
        ) reconciledStreams++;
        continue;
      }
      const common = {
        namespace: stream.namespace,
        operationId: stream.operationId,
        streamId: stream.streamId,
      };
      const terminal = logical.terminal;
      if (terminal.outcome === "completed") {
        if (
          physical.state !== "ready" || physical.digest !== terminal.digest ||
          physical.byteLength !== terminal.length
        ) continue;
        if (
          await options.operationCatalog.sealStream({
            ...common,
            body: { ...physical, bodyId: stream.bodyId },
          })
        ) reconciledStreams++;
      } else {
        const body = {
          ...physical,
          state: "incomplete" as const,
          bodyId: stream.bodyId,
          byteLength: terminal.length,
        };
        if (
          await options.operationCatalog.terminateStream({
            ...common,
            body,
            outcome: terminal.outcome,
            reason: terminal.reason ?? "abandoned",
          })
        ) reconciledStreams++;
      }
    }
    if (
      openStreams.length < (maintenanceOptions.limit ?? 1_000)
    ) openStreamReconcileAfter = undefined;
    await resumeSettled({ limit: maintenanceOptions.limit });
    const reconciled = await options.operationCatalog.reconcile({
      limit: maintenanceOptions.limit,
    });
    return {
      reconciledStreams,
      reconciled,
      progressiveBodies: recoveredBodies,
    };
  };
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
    const { reconciledStreams, reconciled, progressiveBodies } =
      await recoverCatalog(
        maintenanceOptions,
      );
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
      ? ([] as const)
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
        stream.cleanupState !== "pending" &&
        !await options.operationCatalog.beginStreamCleanup({
          namespace: stream.namespace,
          operationId: stream.operationId,
          streamId: stream.streamId,
        })
      ) continue;
      const logical = await assets.catalog.read(stream.bodyId);
      const physicalStore = logical
        ? assets.storeForCopy(logical.copy)
        : streamBodyStore;
      const head = logical
        ? await physicalStore.head({ bodyId: logical.copy.key })
        : null;
      let retired = head === null;
      if (
        head &&
        (head.state === "ready" || head.state === "incomplete" ||
          head.state === "aborted") &&
        physicalStore.conditionalDelete &&
        (head.state !== "ready" || readyGarbageCollection)
      ) {
        const retirement = await assets.retireUnownedReadyBody({
          store: physicalStore,
          body: head,
        });
        if (retirement.status === "owned" && retirement.ownerType === "asset") {
          await options.operationCatalog.retainStream({
            namespace: stream.namespace,
            operationId: stream.operationId,
            streamId: stream.streamId,
            retention: "canonical",
            assetId: retirement.ownerId,
          });
          continue;
        }
        retired = retirement.status === "deleted";
      }
      if (!retired) {
        observationRetirementBlocked += 1;
        // Keep cleanup pending until deletion is confirmed. A failed CAS may
        // mean another worker won; the next pass checks the physical head.
        continue;
      }
      // Deletion was confirmed by exact state/version CAS or a missing head.
      if (
        await options.operationCatalog.pruneStream({
          namespace: stream.namespace,
          operationId: stream.operationId,
          streamId: stream.streamId,
          availabilityReason: head === null ? "missing" : "deleted",
        })
      ) prunedCatalogEntries += 1;
    }
    const terminal = maintenanceOptions.operationRetentionMs === null
      ? ({ streams: 0, events: 0, operations: 0 } as const)
      : await options.operationCatalog.pruneTerminalMetadata({
        now: maintenanceOptions.now,
        retentionMs: operationRetentionMs,
        limit: maintenanceOptions.limit,
      });
    const result: CopilotzEngineMaintenanceResult = {
      recovered: recovery.handles.length,
      dispatchFailures: recovery.failures.length,
      compacted: compacted,
      progressiveBodies,
      assets: assetMaintenance,
      operations: {
        reconciled,
        reconciledStreams,
        expiredObservationStreams: expired.length,
        observationRetirementBlocked,
        prunedCatalogEntries,
        prunedTerminalStreams: terminal.streams,
        prunedOperationEvents: terminal.events,
        prunedOperations: terminal.operations,
      } as const,
    } as const;
    return result;
  };
  const publicScope: CopilotzEngineDatabaseScope = {
    databaseSchema,
    content: { assets, preparer: options.preparer, resolver } as const,
    collections,
    streams: {
      async follow(namespace: string, input: ContentStreamFollowInput) {
        const follower = await createContentStreamRuntime({
          namespace,
          store: streamBodyStore,
          catalog: assets.catalog,
          storeForCopy: assets.storeForCopy,
          createId: engine.createId,
          bodyPrefix: streamBodyPrefix,
        }).follow(input);
        return follower.body;
      },
      async readCommittedRange(input: ReadBodyRangeInput) {
        const logical = await assets.catalog.read(input.bodyId);
        if (!logical) return null;
        const limit = logical.terminal?.length ?? logical.committedOffset;
        if (input.end > limit) return null;
        let copy = logical.copy;
        try {
          return await assets.storeForCopy(copy).readRange({
            ...input,
            bodyId: copy.key,
          });
        } catch (error) {
          const next = await assets.catalog.read(input.bodyId);
          if (!next || next.copy.key === copy.key) throw error;
          copy = next.copy;
          return await assets.storeForCopy(copy).readRange({
            ...input,
            bodyId: copy.key,
          });
        }
      },
    } as const,
    operations: options.operationCatalog,
    events,
    deliveries,
    recover,
    maintenance,
  } as const;

  const closeContentAlarms = options.owner.registerAlarmSource({
    name: "content",
    nextDeadline: (transaction) => assets.catalog.nextDeadline(transaction),
    wake: async () => {
      await maintenance({ limit: 100 });
    },
  });
  const runAlarmCommand = createSchemaCommandRunner(
    engine.session,
    databaseSchema,
  );
  const collectionAlarms = registerCollectionAlarms({
    owner: options.owner,
    session: engine.session,
    schema: databaseSchema,
    definitions: Object.values(options.registry.collections).filter(
      isKernelCollection,
    ),
    collections,
    now: options.now,
    onDiagnostic: engine.execution?.onDiagnostic,
  });
  const closeDeliveryAlarms = registerDeliveryAlarms(
    options.owner,
    store,
    options.executor,
  );
  const closeReconciliationAlarms = options.owner.registerAlarmSource({
    name: "reconciliation",
    async wake(deadlines) {
      for (const deadline of deadlines) {
        const operationId =
          (deadline.payload as { operationId?: string } | null)?.operationId;
        await options.operationCatalog.reconcile({
          namespace: deadline.namespace ?? undefined,
          operationId,
          limit: 1000,
        });
        await resumeSettled({
          namespace: deadline.namespace ?? undefined,
          operationId,
          limit: 1000,
        });
        await runAlarmCommand(
          "alarm.reconciliation.complete",
          {},
          (_input, context) =>
            completeOwnerDeadline(
              context.transaction,
              databaseSchema,
              deadline,
            ),
        );
      }
    },
  });
  let pushSubscription: OwnerPushSubscription | undefined;
  let pushedHead: string | undefined;
  const activate = async () => {
    pushSubscription ??= await attachOwnerPush(
      engine.session,
      databaseSchema,
      (frame) => {
        const lost = pushedHead !== undefined &&
          BigInt(frame.headSeq) >
            BigInt(pushedHead) +
              (frame.kind === "change" && frame.change.event ? 1n : 0n);
        if (lost || frame.kind === "reset") {
          options.eventHub.reset(
            Object.assign(
              new Error("Owner push reset; reattach from the consumed cursor."),
              { code: "observation_reset_required" },
            ),
          );
        }
        if (
          pushedHead === undefined || BigInt(frame.headSeq) > BigInt(pushedHead)
        ) pushedHead = frame.headSeq;
        if (frame.kind === "change" && frame.change.event) {
          void options.eventHub.publish(frame.change.event);
        }
      },
    );
    pushedHead ??= pushSubscription.cursor;
    try {
      await activateDatabaseOwner(options.owner, async () => {
        await createSchemaCommandRunner(engine.session, databaseSchema)(
          "owner.invalidateAttempts",
          {},
          async (_input, { transaction, caller }) => {
            const future = await transaction.query(
              `SELECT id FROM ${store.tables.event_deliveries}
          WHERE status IN ('pending','retry_wait','leased') AND owner_epoch > $1::bigint LIMIT 1`,
              [caller.epoch],
            );
            if (future.rows.length) {
              throw Object.assign(
                new Error(
                  "Retained delivery authority is ahead of the current owner epoch.",
                ),
                { code: "delivery_future_epoch" },
              );
            }
            await transaction.query(
              `UPDATE ${store.tables.event_deliveries}
          SET lease_expires_at=NOW(), updated_at=NOW()
          WHERE status='leased' AND owner_epoch < $1`,
              [caller.epoch],
            );
            await transaction.query(
              `INSERT INTO ${store.tables.owner_deadlines} (owner,source,key,namespace,due_at,payload)
            SELECT 'schema','deliveries',d.id,e.namespace,
              CASE WHEN d.status='leased' THEN d.lease_expires_at ELSE d.available_at END,
              jsonb_build_object('deliveryId',d.id)
            FROM ${store.tables.event_deliveries} d JOIN ${store.tables.events} e ON e.id=d.event_id
            WHERE (d.status IN ('pending','retry_wait') AND d.attempts<d.max_attempts)
              OR (d.status='leased' AND d.lease_expires_at IS NOT NULL)
            ON CONFLICT (owner,source,key) DO UPDATE SET due_at=EXCLUDED.due_at,namespace=EXCLUDED.namespace,payload=EXCLUDED.payload,revision=EXCLUDED.revision`,
            );
          },
        );
        // Seed only after retained authority passed the fenced integrity check.
        await collectionAlarms.seed();
        while (
          (await store.recoverExpiredDeliveries({ limit: 1000 })).length ===
            1000
        ) { /* recover every exhausted attempt */ }
        do {
          await recoverCatalog({ limit: 1000 });
        } while (openStreamReconcileAfter !== undefined);
        while (
          await options.operationCatalog.reconcile({ limit: 1000 })
        ) { /* bounded pages across all namespaces */ }
        for (;;) {
          const pending = await engine.session.query(
            `SELECT 1 FROM ${store.tables.open_actions} AS action
          JOIN ${
              createOperationCatalogTables(databaseSchema).operations
            } AS child
          ON child.namespace=action.namespace AND child.operation_id=action.child_operation_id
          WHERE action.state='awaiting' AND action.owner_delivery_id IS NULL
            AND child.state IN ('completed','failed','cancelled') LIMIT 1`,
          );
          if (!pending.rows.length) break;
          await resumeSettled({ limit: 1000 });
        }
      });
    } catch (error) {
      pushSubscription?.close();
      pushSubscription = undefined;
      throw error;
    }
  };
  const publishActivation = async () => {
    for (const publish of activationPublications.splice(0)) await publish();
  };
  return ({
    owner: options.owner,
    activate,
    closePush() {
      pushSubscription?.close();
      pushSubscription = undefined;
    },
    publishActivation,
    closeAlarms() {
      closeContentAlarms();
      collectionAlarms.close();
      closeDeliveryAlarms();
      closeReconciliationAlarms();
    },
    deferPublication,
    public: publicScope,
    store,
    coordinator,
    capabilities,
    streamBodyStore,
    transients: options.transients,
    operationCatalog: options.operationCatalog,
    settleActionOwners,
    resumeSettled,
    onScopeCancellation,
  } as const);
}
