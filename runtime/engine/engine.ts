import { isStreamOutputDescriptor } from "../streams/index.ts";
import {
  createActionLifecycleAppender,
  createActionLifecycleEmitter,
  createActionLifecycleLoader,
} from "../actions/index.ts";
import { actionDefinitionHasSecrets } from "../actions/protected-lifecycle.ts";
import { createSecretAdapter } from "../actions/secret-adapter.ts";
import { openProtectedEventBody } from "../actions/protected-event.ts";
import {
  createBodyStorageRuntime,
  createContentPreparer,
} from "../content/index.ts";
import {
  type CopilotzEvent,
  type CopilotzEventHub,
  createCopilotzEventHub,
  createEventStore,
  type EventStore,
  provisionCopilotzSchema,
  validateCopilotzSchema,
} from "../events/index.ts";
import { eventDataRef, readEventBody } from "../events/body-store.ts";
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
import {
  createTransientProcessorSet,
  matchProcessor,
  type Processor,
  type ProcessorContext,
  resolveProcessorEvent,
} from "../plugins/index.ts";
import { createProcessorContext } from "./context.ts";
import {
  createDatabaseScope,
  type DatabaseScopeRuntime,
} from "./database-scope.ts";
import type {
  CopilotzEngine,
  CreateCopilotzEngineOptions,
  EngineContextSeed,
} from "./types.ts";

type AdditionalDatabaseScope = Readonly<{
  runtime: DatabaseScopeRuntime;
  hub: CopilotzEventHub;
}>;

async function prepareDefaultDatabaseSchema(
  options: CreateCopilotzEngineOptions,
  schema: string,
): Promise<void> {
  if (options.provisionDefaultDatabaseSchema === false) {
    await validateCopilotzSchema(options.session, schema);
    return;
  }
  await provisionCopilotzSchema(options.session, schema);
}

/** Composes the event-native Copilotz core without taking session ownership. */
export async function createCopilotzEngine(
  options: CreateCopilotzEngineOptions,
): Promise<CopilotzEngine> {
  const databaseSchema = options.defaultDatabaseSchema ?? "public";
  const configuredSecretAdapter = options.secretAdapter ??
    options.registry.adapters.secrets?.default;
  const secretAdapter = configuredSecretAdapter === undefined
    ? undefined
    : createSecretAdapter(configuredSecretAdapter as never);
  const requiresSecrets = Object.values(options.registry.actions).some(
    actionDefinitionHasSecrets,
  );
  if (requiresSecrets && !secretAdapter) {
    throw new TypeError(
      "Actions with x-copilotz-secret schemas require adapters.secrets.default.",
    );
  }
  const engineOptions: CreateCopilotzEngineOptions = Object.freeze({
    ...options,
    assetStorage: options.assetStorage ??
      createBodyStorageRuntime(options.assets),
    ...(secretAdapter ? { secretAdapter } : {}),
  });
  await prepareDefaultDatabaseSchema(options, databaseSchema);
  const now = options.now ?? (() => new Date());
  const eventHub = options.eventHub ?? createCopilotzEventHub();
  const ownsEventHub = options.eventHub === undefined;

  const configuredTransients = () =>
    createTransientProcessorSet(
      (options.transientProcessors ?? []) as readonly Processor[],
    );
  const transientsBySchema = new Map<
    string,
    ReturnType<typeof createTransientProcessorSet>
  >();
  const transients = configuredTransients();
  transientsBySchema.set(databaseSchema, transients);
  const transientsFor = (schema: string) => {
    const scoped = transientsBySchema.get(schema);
    if (!scoped) {
      throw new Error(
        `Transient processors for schema '${schema}' are not initialized.`,
      );
    }
    return scoped;
  };
  const store: EventStore = createEventStore({
    session: options.session,
    schema: databaseSchema,
    createId: options.createId,
    now,
    random: options.random,
    leaseMs: options.leaseMs,
    maxAttempts: options.maxAttempts,
    retryBaseMs: options.retryBaseMs,
    retryCapMs: options.retryCapMs,
  });
  const additionalScopes = new Map<
    string,
    Promise<AdditionalDatabaseScope>
  >();
  const relayedDurableIds = new Set<string>();
  const relayedDurableOrder: string[] = [];
  let closed = false;
  let resolveAdditionalScope: (
    databaseSchema: string,
  ) => Promise<AdditionalDatabaseScope>;

  let capabilities: DatabaseScopeRuntime["capabilities"] | undefined;
  let primaryRuntime: DatabaseScopeRuntime | undefined;
  const preparer = createContentPreparer({
    createId: options.createId,
    digest: options.digest,
  });
  let resolver:
    | DatabaseScopeRuntime["public"]["content"]["resolver"]
    | undefined;
  const createContextFor = async (
    base: EngineContextSeed,
  ): Promise<ProcessorContext> => {
    const additional = base.databaseSchema === databaseSchema
      ? undefined
      : await resolveAdditionalScope(base.databaseSchema);
    const scopedCapabilities = additional?.runtime.capabilities ?? capabilities;
    const scopedResolver = additional?.runtime.public.content.resolver ??
      resolver;
    const scopedEventHub = additional?.hub ?? eventHub;
    const scopedStore = additional?.runtime.store ?? store;
    const scopedCoordinator = additional?.runtime.coordinator ??
      primaryRuntime?.coordinator;
    if (!scopedCapabilities || !scopedResolver) {
      throw new Error("Copilotz engine context is not initialized.");
    }
    if (!scopedCoordinator) {
      throw new Error("Copilotz action lifecycle is not initialized.");
    }
    return createProcessorContext({
      base,
      registry: options.registry,
      assets: scopedCapabilities.assets,
      preparer,
      resolver: scopedResolver,
      collections: scopedCapabilities.collections,
      streamBodyStore: scopedCapabilities.streamBodyStore,
      eventHub: scopedEventHub,
      async publishOutput(output) {
        if (isStreamOutputDescriptor(output)) {
          await options.publish?.(output, {
            databaseSchema: base.databaseSchema,
            ...(base.settlementScopeId
              ? { settlementScopeId: base.settlementScopeId }
              : {}),
          });
          return;
        }
        const dispatched = await publishLive(output, {
          inline: true,
          signal: base.signal,
          databaseSchema: base.databaseSchema,
          eventHub: scopedEventHub,
          settlementScopeId: base.settlementScopeId,
        });
        await dispatched.done;
      },
      actionLifecycle: createActionLifecycleEmitter({
        namespace: base.event.namespace,
        append: createActionLifecycleAppender({
          coordinator: scopedCoordinator,
          store: scopedStore,
          actions: options.registry.actions,
          protectedValues: scopedCapabilities.protectedValues,
        }),
        load: createActionLifecycleLoader({
          store: scopedStore,
          actions: options.registry.actions,
          protectedValues: scopedCapabilities.protectedValues,
        }),
        metadata: {
          ...(base.event.durable ? { sourceEventId: base.event.id } : {}),
          ...(base.source?.kind === "delivery"
            ? {
              sourceDeliveryId: base.source.id,
              ...(base.source.consumerId
                ? { sourceConsumerId: base.source.consumerId }
                : {}),
            }
            : {}),
          ...(base.source?.kind === "stream"
            ? { sourceStreamId: base.source.id }
            : {}),
          ...(base.source?.kind === "live"
            ? { sourceLiveDispatchId: base.source.id }
            : {}),
        },
      }),
      protectedEventResolver: async () => {
        const eventId = base.event.durable ? base.event.id : undefined;
        if (!eventId) throw new Error("Action source Event is not durable.");
        const event = await scopedStore.getEvent(eventId);
        if (!event || event.namespace !== base.event.namespace) {
          throw new Error("Protected Event is unavailable in this scope.");
        }
        const raw = await readEventBody(
          { transaction: scopedStore.session, tables: scopedStore.tables },
          event.namespace,
          eventDataRef(event.payload),
        );
        return await openProtectedEventBody({
          namespace: event.namespace,
          body: raw,
          protectedValues: scopedCapabilities.protectedValues,
        });
      },
      now,
    });
  };
  const createContext = async (
    base: DeliveryContextBase,
  ): Promise<ProcessorContext> =>
    await createContextFor({
      databaseSchema: base.databaseSchema,
      event: base.event,
      signal: base.signal,
      settlementScopeId: base.settlementScopeId,
      idempotencyKey: base.idempotencyKey,
      createMutationIdentity: base.createMutationIdentity,
      source: {
        kind: "delivery",
        id: base.delivery.id,
        consumerId: base.delivery.consumerId,
      },
    });
  const createLiveContext = async (
    base: LiveProcessorContextBase,
  ): Promise<ProcessorContext> =>
    await createContextFor({
      databaseSchema: base.databaseSchema,
      event: base.event,
      signal: base.signal,
      ...(base.settlementScopeId
        ? { settlementScopeId: base.settlementScopeId }
        : {}),
      idempotencyKey: base.idempotencyKey,
      createMutationIdentity: base.createMutationIdentity,
      source: {
        kind: "live",
        id: base.dispatchAttemptId,
        consumerId: `processor:${base.processorId}`,
      },
    });

  const configuredWorkloads = options.execution?.workloads ?? {};
  const configuredLocalWorkers = options.execution?.localWorkloadWorkers ?? {};
  for (const reserved of [COPILOTZ_LIVE_WORKLOAD]) {
    if (Object.prototype.hasOwnProperty.call(configuredWorkloads, reserved)) {
      throw new TypeError(
        `Execution workload '${reserved}' is reserved by the Copilotz engine.`,
      );
    }
  }
  const executor: DeliveryExecutor = createDeliveryExecutor({
    ...(options.execution ?? {}),
    workloads: Object.freeze({
      ...configuredWorkloads,
      [COPILOTZ_LIVE_WORKLOAD]: createLiveProcessorWorkload({
        registry: options.registry,
        transients,
        createContext: createLiveContext,
      }),
    }),
    localWorkloadWorkers: configuredLocalWorkers,
    resolveStore: async (requestedDatabaseSchema) =>
      requestedDatabaseSchema === databaseSchema
        ? store
        : (await resolveAdditionalScope(requestedDatabaseSchema)).runtime.store,
    defaultDatabaseSchema: databaseSchema,
    registry: options.registry,
    createContext,
    async onOutput(output, context) {
      if (isStreamOutputDescriptor(output)) {
        await options.publish?.(output, context);
        await options.execution?.onOutput?.(output, context);
        return;
      }
      const event = output;
      const additional = context.databaseSchema === databaseSchema
        ? undefined
        : await resolveAdditionalScope(context.databaseSchema);
      const scoped = additional
        ? { store: additional.runtime.store, hub: additional.hub }
        : { store, hub: eventHub };
      const relayKey = event.durable
        ? `${context.databaseSchema}\u0000${event.id}`
        : undefined;
      const publish = relayKey === undefined ||
        !relayedDurableIds.has(relayKey);
      if (relayKey && publish) {
        relayedDurableIds.add(relayKey);
        relayedDurableOrder.push(relayKey);
        if (relayedDurableOrder.length > 10_000) {
          const removed = relayedDurableOrder.shift();
          if (removed) relayedDurableIds.delete(removed);
        }
      }
      if (publish) {
        const resolvedEvent = await resolveProcessorEvent(scoped.store, event);
        const eventData = resolvedEvent.data;
        await scoped.hub.publish(event);
        await invokeLiveProcessors({
          databaseSchema: context.databaseSchema,
          registry: options.registry,
          transients: transientsFor(context.databaseSchema),
          event,
          eventData,
          resolvedEvent,
          signal: new AbortController().signal,
          createContext: createLiveContext,
        }).catch(() => undefined);
        await options.publish?.(resolvedEvent, context);
        await options.execution?.onOutput?.(event, context);
      }
      if (!event.durable) return;
      const deliveries = await scoped.store.listDeliveries({
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
    transients,
    executor,
    defaultDatabaseSchema: databaseSchema,
  });
  const publishLive = async (
    event: CopilotzEvent,
    publishOptions: {
      inline?: boolean;
      signal?: AbortSignal;
      databaseSchema?: string;
      eventHub?: typeof eventHub;
      settlementScopeId?: string;
    } = {},
  ): Promise<LiveEventDispatchHandle> => {
    const scopedDatabaseSchema = publishOptions.databaseSchema ??
      databaseSchema;
    const scopedEventHub = publishOptions.eventHub ?? eventHub;
    const scopedStore = scopedDatabaseSchema === databaseSchema
      ? store
      : (await resolveAdditionalScope(scopedDatabaseSchema)).runtime.store;
    const resolvedEvent = await resolveProcessorEvent(scopedStore, event);
    const eventData = resolvedEvent.data;
    await scopedEventHub.publish(event);
    await options.publish?.(resolvedEvent, {
      databaseSchema: scopedDatabaseSchema,
      ...(publishOptions.settlementScopeId
        ? { settlementScopeId: publishOptions.settlementScopeId }
        : {}),
    });
    // Transient processors are connection-local. Never place them on a Worker.
    const abort = new AbortController();
    const relay = () => abort.abort(publishOptions.signal?.reason);
    if (publishOptions.signal?.aborted) relay();
    else {
      publishOptions.signal?.addEventListener("abort", relay, {
        once: true,
      });
    }
    const scopedTransients = transientsFor(scopedDatabaseSchema);
    const done = invokeLiveProcessors({
      databaseSchema: scopedDatabaseSchema,
      registry: options.registry,
      transients: scopedTransients,
      event,
      eventData,
      resolvedEvent,
      signal: abort.signal,
      settlementScopeId: publishOptions.settlementScopeId,
      createContext: createLiveContext,
    }).finally(() => {
      publishOptions.signal?.removeEventListener("abort", relay);
    });
    done.catch(() => undefined);
    return Object.freeze({
      event,
      processorIds: Object.freeze(
        scopedTransients.match(event, eventData).map((processor) =>
          processor.id
        ),
      ),
      done,
      async cancel(reason = "live_event_cancelled") {
        abort.abort(new Error(reason));
        await done.catch(() => undefined);
      },
    });
  };
  try {
    const scope = createDatabaseScope({
      databaseSchema,
      store,
      engine: engineOptions,
      registry: options.registry,
      executor,
      preparer,
      eventHub,
      now,
      transients,
      publishLive: (event, settlementScopeId) =>
        publishLive(event, { settlementScopeId }),
    });
    primaryRuntime = scope;
    capabilities = scope.capabilities;
    resolver = scope.public.content.resolver;

    resolveAdditionalScope = (requested: string) => {
      const normalized = requested.trim();
      if (!normalized) {
        throw new TypeError("Database schema must be non-empty.");
      }
      const existing = additionalScopes.get(normalized);
      if (existing) return existing;
      if (closed) throw new Error("Copilotz engine is shut down.");
      const hub = createCopilotzEventHub();
      const pending = (async () => {
        try {
          // Selecting a tenant scope is a request-path operation. It must never
          // acquire DDL locks or implicitly create tenant infrastructure.
          await validateCopilotzSchema(options.session, normalized);
          const scopedTransients = configuredTransients();
          transientsBySchema.set(normalized, scopedTransients);
          const runtime = createDatabaseScope({
            databaseSchema: normalized,
            engine: engineOptions,
            registry: options.registry,
            executor,
            preparer,
            eventHub: hub,
            now,
            transients: scopedTransients,
            publishLive: (event, settlementScopeId) =>
              publishLive(event, {
                databaseSchema: normalized,
                eventHub: hub,
                settlementScopeId,
              }),
          });
          return Object.freeze({ runtime, hub });
        } catch (error) {
          transientsBySchema.delete(normalized);
          hub.close(error);
          throw error;
        }
      })().catch((error) => {
        transientsBySchema.delete(normalized);
        if (additionalScopes.get(normalized) === pending) {
          additionalScopes.delete(normalized);
        }
        throw error;
      });
      additionalScopes.set(normalized, pending);
      return pending;
    };
    const engine: CopilotzEngine = {
      ...scope.public,
      databaseSchema,
      async databaseScope(requestedDatabaseSchema) {
        if (requestedDatabaseSchema.trim() === databaseSchema) return engine;
        return (await resolveAdditionalScope(requestedDatabaseSchema)).runtime
          .public;
      },
      plugins: options.registry,
      execution: Object.freeze({
        ownership: executor.ownership,
        workload: executor.workload,
        liveWorkload: liveDispatcher.workload,
        workloads: executor.workloads,
        dispatchWork: (input) => executor.dispatchWork(input),
        settleOutputs: (scope) => executor.settleOutputs(scope),
      }),
      async recoverAll(recovery = {}) {
        const scoped = await Promise.allSettled([...additionalScopes.values()]);
        const unavailableScopes = scoped.flatMap((result) =>
          result.status === "rejected" ? [result.reason] : []
        );
        if (unavailableScopes.length) {
          throw new AggregateError(
            unavailableScopes,
            "Could not resolve every Copilotz database scope for recovery.",
          );
        }
        const results = await Promise.all([
          scope.public.recover(recovery),
          ...scoped.flatMap((result) =>
            result.status === "fulfilled"
              ? [result.value.runtime.public.recover(recovery)]
              : []
          ),
        ]);
        return Object.freeze({
          handles: Object.freeze(results.flatMap((result) => result.handles)),
          failures: Object.freeze(
            results.flatMap((result) => result.failures),
          ),
        });
      },
      async bindTransient(processor: Processor, bindOptions = {}) {
        if (bindOptions.afterPosition === undefined) {
          return transients.add(processor);
        }
        const namespace = bindOptions.namespace?.trim();
        if (!namespace) {
          throw new TypeError("Transient catch-up requires a namespace.");
        }
        let catchingUp = true;
        const handled = new Set<string>();
        let serial = Promise.resolve();
        const catchupProcessor: Processor = Object.freeze({
          id: processor.id,
          on: processor.on,
          settlement: processor.settlement,
          handle(event, context) {
            const next = serial.then(async () => {
              const eventId = event.durable ? event.id : undefined;
              if (catchingUp && eventId && handled.has(eventId)) return;
              await processor.handle(event, context);
              if (catchingUp && eventId) handled.add(eventId);
            });
            serial = next.catch(() => undefined);
            return next;
          },
        });
        const unbind = transients.add(catchupProcessor);
        const solo = createTransientProcessorSet([catchupProcessor]);
        const signal = bindOptions.signal ?? new AbortController().signal;
        let afterPosition = bindOptions.afterPosition;
        try {
          while (true) {
            const events = await store.listEvents({
              namespace,
              afterPosition,
              limit: 1_000,
            });
            for (const event of events) {
              const resolvedEvent = await resolveProcessorEvent(store, event);
              const eventData = resolvedEvent.data;
              if (!matchProcessor(catchupProcessor, event, eventData)) continue;
              await invokeLiveProcessors({
                databaseSchema,
                registry: options.registry,
                transients: solo,
                event,
                eventData,
                resolvedEvent,
                signal,
                createContext: createLiveContext,
              });
            }
            if (events.length < 1_000) break;
            const nextPosition = events.at(-1)?.position;
            if (!nextPosition || nextPosition === afterPosition) {
              throw new Error("Transient catch-up pagination did not advance.");
            }
            afterPosition = nextPosition;
          }
          await serial;
          catchingUp = false;
          handled.clear();
          return unbind;
        } catch (error) {
          unbind();
          throw error;
        }
      },
      async shutdown(reason = "copilotz_engine_shutdown") {
        if (closed) return;
        closed = true;
        const scoped = await Promise.allSettled([...additionalScopes.values()]);
        await executor.shutdown(reason);
        for (const result of scoped) {
          if (result.status === "fulfilled") result.value.hub.close();
        }
        if (ownsEventHub) eventHub.close();
      },
    };
    return Object.freeze(engine);
  } catch (error) {
    await executor.shutdown("copilotz_engine_initialization_failed").catch(
      () => undefined,
    );
    if (ownsEventHub) eventHub.close(error);
    throw error;
  }
}
