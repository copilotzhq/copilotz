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
    "interruptActiveSends" | "recoverAll"
  >,
  options: Readonly<{ recoverDurable?: boolean }> = {},
): () => void {
  return persistence.recovery?.register({
    onUnavailable: (error) => application.interruptActiveSends(error),
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

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
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
    opening ??= open().then((stream) => {
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
  execution: Pick<
    CopilotzEngine["execution"],
    "settleOutputs" | "awaitScopeProgress"
  >,
  databaseSchema: string,
  namespace: string,
  settlementScopeId: string,
  signal: AbortSignal,
): Promise<void> {
  while (true) {
    if (signal.aborted) throw signal.reason;
    const settlement = await eventScope.events.outstanding(
      namespace,
      settlementScopeId,
    );
    if (settlement.deadLetters > 0) {
      throw await deadLetterError(eventScope, namespace, settlementScopeId);
    }
    if (settlement.cancelled > 0) {
      throw new Error(
        `Settlement scope '${settlementScopeId}' was cancelled.`,
      );
    }
    if (settlement.unsettled === 0) {
      // A remote Worker commits its final delivery before every framed output
      // necessarily reaches this application. Drain the generic causal output
      // relay, then recheck in case a relayed event created more durable work.
      await execution.settleOutputs({
        databaseSchema,
        namespace,
        settlementScopeId,
      });
      // The two checks read different tables and neither needs the other, so
      // they share a round trip.
      const [confirmed, streamsOpen] = await Promise.all([
        eventScope.events.outstanding(namespace, settlementScopeId),
        eventScope.operations.hasOpenStreams(namespace, settlementScopeId),
      ]);
      if (confirmed.deadLetters > 0) {
        throw await deadLetterError(eventScope, namespace, settlementScopeId);
      }
      if (confirmed.cancelled > 0) {
        throw new Error(
          `Settlement scope '${settlementScopeId}' was cancelled.`,
        );
      }
      if (confirmed.unsettled === 0 && !streamsOpen) return;
    }
    const progressed = await execution.awaitScopeProgress({
      databaseSchema,
      namespace,
      settlementScopeId,
    }, signal);
    // Remote-only work has no local task wake: poll at 250ms. This adds a
    // nominal 225ms of fallback detection delay versus the old 25ms.
    if (!progressed) await sleep(250, signal);
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
          const projected = isStreamOutputDescriptor(output)
            ? await projectStream(output, databaseSchema)
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
): Promise<InternalCopilotzApplication> {
  const persistence = await openCopilotzPersistence(options, lifecycle);
  const namespace = optionalText(options.namespace, "Namespace");
  const databaseSchema = optionalText(
    options.databaseSchema,
    "Database schema",
  ) ?? "public";
  const registry = createPluginRegistry({
    plugins: options.plugins,
    collections: options.collections,
    actions: options.actions,
    processors: options.processors,
    resources: options.resources,
    adapters: options.adapters,
  });
  const configuredPublish = options.engine?.publish;

  let engine: CopilotzEngine;
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
  try {
    engine = await createCopilotzEngine({
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
    });
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
      const settled = await Promise.allSettled([
        engine.shutdown(reason),
        persistence.close(reason),
      ]);
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
    protection?: Readonly<{ schema: ActionSchema; ownerId: string }>,
  ): Promise<ApplicationSendHandle> => {
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
        )
        : await scopedEngine.events.append(draft);
    } catch (error) {
      subscription.error(error);
      throw error;
    }
    const abort = new AbortController();
    const settlementScopeId = committed.settlementScopeId;
    const eventScope = await openRecoveredScope(inputDatabaseSchema);
    let explicitlyCancelled = false;
    const done = waitForApplicationScope(
      eventScope,
      engine.execution,
      inputDatabaseSchema,
      inputNamespace,
      settlementScopeId,
      abort.signal,
    ).then(async () => {
      await eventScope.operations.mark(
        inputNamespace,
        committed.event.id,
        "completed",
      );
    }).catch(async (error) => {
      if (explicitlyCancelled) {
        await eventScope.operations.mark(
          inputNamespace,
          committed.event.id,
          "cancelled",
        );
      } else if (!abort.signal.aborted) {
        await eventScope.operations.mark(
          inputNamespace,
          committed.event.id,
          "failed",
        );
      }
      throw error;
    }).finally(() => {
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
        explicitlyCancelled = true;
        if (!abort.signal.aborted) abort.abort(new Error(reason));
        await (await openRecoveredScope(inputDatabaseSchema)).events.cancel(
          inputNamespace,
          settlementScopeId,
          reason,
        );
        await eventScope.operations.mark(
          inputNamespace,
          committed.event.id,
          "cancelled",
        );
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
    let record = await boundary.scope.operations.get(
      boundary.namespace,
      boundary.operationId,
    );
    if (!record) return null;
    if (record.state === "accepted" || record.state === "running") {
      let settlement = await boundary.scope.events.outstanding(
        boundary.namespace,
        boundary.operationId,
      );
      if (
        settlement.unsettled === 0 && settlement.deadLetters === 0 &&
        settlement.cancelled === 0
      ) {
        await engine.execution.settleOutputs({
          databaseSchema: boundary.databaseSchema,
          namespace: boundary.namespace,
          settlementScopeId: boundary.operationId,
        });
        settlement = await boundary.scope.events.outstanding(
          boundary.namespace,
          boundary.operationId,
        );
      }
      const hasOpenStreams = await boundary.scope.operations.hasOpenStreams(
        boundary.namespace,
        boundary.operationId,
      );
      const state = settlement.deadLetters > 0
        ? hasOpenStreams ? "running" : "failed"
        : settlement.cancelled > 0
        ? hasOpenStreams ? "running" : "cancelled"
        : settlement.unsettled > 0 || hasOpenStreams
        ? "running"
        : "completed";
      await boundary.scope.operations.mark(
        boundary.namespace,
        boundary.operationId,
        state,
      );
      record = await boundary.scope.operations.get(
        boundary.namespace,
        boundary.operationId,
      ) ?? record;
    }
    return projectOperationStatus(record);
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
    await scope.operations.reconcile({ limit: input.limit });
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
    await boundary.scope.operations.mark(
      boundary.namespace,
      boundary.operationId,
      "cancelled",
    );
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
    config: {
      ...(namespace ? { namespace } : {}),
      databaseSchema,
      pluginIds: pluginIds,
      databaseOwnership: persistence.ownership,
    } as const,
    events: engine.events,
    engine,
    execution: engine.execution,
    interruptActiveSends,
    async startRecovery() {
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
    sendProtected(input, schema, ownerId) {
      return sendWithProtection(input, { schema, ownerId });
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
  stopObservingPersistence = observeApplicationPersistence(
    persistence,
    application,
  );
  return application;
}
