import type { DatabaseOwner } from "../engine/commands.ts";
import { runIndependentAsyncContext } from "../../dependencies/async-hooks.ts";
import type { OwnerIngressProof } from "./ingress/authority.ts";
import { hostDatabaseScopes } from "./database-scopes.ts";
import { createHostServices } from "./host.ts";
import { withApplicationIngress } from "./ingress/registry.ts";
import { createSharedOperationReaders } from "./operation-readers.ts";
import {
  type CopilotzPersistenceLifecycleCallbacks,
  type OpenCopilotzPersistence,
  openCopilotzPersistence,
} from "@copilotz/copilotz/persistence";
import { type CopilotzEngine, createCopilotzEngine } from "../engine/index.ts";
import { createPluginRegistry } from "../plugins/index.ts";
import {
  type ApplicationOutput,
  type ApplicationOutputDescriptor,
  isStreamOutputDescriptor,
  type StreamOutput,
} from "../streams/index.ts";
import {
  createOperationReplayCursorTracker,
  decodeOperationReplayCursor,
  encodeOperationReplayCursor,
} from "../streams/index.ts";
import type {
  OperationCatalog,
  OperationRecord,
  OperationStreamRecord,
} from "../streams/index.ts";
import type {
  ApplicationMaintenanceOptions,
  ApplicationOperationCheckpointInput,
  ApplicationOperationListInput,
  ApplicationOperationScope,
  ApplicationOperationStatus,
  ApplicationSendHandle,
  ApplicationSendInput,
  CreateCopilotzApplicationOptions,
  InternalCopilotzApplication,
} from "./types.ts";
import type { ActionSchema } from "../actions/index.ts";

export function observeApplicationPersistence(
  persistence: OpenCopilotzPersistence,
  application: Pick<
    InternalCopilotzApplication,
    "interruptPersistence" | "recoverAll"
  >,
  options: Readonly<{ recoverDurable?: boolean }> = {},
): () => void {
  return persistence.recovery?.register({
    onUnavailable: (error) => application.interruptPersistence(error),
    async onReady() {
      if (options.recoverDurable === false) return;
      await application.recoverAll({ limit: 1_000 });
    },
  }) ?? (() => undefined);
}

function optionalText(value: string | undefined, name: string) {
  if (value === undefined) return undefined;
  const normalized = value.trim();
  if (!normalized) throw new TypeError(`${name} must be non-empty.`);
  return normalized;
}

function requiredNamespace(
  explicit: string | undefined,
  fallback: string | undefined,
): string {
  const namespace = explicit?.trim() || fallback;
  if (!namespace) {
    throw new TypeError(
      `A tenant namespace is required on the application or operation. Pass one to createCopilotz, for example createCopilotz({ namespace: "my-app" }); any string works for a single-tenant app. Copilotz keeps each namespace's data separate and never chooses one for you.`,
    );
  }
  return namespace;
}

function requiredType(value: string): string {
  const type = value.trim();
  if (!type) throw new TypeError("Input envelope type must be non-empty.");
  return type;
}

const OPERATION_STREAM_PAGE_SIZE = 1_000;

async function listAllOperationStreams(
  catalog: OperationCatalog,
  namespace: string,
  operationId: string,
  afterStreamOrdinal?: string,
): Promise<readonly OperationStreamRecord[]> {
  const result: OperationStreamRecord[] = [];
  while (true) {
    const page = await catalog.listStreams({
      namespace,
      operationId,
      ...(afterStreamOrdinal ? { afterStreamOrdinal } : {}),
      limit: OPERATION_STREAM_PAGE_SIZE,
    });
    result.push(...page);
    if (page.length < OPERATION_STREAM_PAGE_SIZE) break;
    afterStreamOrdinal = page.at(-1)!.streamOrdinal;
  }
  return result;
}

/** A terminal status the observer may never await must not reject unhandled. */
function optionalTerminal<T>(terminal: Promise<T>): Promise<T> {
  terminal.catch(() => undefined);
  return terminal;
}

function lazyStreamFollower(
  open: () => Promise<ReadableStream<Uint8Array>>,
): ReadableStream<Uint8Array> {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let opening: Promise<ReadableStreamDefaultReader<Uint8Array>> | undefined;
  const getReader = () =>
    // Acquisition belongs to this observer even when a later consumer starts it.
    opening ??= runIndependentAsyncContext(open).then((stream) => {
      reader = stream.getReader();
      return reader;
    });
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = await getReader().then((value) => value.read());
      if (next.done) controller.close();
      else controller.enqueue(next.value);
    },
    async cancel(reason) {
      const active = reader ?? await opening?.catch(() => undefined);
      await active?.cancel(reason).catch(() => undefined);
    },
  });
}

/** Names the failure behind a dead-lettered settlement scope. */
async function deadLetterError(
  eventScope: Pick<CopilotzEngine, "deliveries">,
  namespace: string,
  settlementScopeId: string,
): Promise<Error> {
  const [first] = await eventScope.deliveries.list({
    namespace,
    settlementScopeId,
    status: "dead_letter",
    limit: 1,
  }).catch(() => []);
  const cause = typeof first?.lastError?.message === "string"
    ? ` ${first.consumerId}: ${first.lastError.message}`
    : "";
  return new Error(
    `Settlement scope '${settlementScopeId}' contains dead-lettered work.${cause}`,
    first?.lastError ? { cause: first.lastError } : undefined,
  );
}

async function waitForApplicationScope(
  eventScope: Pick<CopilotzEngine, "events" | "deliveries" | "operations">,
  namespace: string,
  settlementScopeId: string,
  signal: AbortSignal,
): Promise<void> {
  // Subscribe before reading state so a commit between the read and wait is
  // retained by the watch. Output completion alone is too early: the owner
  // reconciles durable settlement only after the output relay has drained.
  const watch = await eventScope.operations.watch(settlementScopeId, {
    namespace,
    // Event and stream-byte hints cannot terminalize the operation. Avoid a
    // status query per output frame while waiting for the settlement owner.
    kind: "operation",
  });
  try {
    while (true) {
      signal.throwIfAborted();
      const operation = await eventScope.operations.get(
        namespace,
        settlementScopeId,
      );
      if (!operation) {
        throw new Error(`Operation '${settlementScopeId}' was not found.`);
      }
      if (operation.state === "failed") {
        throw await deadLetterError(eventScope, namespace, settlementScopeId);
      }
      if (operation.state === "cancelled") {
        throw new Error(
          `Settlement scope '${settlementScopeId}' was cancelled.`,
        );
      }
      if (operation.state === "completed") return;
      await eventScope.events.outstanding(namespace, settlementScopeId);
      // Notifications are hints, never settlement authority. Keep the existing
      // bounded poll for remote writers, missed hints and notification outages.
      await watch.wait({ timeoutMs: 250, signal });
    }
  } finally {
    watch.close();
  }
}

type ApplicationOutputFilter = Readonly<{
  databaseSchema?: string;
  namespace?: string;
  correlationId?: string;
}>;

type ApplicationOutputSubscription = Readonly<{
  outputs: ReadableStream<ApplicationOutput>;
  close(): void;
  error(reason: unknown): void;
}>;

type ApplicationOutputHub = Readonly<{
  subscribe(filter?: ApplicationOutputFilter): ApplicationOutputSubscription;
  emit(
    output: ApplicationOutputDescriptor | StreamOutput,
    databaseSchema: string,
  ): Promise<void>;
  close(): void;
}>;

function createApplicationOutputHub(
  projectStream: (
    output: Extract<ApplicationOutputDescriptor, { type: "stream.output" }>,
    databaseSchema: string,
  ) => Promise<ApplicationOutput>,
): ApplicationOutputHub {
  type SubscriptionState = {
    filter: ApplicationOutputFilter;
    controller?: ReadableStreamDefaultController<ApplicationOutput>;
    closed: boolean;
  };
  const subscriptions = new Set<SubscriptionState>();
  let closed = false;

  const close = () => {
    if (closed) return;
    closed = true;
    for (const subscription of subscriptions) {
      subscription.closed = true;
      try {
        subscription.controller?.close();
      } catch {
        // A consumer may have already cancelled its observation stream.
      }
    }
    subscriptions.clear();
  };

  return ({
    subscribe(filter = {}) {
      const subscription: SubscriptionState = {
        filter: { ...filter } as const,
        closed: false,
      };
      const outputs = new ReadableStream<ApplicationOutput>({
        start(controller) {
          subscription.controller = controller;
          if (closed) {
            subscription.closed = true;
            controller.close();
            return;
          }
          subscriptions.add(subscription);
        },
        cancel() {
          subscription.closed = true;
          subscriptions.delete(subscription);
        },
      }, { highWaterMark: 256 });
      const finish = (reason?: unknown) => {
        if (subscription.closed) return;
        subscription.closed = true;
        subscriptions.delete(subscription);
        try {
          if (reason === undefined) subscription.controller?.close();
          else subscription.controller?.error(reason);
        } catch {
          // A consumer may have already cancelled its observation stream.
        }
      };
      return ({
        outputs,
        close: () => finish(),
        error: finish,
      } as const);
    },
    async emit(output, databaseSchema) {
      if (closed) return;
      for (const subscription of subscriptions) {
        const { filter } = subscription;
        if (
          filter.databaseSchema !== undefined &&
          filter.databaseSchema !== databaseSchema
        ) continue;
        if (
          filter.namespace !== undefined &&
          filter.namespace !== output.namespace
        ) continue;
        if (
          filter.correlationId !== undefined &&
          filter.correlationId !== output.correlationId
        ) continue;
        try {
          // Published observation outlives the producer capability call. Its
          // follower and terminal wait must not borrow that call's authority.
          const projected = isStreamOutputDescriptor(output)
            ? await runIndependentAsyncContext(() =>
              projectStream(output, databaseSchema)
            )
            : output;
          subscription.controller?.enqueue(projected);
        } catch (error) {
          subscription.closed = true;
          subscriptions.delete(subscription);
          try {
            subscription.controller?.error(error);
          } catch {
            // A consumer may have already cancelled its observation stream.
          }
        }
      }
    },
    close,
  } as const);
}

/**
 * Composes the normal embedded Copilotz runtime from plugins and a database.
 * Filesystem/package resolution and database construction remain adapters.
 */
export async function createCopilotzApplication(
  options: CreateCopilotzApplicationOptions,
  lifecycle: CopilotzPersistenceLifecycleCallbacks =
    options.databaseLifecycle ?? {},
  beforeRecovery?: (engine: CopilotzEngine) => void | Promise<void>,
): Promise<InternalCopilotzApplication> {
  const requestedScopes = hostDatabaseScopes(
    options.databaseScopes,
  );
  const persistence = await openCopilotzPersistence(options, lifecycle);
  const namespace = optionalText(options.namespace, "Namespace");
  const databaseSchema = optionalText(
    options.databaseSchema,
    "Database schema",
  ) ?? "public";
  const registry = withApplicationIngress(createPluginRegistry({
    plugins: options.plugins,
    collections: options.collections,
    actions: options.actions,
    processors: options.processors,
    views: options.views,
    resources: options.resources,
    adapters: options.adapters,
  }));
  const configuredPublish = options.engine?.publish;

  let engine: CopilotzEngine;
  const owners = new Map<string, DatabaseOwner>();
  const retiredEngines = new Set<Promise<void>>();
  let replacement: Promise<void> | undefined;
  const transientBindings = new Set<{
    processor: Parameters<CopilotzEngine["bindTransient"]>[0];
    dispose(): void;
  }>();
  // Stream terminal waits outlive their observer; shutdown ends them before
  // persistence closes.
  let operationReaders:
    | ReturnType<typeof createSharedOperationReaders>
    | undefined;
  const lifetime = new AbortController();
  const outputHub = createApplicationOutputHub(async (output, schema) => {
    const scoped = await openRecoveredScope(schema);
    return ({
      ...output,
      payload: lazyStreamFollower(() =>
        scoped.streams.follow(output.namespace, {
          id: output.streamId,
        })
      ),
      terminal: optionalTerminal(
        scoped.operations.waitForStreamTerminal(
          output.namespace,
          output.streamId,
          { signal: lifetime.signal },
        ),
      ),
    } as const);
  });
  const constructEngine = (replacing = false) =>
    createCopilotzEngine({
      ...(options.engine ?? {}),
      ...(options.onDeliveryDiagnostic
        ? {
          execution: {
            ...(options.engine?.execution ?? {}),
            onDiagnostic: options.onDeliveryDiagnostic,
          },
        }
        : {}),
      session: persistence.session,
      protectedActions: options.protectedActions,
      collectionPolicies: options.collectionPolicies,
      registry,
      defaultDatabaseSchema: databaseSchema,
      assets: options.assets,
      async publish(event, context) {
        await outputHub.emit(event, context?.databaseSchema ?? databaseSchema);
        await configuredPublish?.(event, context);
      },
      async publishLocalStream(stream, context) {
        await outputHub.emit(stream, context.databaseSchema);
      },
    }, {
      ownerAcquired(schema, owner) {
        owners.set(schema, owner);
      },
      async beforeRecovery(next) {
        if (replacing) await installSuccessor(next);
        await beforeRecovery?.(next);
      },
    });
  try {
    engine = await constructEngine();
  } catch (error) {
    outputHub.close();
    await persistence.close("copilotz_application_initialization_failed").catch(
      () => undefined,
    );
    throw error;
  }

  const scopeRecoveries = new Map<string, Promise<void>>();
  let recoveryOwner = false;
  async function openRecoveredScope(
    requestedDatabaseSchema: string,
  ): Promise<Awaited<ReturnType<CopilotzEngine["databaseScope"]>>> {
    const schema = requestedDatabaseSchema.trim();
    const scoped = schema === databaseSchema
      ? engine
      : await engine.databaseScope(schema);
    let recovery = recoveryOwner ? scopeRecoveries.get(schema) : undefined;
    if (recoveryOwner && !recovery) {
      recovery = scoped.recover({ limit: 1_000 }).then(() => undefined);
      scopeRecoveries.set(schema, recovery);
      void recovery.catch(() => {
        if (scopeRecoveries.get(schema) === recovery) {
          scopeRecoveries.delete(schema);
        }
      });
    }
    await recovery;
    return scoped;
  }

  const activeSends = new Map<
    ApplicationSendHandle,
    Readonly<{
      subscription: ApplicationOutputSubscription;
      abort: AbortController;
    }>
  >();
  const interruptActiveSends = (error: unknown): void => {
    for (const { subscription, abort } of activeSends.values()) {
      subscription.error(error);
      if (!abort.signal.aborted) abort.abort(error);
    }
  };
  let shutdownTask: Promise<void> | undefined;
  let stopObservingPersistence: () => void = () => undefined;
  const shutdown = (reason = "copilotz_application_shutdown") => {
    if (shutdownTask) return shutdownTask;
    stopObservingPersistence();
    shutdownTask = (async () => {
      // Shutting down this application is not a caller-directed cancellation of
      // durable work.  Interrupt only this application's local observers and
      // settlement waiters; another Gateway/Worker may recover the scope.
      lifetime.abort(new Error(reason));
      await operationReaders?.close(reason);
      interruptActiveSends(new Error(reason));
      activeSends.clear();
      // Owner alarms and execution callbacks may still use persistence while
      // draining. Teardown must happen after that drain, even on failure.
      await replacement?.catch(() => undefined);
      const settled = [
        ...(await Promise.allSettled([
          engine.shutdown(reason),
          ...retiredEngines,
        ])),
        ...(await Promise.allSettled([persistence.close(reason)])),
      ];
      outputHub.close();
      const failures = settled.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : []
      );
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) {
        throw new AggregateError(
          failures,
          "Copilotz application shutdown failed.",
        );
      }
    })();
    shutdownTask.catch(() => undefined);
    return shutdownTask;
  };
  const sendWithProtection = async (
    input: ApplicationSendInput,
    protection?: Readonly<
      {
        schema: ActionSchema;
        ownerId: string;
        ingress?: OwnerIngressProof;
        completion?:
          import("./ingress/inline-collection.ts").InlineCollectionCompletion;
        inline?: boolean;
      }
    >,
  ): Promise<ApplicationSendHandle> => {
    if (protection) input = structuredClone(input);
    await persistence.recovery?.admit();
    const inputType = requiredType(input.type);
    const inputNamespace = requiredNamespace(input.namespace, namespace);
    const inputDatabaseSchema = input.databaseSchema?.trim() || databaseSchema;
    const correlationId = input.correlationId?.trim() || crypto.randomUUID();
    const subscription = outputHub.subscribe({
      databaseSchema: inputDatabaseSchema,
      namespace: inputNamespace,
      correlationId,
    });
    let committed;
    try {
      const scopedEngine = await openRecoveredScope(inputDatabaseSchema);
      const draft = {
        type: inputType,
        namespace: inputNamespace,
        payload: structuredClone(input.payload),
        metadata: {
          source: "application.input",
          ...(input.metadata ? structuredClone(input.metadata) : {}),
          ...(input.operationMetadata
            ? {
              operationMetadata: structuredClone(input.operationMetadata),
            }
            : {}),
        },
        correlationId,
        ...(input.causationId?.trim()
          ? { causationId: input.causationId.trim() }
          : {}),
        ...(input.deduplicationId?.trim()
          ? { deduplicationId: input.deduplicationId.trim() }
          : {}),
      };
      committed = protection
        ? await scopedEngine.events.appendProtected(
          draft,
          protection.schema,
          protection.ownerId,
          protection.ingress,
          protection.completion,
          protection.inline,
        )
        : await scopedEngine.events.append(draft);
    } catch (error) {
      subscription.error(error);
      throw error;
    }
    if (protection?.completion && !protection.completion.deferred) {
      subscription.close();
      return {
        operationId: committed.event.id,
        eventId: committed.event.id,
        correlationId,
        replayCursor: encodeOperationReplayCursor({
          eventPosition: committed.event.position,
        }),
        outputs: subscription.outputs,
        done: Promise.resolve(),
        detach: () => Promise.resolve(),
        cancel: () => Promise.resolve(),
      };
    }
    const abort = new AbortController();
    const settlementScopeId = committed.settlementScopeId;
    const eventScope = await openRecoveredScope(inputDatabaseSchema);
    // Root admission with no consumers has no delivery completion to wake
    // settlement. This is part of send, never of a status read.
    if (
      !committed.deliveries.some((delivery) =>
        delivery.settlementScopeId === settlementScopeId
      )
    ) {
      await eventScope.operations.reconcile({
        namespace: inputNamespace,
        operationId: settlementScopeId,
      });
    }
    const done = (async () => {
      if (protection?.inline && committed.dispatch.handles.length) {
        await Promise.all(
          committed.dispatch.handles.map((handle) => handle.done),
        );
        await eventScope.operations.reconcile({
          namespace: inputNamespace,
          operationId: settlementScopeId,
        });
        const operation = await eventScope.operations.get(
          inputNamespace,
          settlementScopeId,
        );
        if (operation?.state === "completed") return;
      }
      await waitForApplicationScope(
        eventScope,
        inputNamespace,
        settlementScopeId,
        abort.signal,
      );
    })().finally(() => {
      subscription.close();
      activeSends.delete(sendHandle);
    });
    // A caller may deliberately consume only `outputs`.  Keep a shutdown or
    // persistence interruption from becoming an unhandled rejected promise;
    // the original `done` promise remains observable to callers.
    void done.catch(() => undefined);
    const sendHandle: ApplicationSendHandle = {
      operationId: committed.event.id,
      eventId: committed.event.id,
      correlationId,
      replayCursor: encodeOperationReplayCursor({
        eventPosition: committed.event.position,
      }),
      outputs: subscription.outputs,
      done,
      async detach(reason = "application_send_detached") {
        subscription.close();
        if (!abort.signal.aborted) abort.abort(new Error(reason));
        await done.catch(() => undefined);
      },
      async cancel(reason = "application_send_cancelled") {
        if (!abort.signal.aborted) abort.abort(new Error(reason));
        await (await openRecoveredScope(inputDatabaseSchema)).events.cancel(
          inputNamespace,
          settlementScopeId,
          reason,
        );
        await eventScope.operations.reconcile({
          namespace: inputNamespace,
          operationId: settlementScopeId,
        });
        await done.catch(() => undefined);
      },
    } as const;
    activeSends.set(sendHandle, { subscription, abort } as const);
    return sendHandle;
  };
  const send = (input: ApplicationSendInput) => sendWithProtection(input);

  const operationBoundary = async (input: ApplicationOperationScope) => {
    await persistence.recovery?.admit();
    const operationId = optionalText(input.operationId, "Operation id")!;
    const operationNamespace = requiredNamespace(input.namespace, namespace);
    const operationDatabaseSchema = input.databaseSchema?.trim() ||
      databaseSchema;
    const scope = await openRecoveredScope(operationDatabaseSchema);
    return ({
      operationId,
      namespace: operationNamespace,
      databaseSchema: operationDatabaseSchema,
      scope,
    } as const);
  };

  const projectOperationStatus = (
    record: OperationRecord,
  ): ApplicationOperationStatus => {
    const candidate = record.metadata.operationMetadata;
    const metadata = candidate && typeof candidate === "object" &&
        !Array.isArray(candidate)
      ? structuredClone(candidate as Record<string, unknown>)
      : {};
    return ({
      operationId: record.operationId,
      namespace: record.namespace,
      correlationId: record.correlationId,
      state: record.state,
      metadata: metadata,
      acceptedAt: record.acceptedAt,
      updatedAt: record.updatedAt,
      ...(record.completedAt ? { completedAt: record.completedAt } : {}),
    } as const);
  };

  const statusFor = async (
    boundary: Awaited<ReturnType<typeof operationBoundary>>,
  ): Promise<ApplicationOperationStatus | null> => {
    const record = await boundary.scope.operations.get(
      boundary.namespace,
      boundary.operationId,
    );
    return record ? projectOperationStatus(record) : null;
  };

  const operationStatus = async (input: ApplicationOperationScope) =>
    await statusFor(await operationBoundary(input));

  const listOperations = async (
    input: ApplicationOperationListInput = {},
  ): Promise<readonly ApplicationOperationStatus[]> => {
    await persistence.recovery?.admit();
    const operationNamespace = requiredNamespace(input.namespace, namespace);
    const requestedDatabaseSchema = input.databaseSchema?.trim() ||
      databaseSchema;
    const scope = await openRecoveredScope(requestedDatabaseSchema);
    const records = await scope.operations.list({
      namespace: operationNamespace,
      operationIds: input.operationIds,
      states: input.states,
      metadata: input.metadata
        ? { operationMetadata: structuredClone(input.metadata) }
        : undefined,
      limit: input.limit,
    });
    return (records.map(projectOperationStatus));
  };

  const cancelOperation = async (
    input: ApplicationOperationScope & Readonly<{ reason?: string }>,
  ): Promise<ApplicationOperationStatus | null> => {
    const boundary = await operationBoundary(input);
    if (
      !await boundary.scope.operations.get(
        boundary.namespace,
        boundary.operationId,
      )
    ) return null;
    const reason = input.reason?.trim() || "application_operation_cancelled";
    await boundary.scope.events.cancel(
      boundary.namespace,
      boundary.operationId,
      reason,
    );
    await boundary.scope.operations.reconcile({
      namespace: boundary.namespace,
      operationId: boundary.operationId,
    });
    return await statusFor(boundary);
  };

  const operationCheckpoint = async (
    input: ApplicationOperationCheckpointInput,
  ): Promise<string> => {
    await persistence.recovery?.admit();
    const operationNamespace = requiredNamespace(input.namespace, namespace);
    const requestedDatabaseSchema = input.databaseSchema?.trim() ||
      databaseSchema;
    const scope = await openRecoveredScope(requestedDatabaseSchema);
    const operationIds = [
      ...new Set(
        input.operationIds.map((operationId) =>
          optionalText(operationId, "Operation id")!
        ),
      ),
    ];
    let checkpoint = decodeOperationReplayCursor(input.cursor);
    if (operationIds.length > 0) {
      const operations = await scope.operations.list({
        namespace: operationNamespace,
        operationIds,
        limit: operationIds.length,
      });
      const found = new Set(
        operations.map((operation) => operation.operationId),
      );
      const missing = operationIds.find((operationId) =>
        !found.has(operationId)
      );
      if (missing) {
        throw Object.assign(new Error("Operation was not found."), {
          status: 404,
          code: "operation_not_found",
        });
      }
      for (const operationId of operationIds) {
        const streams = await listAllOperationStreams(
          scope.operations,
          operationNamespace,
          operationId,
        );
        const tracker = createOperationReplayCursorTracker(checkpoint);
        for (const stream of streams) {
          const position = tracker.streamPosition({
            operationId,
            streamOrdinal: stream.streamOrdinal,
          });
          tracker.commit([
            {
              kind: "operation-stream",
              action: "register",
              operationId,
              streamOrdinal: stream.streamOrdinal,
              offset: position.offset,
            },
            ...(stream.state !== "terminal" ? [] : [{
              kind: "operation-stream" as const,
              action: "end" as const,
              operationId,
              streamOrdinal: stream.streamOrdinal,
              offset: stream.committedOffset,
            }]),
          ]);
        }
        checkpoint = decodeOperationReplayCursor(tracker.cursor());
      }
    }
    return encodeOperationReplayCursor(checkpoint);
  };

  const attach = (
    input: Parameters<InternalCopilotzApplication["attach"]>[0],
  ) => {
    lifetime.signal.throwIfAborted();
    operationReaders ??= createSharedOperationReaders(application);
    return operationReaders.attach(input);
  };

  const pluginIds = registry.plugins.map((plugin) => plugin.id);
  const {
    events: _engineEvents,
    shutdown: _engineShutdown,
    ...publicEngine
  } = engine;
  const application: InternalCopilotzApplication = {
    ...publicEngine,
    host: createHostServices(() => application, registry),
    config: {
      ...(namespace ? { namespace } : {}),
      databaseSchema,
      pluginIds: pluginIds,
      databaseOwnership: persistence.ownership,
    } as const,
    events: engine.events,
    engine,
    execution: engine.execution,
    async bindTransient(processor) {
      const binding = {
        processor,
        dispose: await engine.bindTransient(processor),
      };
      transientBindings.add(binding);
      return () => {
        transientBindings.delete(binding);
        binding.dispose();
      };
    },
    interruptActiveSends,
    interruptPersistence(error) {
      interruptActiveSends(error);
      for (const owner of owners.values()) owner.stop(error);
    },
    async recoverAll(recovery = {}) {
      if ([...owners.values()].some((owner) => owner.state === "stopped")) {
        replacement ??= (async () => {
          lifetime.signal.throwIfAborted();
          const schemas = [...owners.keys()];
          // Retire the old graph without waiting for user code that ignores abort.
          // Its repositories and capabilities keep their stopped authority.
          const retired = engine.shutdown("persistence_owner_replaced");
          retiredEngines.add(retired);
          void retired.then(
            () => retiredEngines.delete(retired),
            () => undefined,
          );
          scopeRecoveries.clear();
          const successor = await constructEngine(true);
          for (const schema of schemas) await successor.databaseScope(schema);
        })().catch((error) => {
          // Partial activation cannot admit work from only some of the scopes.
          for (const owner of owners.values()) owner.stop(error);
          throw error;
        }).finally(() => {
          replacement = undefined;
        });
      }
      await replacement;
      return await engine.recoverAll(recovery);
    },
    async startRecovery() {
      // Only explicit host scopes are opened; no catalog-wide schema discovery.
      for (const schema of requestedScopes) await engine.databaseScope(schema);
      recoveryOwner = true;
      const recovery = engine.recoverAll({ limit: 1_000 }).then(() =>
        undefined
      );
      scopeRecoveries.set(databaseSchema, recovery);
      try {
        await recovery;
      } catch (error) {
        if (scopeRecoveries.get(databaseSchema) === recovery) {
          scopeRecoveries.delete(databaseSchema);
        }
        throw error;
      }
    },
    sendProtected(input, schema, ownerId, ingress, completion, inline) {
      return sendWithProtection(input, {
        schema,
        ownerId,
        ingress,
        completion,
        inline,
      });
    },
    async databaseScope(requestedDatabaseSchema) {
      await persistence.recovery?.admit();
      return await openRecoveredScope(requestedDatabaseSchema);
    },
    send,
    attach,
    operationStatus,
    listOperations,
    operationCheckpoint,
    cancelOperation,
    async maintenance(
      maintenanceOptions: ApplicationMaintenanceOptions = {},
    ) {
      const requestedDatabaseSchema = maintenanceOptions.databaseSchema
        ?.trim() || databaseSchema;
      const { databaseSchema: _databaseSchema, ...scopeOptions } =
        maintenanceOptions;
      const scope = await openRecoveredScope(requestedDatabaseSchema);
      return await scope.maintenance(scopeOptions);
    },
    observe() {
      return outputHub.subscribe().outputs;
    },
    close: shutdown,
    shutdown,
  };
  async function installSuccessor(successor: CopilotzEngine) {
    engine = successor;
    const {
      shutdown: _shutdown,
      databaseScope: _databaseScope,
      recoverAll: _recoverAll,
      maintenance: _maintenance,
      bindTransient: _bindTransient,
      ...services
    } = successor;
    Object.assign(application, services, { engine: successor });
    for (const binding of transientBindings) {
      binding.dispose();
      binding.dispose = await successor.bindTransient(binding.processor);
      if (!transientBindings.has(binding)) binding.dispose();
    }
  }
  stopObservingPersistence = observeApplicationPersistence(
    persistence,
    application,
  );
  return application;
}
