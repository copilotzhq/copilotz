import { authorizeOperation } from "../authorization/operation.ts";
import { withOwnerCommandAuthorization } from "./command-authorization.ts";
import { awaitEventPublication } from "../events/coordinator.ts";
import { captureCollectionInvocation } from "../authorization/invocation.ts";
import { sameActionValue } from "../actions/value.ts";
import { constrainCollection } from "../authorization/collection-constraints.ts";
import { validateCollectionInput } from "../collections/validate.ts";
import { captureHostCommandJson } from "../application/host-command-json.ts";
import { createAuthorizationOwner } from "../authorization/owner.ts";
import {
  authorizationRefused,
  collectionAuthorizations,
  createOwnerEvaluator,
} from "../authorization/evaluator.ts";
import { prepareRemoteAdmission } from "../execution/remote-admission.ts";
import { admitInlineAction } from "../application/ingress/inline-action.ts";
import { completeHostCollection } from "../application/ingress/inline-collection.ts";
import { createAuthorizedActions } from "../actions/authorized-capture.ts";
import {
  assertOwnerIngressReplay,
  hostIngressProof,
  ownerIngressEvidence,
} from "../application/ingress/authority.ts";
import { readLogicalHead } from "../content/catalog.ts";
import { registerDeliveryAlarms } from "../execution/alarms.ts";
import { registerCollectionAlarms } from "../collections/alarms.ts";
import { completeOwnerDeadline, invalidateOwnerAlarm } from "./alarms.ts";
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
    deferPublication: (publish) => deferPublication(publish)(),
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
    policies: collectionAuthorizations(
      engine.authorization,
      options.registry.collections,
      databaseSchema,
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
  const appendProtected:
    CopilotzEngineDatabaseScope["events"]["appendProtected"] = async (
      draft,
      schema,
      ownerId,
      ingress,
      completion,
      inlineAction,
    ) => {
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
      const remoteClaim = inlineAction && engine.execution?.dispatcher
        ? prepareRemoteAdmission(
          engine.execution.dispatcher,
          engine.execution.workload ?? "copilotz.delivery.v1",
          engine.execution.target?.workerId,
        )
        : undefined;
      const commit = (
        transaction?: import("../events/session.ts").SqlExecutor,
      ) =>
        createSchemaCommandRunner(
          transaction ?? store.session,
          databaseSchema,
          () => Promise.resolve(options.owner),
        )(
          "ingress.authorize",
          {},
          async (_, command) => {
            const authority = ownerIngressEvidence(ingress)?.authority;
            let accepted = draft;
            if (authority) {
              if (!engine.authorization) authorizationRefused();
              const constraints = (await createOwnerEvaluator({
                registration: engine.authorization,
                collections: options.registry.collections,
                databaseSchema,
              })(authority, {
                kind: draft.type.includes("collection")
                  ? "collection"
                  : "action",
                resource: String(
                  (payload as Record<string, unknown>).actionAlias ??
                    (payload as Record<string, unknown>).collectionAlias ??
                    draft.type,
                ),
                operation: "admit",
                input: captureHostCommandJson(payload),
              }, command)).constraints;
              const request = payload as Record<string, unknown>;
              let validatedInput = request.input;
              if (typeof request.actionAlias === "string") {
                const policy = constraints.actions?.[request.actionAlias];
                if (!policy) authorizationRefused();
                if (policy.input) {
                  const supplied = request.input as Record<string, unknown>;
                  for (const [key, value] of Object.entries(policy.input)) {
                    if (
                      Object.hasOwn(supplied, key) &&
                      !sameActionValue(supplied[key], value)
                    ) authorizationRefused();
                  }
                  validatedInput = { ...supplied, ...policy.input };
                }
              } else if (typeof request.collectionAlias === "string") {
                const mutation =
                  constraints.collectionMutations?.[request.collectionAlias] ??
                    constraints.collectionMutations
                      ?.[
                        options.registry.collections[request.collectionAlias]
                          .name
                      ];
                const allowed = request.operation === "command"
                  ? mutation?.commands?.[String(request.command)]
                  : mutation
                    ?.[request.operation as "create" | "update" | "delete"];
                if (!allowed) authorizationRefused();
                const constrained = constrainCollection({
                  collection: {
                    alias: request.collectionAlias,
                    name: options.registry.collections[request.collectionAlias]
                      .name,
                  },
                  phase: "mutation",
                  method: request.operation as
                    | "create"
                    | "update"
                    | "delete"
                    | "command",
                  args: captureHostCommandJson(
                    request.operation === "create"
                      ? { input: request.input }
                      : request.operation === "command"
                      ? {
                        id: request.id,
                        name: request.command,
                        input: request.input,
                      }
                      : { ...request.input as object, id: request.id },
                  ),
                }, constraints) as Record<string, unknown>;
                validatedInput = request.operation === "create" ||
                    request.operation === "command"
                  ? constrained.input
                  : request.input;
              }
              if (schema) {
                try {
                  validateCollectionInput(schema, {
                    ...request,
                    input: validatedInput,
                  }, "Protected request input");
                } catch (error) {
                  if (
                    (error as { code?: string }).code ===
                      "collection_validation_failed"
                  ) Object.assign(error as object, { status: 422 });
                  throw error;
                }
              }
              const metadata = { ...draft.metadata };
              const operationMetadata = {
                ...(metadata.operationMetadata as Record<string, unknown> ??
                  {}),
                ...constraints.operations?.metadata,
              };
              if (constraints.admission) {
                operationMetadata.httpAdmissionKey = constraints.admission.key;
                operationMetadata.httpIdempotencyKey = deduplicationId;
              }
              if (constraints.observationKeys) {
                metadata.observationKeys = [...constraints.observationKeys];
              }
              // Empty policy output must preserve an older admission's exact
              // metadata so its immutable deduplication identity still replays.
              if (
                Object.keys(operationMetadata).length ||
                Object.hasOwn(metadata, "operationMetadata")
              ) {
                metadata.operationMetadata = operationMetadata;
              }
              accepted = { ...draft, metadata };
            }
            return await coordinator.commitMutation({
              transaction: command.transaction,
              ...(remoteClaim ? { initialRemoteClaim: remoteClaim } : {}),
              ...(inlineAction && !engine.execution?.dispatcher
                ? {
                  initialLocalClaim: {
                    consumerId: "processor:copilotz.server.action-request",
                    owner: crypto.randomUUID(),
                  },
                }
                : {}),
              ...(completion
                ? {
                  consumers: options.registry.durableConsumers(
                    draft,
                    prepared.publicData,
                  ).filter((consumer) =>
                    consumer.consumerId !==
                      "processor:copilotz.server.collection-mutation-request"
                  ),
                }
                : {}),
              eventId,
              draft: { ...accepted, payload: persistedPayload },
              ingress,
              matchData: prepared.publicData,
              body: { id: bodyId, json: prepared.body },
              mutate: async (context) => {
                for (const value of prepared.prepared) {
                  await protectedValues!.adopt(context, draft.namespace, value);
                }
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
        );
      if (inlineAction && (!engine.execution?.dispatcher || remoteClaim)) {
        return await admitInlineAction(
          {
            store,
            coordinator,
            registry: options.registry,
            protectedValues,
            authorization: engine.authorization,
            operationCatalog: options.operationCatalog,
            owner: options.owner,
          },
          draft,
          commit,
        );
      }
      if (!completion) return await commit();
      return await completeHostCollection(
        {
          store,
          collections,
          catalog: options.operationCatalog,
          registry: options.registry,
          signal: options.owner.signal,
          owner: options.owner,
          protectedValues,
        },
        draft,
        prepared.body,
        completion,
        commit,
      );
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
      const binding = captureCollectionInvocation()?.authority;
      if (binding) {
        if (
          binding.scope.databaseSchema !== databaseSchema ||
          binding.scope.namespace !== draft.namespace
        ) authorizationRefused();
        const ingress = hostIngressProof();
        return (async () => {
          const committed = await createSchemaCommandRunner(
            store.session,
            databaseSchema,
            () => Promise.resolve(options.owner),
          )("ingress.event", {}, async (_, command) => {
            if (!engine.authorization) authorizationRefused();
            const decision = await createOwnerEvaluator({
              registration: engine.authorization,
              collections: options.registry.collections,
              databaseSchema,
            })(binding, {
              kind: "event",
              resource: draft.type,
              operation: "admit",
              input: draft.payload,
            }, command);
            if (!decision.constraints.events?.includes(draft.type)) {
              authorizationRefused();
            }
            return await coordinator.commitMutation({
              transaction: command.transaction,
              draft: {
                ...draft,
                metadata: {
                  ...draft.metadata,
                  operationMetadata: {
                    ...(draft.metadata?.operationMetadata as Record<
                      string,
                      unknown
                    > ?? {}),
                    ...decision.constraints.operations?.metadata,
                  },
                  ...(decision.constraints.observationKeys
                    ? {
                      observationKeys: [
                        ...decision.constraints.observationKeys,
                      ],
                    }
                    : {}),
                },
              },
              ingress,
              maxAttempts: appendOptions?.maxAttempts,
              recoverDuplicate: async (event, context) => {
                await assertOwnerIngressReplay(
                  context,
                  databaseSchema,
                  event,
                  event.payload,
                  ingress,
                );
              },
            });
          });
          await awaitEventPublication(committed);
          return committed;
        })();
      }
      return coordinator.commitMutation({
        draft,
        // Host Events retain their origin so descendant execution does not
        // become unclassified when unbound Collections fail closed.
        ingress: hostIngressProof(),
        maxAttempts: appendOptions?.maxAttempts,
      });
    },
    appendProtected,
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
      const data =
        Object.keys(options.engine.authorization?.actions ?? {}).some((alias) =>
            options.registry.actions[alias]?.id === parsed.actionId
          )
          ? await createSchemaCommandRunner(
            store.session,
            options.databaseSchema,
            () => Promise.resolve(options.owner),
          )(
            "actions.readAuthorizedResult",
            {},
            async (_, command) => {
              const guard = createAuthorizedActions({
                authorization: options.engine.authorization,
                collections: options.registry.collections,
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
    cancel: (namespace, settlementScopeId, reason) => {
      const binding = captureCollectionInvocation()?.authority;
      if (!binding) {
        return store.cancelScope(namespace, settlementScopeId, reason);
      }
      if (
        binding.scope.namespace !== namespace ||
        binding.scope.databaseSchema !== databaseSchema
      ) authorizationRefused();
      const evaluate = engine.authorization &&
        createOwnerEvaluator({
          registration: engine.authorization,
          collections: options.registry.collections,
          databaseSchema,
        });
      return withOwnerCommandAuthorization(async (command) => {
        await authorizeOperation(
          evaluate,
          options.operationCatalog,
          binding,
          settlementScopeId,
          "cancel",
          command,
        );
      }, () => store.cancelScope(namespace, settlementScopeId, reason));
    },
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
        head && logical?.terminal &&
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
    authorization: createAuthorizationOwner({
      session: engine.session,
      databaseSchema,
      owner: options.owner,
      registration: engine.authorization,
      collections: options.registry.collections,
      operations: options.operationCatalog,
    }),
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
      await recoverCatalog({ limit: 100 });
      await assets.maintainBodies({
        limit: 100,
        isBodyRetained: (bodyId) =>
          options.operationCatalog.hasStreamBody(bodyId),
      });
      await runAlarmCommand("alarm.content.refresh", {}, (_input, context) => {
        invalidateOwnerAlarm(context.transaction, databaseSchema, "content");
      });
    },
  });
  const runAlarmCommand = createSchemaCommandRunner(
    engine.session,
    databaseSchema,
  );
  const collectionAlarms = registerCollectionAlarms({
    authorization: engine.authorization,
    aliases: options.registry.collections,
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
        const settled = await options.operationCatalog.reconcile({
          namespace: deadline.namespace ?? undefined,
          operationId,
          limit: 1000,
        });
        if (settled) continue;
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
          publicScope.authorization.notice({
            namespace: frame.change.namespace,
            collection: frame.change.event.subject?.type,
            id: frame.change.event.subject?.id,
          });
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
            invalidateOwnerAlarm(transaction, databaseSchema, "content");
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
        // Retained declarations still need a cutover/declaration seed. The
        // migration API does not yet attest that this seed completed.
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
