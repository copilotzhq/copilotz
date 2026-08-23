import {
  type CopilotzPersistenceLifecycleCallbacks,
  type OpenCopilotzPersistence,
  openCopilotzPersistence,
} from "./persistence.ts";
import { type CopilotzEngine, createCopilotzEngine } from "../engine/index.ts";
import { createPluginRegistry } from "../plugins/index.ts";
import type { CopilotzEvent } from "../events/index.ts";
import type {
  ApplicationSendHandle,
  ApplicationSendInput,
  CreateCopilotzApplicationOptions,
  InternalCopilotzApplication,
} from "./types.ts";

export function observeApplicationPersistence(
  persistence: OpenCopilotzPersistence,
  application: Pick<
    InternalCopilotzApplication,
    "disconnectAttachments" | "recoverAll"
  >,
  options: Readonly<{ recoverDurable?: boolean }> = {},
): () => void {
  return persistence.recovery?.register({
    onUnavailable: (error) => application.disconnectAttachments(error),
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

async function waitForApplicationScope(
  eventScope: Pick<CopilotzEngine, "events">,
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
      if (confirmed.unsettled === 0) return;
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
  outputs: ReadableStream<CopilotzEvent>;
  close(): void;
  error(reason: unknown): void;
}>;

type ApplicationOutputHub = Readonly<{
  subscribe(filter?: ApplicationOutputFilter): ApplicationOutputSubscription;
  emit(output: CopilotzEvent, databaseSchema: string): void;
  close(): void;
}>;

function createApplicationOutputHub(): ApplicationOutputHub {
  type SubscriptionState = {
    filter: ApplicationOutputFilter;
    controller?: ReadableStreamDefaultController<CopilotzEvent>;
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
      const outputs = new ReadableStream<CopilotzEvent>({
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
    emit(output, databaseSchema) {
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
          subscription.controller?.enqueue(output);
        } catch {
          subscription.closed = true;
          subscriptions.delete(subscription);
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
  const outputHub = createApplicationOutputHub();
  const configuredPublish = options.engine?.publish;

  let engine;
  try {
    engine = await createCopilotzEngine({
      ...(options.engine ?? {}),
      session: persistence.session,
      registry,
      defaultDatabaseSchema: databaseSchema,
      assets: options.assets,
      async publish(event, context) {
        outputHub.emit(event, context?.databaseSchema ?? databaseSchema);
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

  const activeSends = new Set<ApplicationSendHandle>();
  let shutdownTask: Promise<void> | undefined;
  let stopObservingPersistence: () => void = () => undefined;
  const shutdown = (reason = "copilotz_application_shutdown") => {
    if (shutdownTask) return shutdownTask;
    stopObservingPersistence();
    shutdownTask = (async () => {
      const active = [...activeSends];
      activeSends.clear();
      const settled = await Promise.allSettled([
        ...active.map((handle) => handle.cancel(reason)),
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
  const send = async (
    input: ApplicationSendInput,
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
      const scopedEngine = inputDatabaseSchema === databaseSchema
        ? engine
        : await engine.databaseScope(inputDatabaseSchema);
      committed = await scopedEngine.events.append({
        type: inputType,
        namespace: inputNamespace,
        payload: structuredClone(input.payload),
        visibility: input.visibility ?? { kind: "public" },
        metadata: {
          source: "application.input",
          ...(input.metadata ? structuredClone(input.metadata) : {}),
        },
        correlationId,
        ...(input.causationId?.trim()
          ? { causationId: input.causationId.trim() }
          : {}),
        ...(input.deduplicationId?.trim()
          ? { deduplicationId: input.deduplicationId.trim() }
          : {}),
      });
    } catch (error) {
      subscription.error(error);
      throw error;
    }
    const abort = new AbortController();
    const settlementScopeId = committed.settlementScopeId;
    const eventScope = inputDatabaseSchema === databaseSchema
      ? engine
      : await engine.databaseScope(inputDatabaseSchema);
    const done = waitForApplicationScope(
      eventScope,
      engine.execution,
      inputDatabaseSchema,
      inputNamespace,
      settlementScopeId,
      abort.signal,
    ).finally(() => {
      subscription.close();
      activeSends.delete(sendHandle);
    });
    const sendHandle: ApplicationSendHandle = Object.freeze({
      eventId: committed.event.id,
      correlationId,
      outputs: subscription.outputs,
      done,
      async cancel(reason = "application_send_cancelled") {
        if (!abort.signal.aborted) abort.abort(new Error(reason));
        await (inputDatabaseSchema === databaseSchema
          ? engine
          : await engine.databaseScope(inputDatabaseSchema)).events.cancel(
            inputNamespace,
            settlementScopeId,
            reason,
          );
        await done.catch(() => undefined);
      },
    });
    activeSends.add(sendHandle);
    return sendHandle;
  };

  const pluginIds = registry.plugins.map((plugin) => plugin.id);
  const {
    connect: _engineConnect,
    events: _engineEvents,
    run: _engineRun,
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
    async databaseScope(requestedDatabaseSchema) {
      await persistence.recovery?.admit();
      return await engine.databaseScope(requestedDatabaseSchema);
    },
    send,
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
