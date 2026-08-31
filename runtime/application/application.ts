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
} from "../streams/index.ts";
import {
  createOperationReplayCursorTracker,
  decodeOperationReplayCursor,
  encodeOperationReplayCursor,
  operationStreamReplayCursorKey,
} from "../streams/index.ts";
import type {
  OperationCatalog,
  OperationChangeSubscription,
  OperationRecord,
  OperationReplayPosition,
  OperationStreamRecord,
} from "../streams/index.ts";
import type {
  ApplicationMaintenanceOptions,
  ApplicationOperationAttachment,
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
      "A tenant namespace is required on the application or operation.",
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
): Promise<readonly OperationStreamRecord[]> {
  const result: OperationStreamRecord[] = [];
  let afterStreamOrdinal: string | undefined;
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
  return Object.freeze(result);
}

/** Moves pre-high-watermark `r<global-key>` cursors into ordinal exceptions. */
function normalizeLegacyOperationStreams(
  initial: OperationReplayPosition,
  operationId: string,
  streams: readonly OperationStreamRecord[],
): OperationReplayPosition {
  const streamOffsets = { ...initial.streamOffsets };
  const operationStreamPositions = Object.fromEntries(
    Object.entries(initial.operationStreamPositions ?? {}).map(
      ([id, state]) => [id, {
        highWatermark: state.highWatermark,
        offsets: { ...state.offsets },
      }],
    ),
  );
  const state = operationStreamPositions[operationId] ??= {
    highWatermark: 0,
    offsets: {},
  };
  for (const stream of streams) {
    const legacyKey = operationStreamReplayCursorKey(stream);
    const legacyOffset = streamOffsets[legacyKey];
    if (legacyOffset === undefined) continue;
    delete streamOffsets[legacyKey];
    state.offsets[stream.streamOrdinal] = Math.max(
      state.offsets[stream.streamOrdinal] ?? 0,
      legacyOffset,
    );
  }
  if (state.highWatermark === 0 && Object.keys(state.offsets).length === 0) {
    delete operationStreamPositions[operationId];
  }
  return Object.freeze({
    ...(initial.eventPosition ? { eventPosition: initial.eventPosition } : {}),
    ...(initial.operationEventPositions
      ? { operationEventPositions: initial.operationEventPositions }
      : {}),
    ...(Object.keys(operationStreamPositions).length
      ? { operationStreamPositions }
      : {}),
    streamOffsets,
  });
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason);
    }, { once: true });
  });
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

async function waitForApplicationScope(
  eventScope: Pick<CopilotzEngine, "events" | "operations">,
  execution: Pick<CopilotzEngine["execution"], "settleOutputs">,
  databaseSchema: string,
  namespace: string,
  settlementScopeId: string,
  signal: AbortSignal,
): Promise<void> {
  while (true) {
    if (signal.aborted) throw signal.reason;
    const settlement = await eventScope.events.settlement(
      namespace,
      settlementScopeId,
    );
    if (settlement.deadLetters > 0) {
      throw new Error(
        `Settlement scope '${settlementScopeId}' contains dead-lettered work.`,
      );
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
      const confirmed = await eventScope.events.settlement(
        namespace,
        settlementScopeId,
      );
      if (confirmed.deadLetters > 0) {
        throw new Error(
          `Settlement scope '${settlementScopeId}' contains dead-lettered work.`,
        );
      }
      if (confirmed.cancelled > 0) {
        throw new Error(
          `Settlement scope '${settlementScopeId}' was cancelled.`,
        );
      }
      if (
        confirmed.unsettled === 0 &&
        !await eventScope.operations.hasOpenStreams(
          namespace,
          settlementScopeId,
        )
      ) return;
    }
    await sleep(25, signal);
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
    output: ApplicationOutputDescriptor,
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

  return Object.freeze({
    subscribe(filter = {}) {
      const subscription: SubscriptionState = {
        filter: Object.freeze({ ...filter }),
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
      return Object.freeze({
        outputs,
        close: () => finish(),
        error: finish,
      });
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
  });
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
    resources: options.resources,
    adapters: options.adapters,
  });
  const configuredPublish = options.engine?.publish;

  let engine: CopilotzEngine;
  const outputHub = createApplicationOutputHub(async (output, schema) => {
    const scoped = await openRecoveredScope(schema);
    return Object.freeze({
      ...output,
      payload: lazyStreamFollower(() =>
        scoped.streams.follow(output.namespace, {
          id: output.streamId,
        })
      ),
    });
  });
  try {
    engine = await createCopilotzEngine({
      ...(options.engine ?? {}),
      session: persistence.session,
      registry,
      defaultDatabaseSchema: databaseSchema,
      assets: options.assets,
      async publish(event, context) {
        await outputHub.emit(event, context?.databaseSchema ?? databaseSchema);
        await configuredPublish?.(event, context);
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
        visibility: input.visibility ?? { kind: "public" },
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
    const sendHandle: ApplicationSendHandle = Object.freeze({
      operationId: committed.event.id,
      eventId: committed.event.id,
      correlationId,
      replayCursor: encodeOperationReplayCursor({
        eventPosition: committed.event.position,
        streamOffsets: Object.freeze({}),
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
    });
    activeSends.set(sendHandle, Object.freeze({ subscription, abort }));
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
    return Object.freeze({
      operationId,
      namespace: operationNamespace,
      databaseSchema: operationDatabaseSchema,
      scope,
    });
  };

  const projectOperationStatus = (
    record: OperationRecord,
  ): ApplicationOperationStatus => {
    const candidate = record.metadata.operationMetadata;
    const metadata = candidate && typeof candidate === "object" &&
        !Array.isArray(candidate)
      ? structuredClone(candidate as Record<string, unknown>)
      : {};
    return Object.freeze({
      operationId: record.operationId,
      namespace: record.namespace,
      correlationId: record.correlationId,
      state: record.state,
      metadata: Object.freeze(metadata),
      acceptedAt: record.acceptedAt,
      updatedAt: record.updatedAt,
      ...(record.completedAt ? { completedAt: record.completedAt } : {}),
    });
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
      let settlement = await boundary.scope.events.settlement(
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
        settlement = await boundary.scope.events.settlement(
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
    return Object.freeze(records.map(projectOperationStatus));
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
        checkpoint = normalizeLegacyOperationStreams(
          checkpoint,
          operationId,
          streams,
        );
        const tracker = createOperationReplayCursorTracker(checkpoint);
        for (const stream of streams) {
          const position = tracker.streamPosition({
            operationId,
            replayKey: stream.replayKey,
            streamOrdinal: stream.streamOrdinal,
            streamId: stream.streamId,
          });
          tracker.commit([
            {
              kind: "operation-stream",
              action: "register",
              operationId,
              streamOrdinal: stream.streamOrdinal,
              offset: position.offset,
            },
            ...(stream.state === "open" ? [] : [{
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

  const attach = async (
    input: Parameters<InternalCopilotzApplication["attach"]>[0],
  ): Promise<ApplicationOperationAttachment> => {
    const boundary = await operationBoundary(input);
    if (
      !await boundary.scope.operations.get(
        boundary.namespace,
        boundary.operationId,
      )
    ) {
      throw Object.assign(new Error("Operation was not found."), {
        status: 404,
        code: "operation_not_found",
      });
    }
    // Reconcile the initial accepted/running boundary before stream followers
    // subscribe, so this attachment's own state transition cannot create a
    // spurious BodyStore replay read.
    await statusFor(boundary);
    const catalogStreams = await listAllOperationStreams(
      boundary.scope.operations,
      boundary.namespace,
      boundary.operationId,
    );
    let initial = normalizeLegacyOperationStreams(
      decodeOperationReplayCursor(input.cursor),
      boundary.operationId,
      catalogStreams,
    );
    // Aborted lanes have no replayable payload. Normalize them as consumed so
    // stale sparse exceptions cannot survive every reconnect indefinitely.
    const initialTracker = createOperationReplayCursorTracker(initial);
    for (const stream of catalogStreams) {
      if (stream.state !== "aborted") continue;
      const position = initialTracker.streamPosition({
        operationId: boundary.operationId,
        replayKey: stream.replayKey,
        streamOrdinal: stream.streamOrdinal,
        streamId: stream.streamId,
      });
      initialTracker.commit([{
        kind: "operation-stream",
        action: "register",
        operationId: boundary.operationId,
        streamOrdinal: stream.streamOrdinal,
        offset: position.offset,
      }, {
        kind: "operation-stream",
        action: "end",
        operationId: boundary.operationId,
        streamOrdinal: stream.streamOrdinal,
        offset: stream.committedOffset,
      }]);
    }
    initial = decodeOperationReplayCursor(initialTracker.cursor());
    const compositeReplay = initial.operationEventPositions !== undefined;
    const changes = await boundary.scope.operations.watch(
      boundary.operationId,
    );
    let eventPosition =
      initial.operationEventPositions?.[boundary.operationId] ??
        initial.eventPosition;
    const replayTracker = createOperationReplayCursorTracker(initial);
    const openedStreams = new Set<string>();
    const payloadDetachers = new Set<(reason?: unknown) => void>();
    const abort = new AbortController();
    let outputController:
      | ReadableStreamDefaultController<ApplicationOutput>
      | undefined;
    let resolveDone!: () => void;
    let rejectDone!: (reason: unknown) => void;
    const done = new Promise<void>((resolve, reject) => {
      resolveDone = resolve;
      rejectDone = reject;
    });
    void done.catch(() => undefined);
    const replayCursor = () => {
      const position = decodeOperationReplayCursor(replayTracker.cursor());
      return encodeOperationReplayCursor({
        ...(position.eventPosition
          ? { eventPosition: position.eventPosition }
          : {}),
        ...(eventPosition ? { eventPosition } : {}),
        ...(compositeReplay && position.operationEventPositions
          ? {
            operationEventPositions: {
              ...position.operationEventPositions,
              ...(eventPosition
                ? { [boundary.operationId]: eventPosition }
                : {}),
            },
          }
          : compositeReplay && eventPosition
          ? {
            operationEventPositions: {
              [boundary.operationId]: eventPosition,
            },
          }
          : {}),
        ...(position.operationStreamPositions
          ? { operationStreamPositions: position.operationStreamPositions }
          : {}),
        streamOffsets: position.streamOffsets,
      });
    };
    const replayStreamPayload = (
      stream: OperationStreamRecord,
      fromOffset: number,
    ): ReadableStream<Uint8Array> => {
      let byteOffset = fromOffset;
      let watch: Promise<OperationChangeSubscription> | undefined;
      const streamAbort = new AbortController();
      let finished = false;
      const finish = (reason?: unknown) => {
        if (finished) return;
        finished = true;
        payloadDetachers.delete(finish);
        if (!streamAbort.signal.aborted) streamAbort.abort(reason);
        void watch?.then((subscription) => subscription.close()).catch(() =>
          undefined
        );
      };
      payloadDetachers.add(finish);
      return new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            watch ??= boundary.scope.operations.watch(boundary.operationId);
            const changes = await watch;
            while (!streamAbort.signal.aborted) {
              const current = await boundary.scope.operations.getStream(
                boundary.namespace,
                boundary.operationId,
                stream.streamId,
              );
              if (!current) {
                throw Object.assign(
                  new Error("Operation stream replay metadata has expired."),
                  { status: 410, code: "operation_replay_expired" },
                );
              }
              if (current.state === "aborted") {
                throw Object.assign(
                  new Error("Operation stream was aborted."),
                  {
                    status: 409,
                    code: "operation_stream_aborted",
                  },
                );
              }
              if (byteOffset > current.committedOffset) {
                throw Object.assign(
                  new Error("Replay cursor is ahead of the durable stream."),
                  { status: 409, code: "replay_cursor_ahead" },
                );
              }
              if (byteOffset < current.committedOffset) {
                const end = current.committedOffset;
                const bytes = await boundary.scope.streams.readCommittedRange({
                  bodyId: current.bodyId,
                  offset: byteOffset,
                  end,
                });
                if (bytes === null) {
                  await changes.wait({
                    timeoutMs: 5_000,
                    signal: streamAbort.signal,
                  });
                  continue;
                }
                if (bytes.byteLength !== end - byteOffset) {
                  throw Object.assign(
                    new Error(
                      "Committed operation stream bytes are unavailable.",
                    ),
                    { status: 503, code: "operation_stream_unavailable" },
                  );
                }
                byteOffset = end;
                controller.enqueue(bytes);
                return;
              }
              if (current.state === "sealed") {
                controller.close();
                finish();
                return;
              }
              await changes.wait({
                timeoutMs: 5_000,
                signal: streamAbort.signal,
              });
            }
          } catch (error) {
            const wasAborted = streamAbort.signal.aborted;
            finish(error);
            if (!wasAborted) throw error;
          }
        },
        cancel(reason) {
          finish(reason);
        },
      });
    };
    const outputs = new ReadableStream<ApplicationOutput>({
      start(controller) {
        outputController = controller;
        void (async () => {
          try {
            while (!abort.signal.aborted) {
              let advanced = false;
              const streams = await listAllOperationStreams(
                boundary.scope.operations,
                boundary.namespace,
                boundary.operationId,
              );
              for (const stream of streams) {
                if (
                  stream.state === "aborted" ||
                  openedStreams.has(stream.streamId)
                ) {
                  continue;
                }
                const position = replayTracker.streamPosition({
                  operationId: boundary.operationId,
                  replayKey: stream.replayKey,
                  streamOrdinal: stream.streamOrdinal,
                  streamId: stream.streamId,
                });
                if (position.consumed) continue;
                const fromOffset = position.offset;
                if (fromOffset > stream.committedOffset) {
                  throw Object.assign(
                    new Error("Replay cursor is ahead of the durable stream."),
                    { status: 409, code: "replay_cursor_ahead" },
                  );
                }
                openedStreams.add(stream.streamId);
                const payload = replayStreamPayload(stream, fromOffset);
                controller.enqueue(Object.freeze({
                  ...stream.descriptor,
                  replayKey: stream.replayKey,
                  streamOrdinal: stream.streamOrdinal,
                  payload,
                }));
                advanced = true;
              }
              while (true) {
                const indexed = await boundary.scope.operations.listEventIds({
                  namespace: boundary.namespace,
                  operationId: boundary.operationId,
                  ...(eventPosition ? { afterPosition: eventPosition } : {}),
                  limit: 250,
                });
                for (const entry of indexed) {
                  const event = await boundary.scope.events.resolve(
                    boundary.namespace,
                    entry.eventId,
                  );
                  eventPosition = entry.position;
                  if (event) controller.enqueue(event);
                  advanced = true;
                }
                if (indexed.length < 250) break;
              }
              const status = await statusFor(boundary);
              if (
                status &&
                ["completed", "failed", "cancelled"].includes(status.state)
              ) {
                // One final catalog pass prevents a terminal write racing the
                // preceding reads from being omitted.
                if (!advanced) {
                  const state = status.state as
                    | "completed"
                    | "failed"
                    | "cancelled";
                  controller.enqueue(Object.freeze({
                    durable: false,
                    type: `operation.${state}` as const,
                    namespace: status.namespace,
                    operationId: status.operationId,
                    correlationId: status.correlationId,
                    state,
                    payload: Object.freeze({ status: state }),
                    data: Object.freeze({ status: state }),
                    routing: Object.freeze({}),
                    visibility: Object.freeze({ kind: "public" as const }),
                    metadata: Object.freeze({
                      operationId: status.operationId,
                      status: state,
                    }),
                    createdAt: status.completedAt ?? status.updatedAt,
                  }));
                  break;
                }
                continue;
              }
              await changes.wait({ timeoutMs: 5_000, signal: abort.signal });
            }
            if (!abort.signal.aborted) {
              controller.close();
              resolveDone();
            }
          } catch (error) {
            if (abort.signal.aborted) {
              try {
                controller.close();
              } catch {
                // The consumer may already have cancelled the stream.
              }
              resolveDone();
              return;
            }
            controller.error(error);
            rejectDone(error);
          } finally {
            changes.close();
          }
        })();
      },
      cancel(reason) {
        if (!abort.signal.aborted) abort.abort(reason);
        for (const detach of [...payloadDetachers]) detach(reason);
        resolveDone();
      },
    }, { highWaterMark: 256 });
    return Object.freeze({
      operationId: boundary.operationId,
      replayCursor: replayCursor(),
      outputs,
      done,
      async detach(reason = "application_operation_detached") {
        if (!abort.signal.aborted) abort.abort(new Error(reason));
        for (const detach of [...payloadDetachers]) detach(reason);
        try {
          outputController?.close();
        } catch {
          // The consumer may already have cancelled the stream.
        }
        resolveDone();
        await done;
      },
    });
  };

  const pluginIds = registry.plugins.map((plugin) => plugin.id);
  const {
    events: _engineEvents,
    shutdown: _engineShutdown,
    ...publicEngine
  } = engine;
  const application: InternalCopilotzApplication = {
    ...publicEngine,
    config: Object.freeze({
      ...(namespace ? { namespace } : {}),
      databaseSchema,
      pluginIds: Object.freeze(pluginIds),
      databaseOwnership: persistence.ownership,
    }),
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
  return Object.freeze(application);
}
