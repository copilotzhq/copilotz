import { createAgentCapabilityResolver } from "../capabilities/index.ts";
import {
  type CopilotzPersistenceLifecycleCallbacks,
  type OpenCopilotzPersistence,
  openCopilotzPersistence,
} from "./persistence.ts";
import { type CopilotzEngine, createCopilotzEngine } from "../engine/index.ts";
import { createPluginRegistry } from "../plugins/index.ts";
import { createWorkflowToolCatalog } from "../tools/index.ts";
import { createCopilotzCorePlugins } from "./core-plugins.ts";
import type { AttachmentOutput } from "../attachments/index.ts";
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
  engine: Pick<CopilotzEngine, "events">,
  namespace: string,
  settlementScopeId: string,
  signal: AbortSignal,
): Promise<void> {
  while (true) {
    if (signal.aborted) throw signal.reason;
    const settlement = await engine.events.settlement(
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
    if (settlement.unsettled === 0) return;
    await sleep(25, signal);
  }
}

type ApplicationOutputHub = Readonly<{
  subscribe(): ReadableStream<AttachmentOutput>;
  emit(output: AttachmentOutput): void;
  close(): void;
  error(reason: unknown): void;
}>;

function createApplicationOutputHub(): ApplicationOutputHub {
  const controllers = new Set<
    ReadableStreamDefaultController<AttachmentOutput>
  >();
  const pending: AttachmentOutput[] = [];
  let closed = false;
  let failure: unknown;

  const close = () => {
    if (closed) return;
    closed = true;
    pending.length = 0;
    for (const controller of controllers) controller.close();
    controllers.clear();
  };

  return Object.freeze({
    subscribe() {
      let current:
        | ReadableStreamDefaultController<AttachmentOutput>
        | undefined;
      return new ReadableStream<AttachmentOutput>({
        start(controller) {
          current = controller;
          if (failure !== undefined) {
            controller.error(failure);
            return;
          }
          if (closed) {
            controller.close();
            return;
          }
          controllers.add(controller);
          const queued = pending.splice(0);
          for (const output of queued) {
            if (closed || failure !== undefined) break;
            controller.enqueue(output);
          }
        },
        cancel() {
          if (current) controllers.delete(current);
        },
      }, { highWaterMark: 256 });
    },
    emit(output) {
      if (closed) return;
      if (controllers.size === 0) {
        pending.push(output);
        return;
      }
      for (const controller of controllers) controller.enqueue(output);
    },
    close,
    error(reason) {
      if (closed) return;
      closed = true;
      failure = reason;
      pending.length = 0;
      for (const controller of controllers) controller.error(reason);
      controllers.clear();
    },
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
  const toolCatalog = options.toolCatalog ?? createWorkflowToolCatalog();
  const core = Object.freeze([
    ...(options.canonicalCore ?? []),
    ...createCopilotzCorePlugins(options.core, { toolCatalog }),
  ]);
  const registry = await createPluginRegistry({
    core,
    plugins: options.plugins,
    context: options.context,
  });

  let engine;
  try {
    engine = await createCopilotzEngine({
      ...(options.engine ?? {}),
      session: persistence.session,
      registry,
      defaultDatabaseSchema: databaseSchema,
      assets: options.assets,
    });
  } catch (error) {
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
  const outputHub = createApplicationOutputHub();

  const send = async (
    input: ApplicationSendInput,
  ): Promise<ApplicationSendHandle> => {
    await persistence.recovery?.admit();
    const inputType = requiredType(input.type);
    const inputNamespace = requiredNamespace(input.namespace, namespace);
    const inputDatabaseSchema = input.databaseSchema?.trim() || databaseSchema;
    const correlationId = input.correlationId?.trim() || crypto.randomUUID();
    const subscription = inputDatabaseSchema === databaseSchema
      ? engine.events.subscribe({
        namespace: inputNamespace,
        correlationId,
      })
      : (await engine.databaseScope(inputDatabaseSchema)).events.subscribe({
        namespace: inputNamespace,
        correlationId,
      });
    const eventReader = subscription.getReader();
    let sendController:
      | ReadableStreamDefaultController<AttachmentOutput>
      | undefined;
    let outputsClosed = false;
    const closeOutputs = () => {
      if (outputsClosed) return;
      outputsClosed = true;
      try {
        sendController?.close();
      } catch {
        // A request-bound adapter may have cancelled the stream.
      }
    };
    const errorOutputs = (error: unknown) => {
      if (outputsClosed) return;
      outputsClosed = true;
      try {
        sendController?.error(error);
      } catch {
        // A request-bound adapter may have cancelled the stream.
      }
    };
    const outputs = new ReadableStream<AttachmentOutput>({
      start(controller) {
        sendController = controller;
      },
      cancel(reason) {
        return eventReader.cancel(reason);
      },
    }, { highWaterMark: 256 });
    const pump = (async () => {
      try {
        while (true) {
          const next = await eventReader.read();
          if (next.done) break;
          const output = next.value as AttachmentOutput;
          outputHub.emit(output);
          if (!outputsClosed) sendController?.enqueue(output);
        }
      } catch (error) {
        outputHub.error(error);
        errorOutputs(error);
        throw error;
      } finally {
        closeOutputs();
      }
    })();
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
      await eventReader.cancel(error).catch(() => undefined);
      errorOutputs(error);
      throw error;
    }
    const abort = new AbortController();
    const settlementScopeId = committed.settlementScopeId;
    const done = waitForApplicationScope(
      inputDatabaseSchema === databaseSchema
        ? engine
        : await engine.databaseScope(inputDatabaseSchema),
      inputNamespace,
      settlementScopeId,
      abort.signal,
    ).finally(async () => {
      await eventReader.cancel("application_send_settled").catch(() =>
        undefined
      );
      activeSends.delete(sendHandle);
    });
    const sendHandle: ApplicationSendHandle = Object.freeze({
      eventId: committed.event.id,
      correlationId,
      outputs,
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
    pump.catch(() => undefined);
    return sendHandle;
  };

  const declaredPluginIds = registry.plugins
    .slice(core.length)
    .map((plugin) => plugin.manifest.id);
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
      corePluginIds: Object.freeze(
        core.map((plugin) => plugin.manifest.id),
      ),
      declaredPluginIds: Object.freeze(declaredPluginIds),
      databaseOwnership: persistence.ownership,
    }),
    capabilities: createAgentCapabilityResolver({ registry, toolCatalog }),
    events: engine.events,
    engine,
    execution: engine.execution,
    async databaseScope(requestedDatabaseSchema) {
      await persistence.recovery?.admit();
      return await engine.databaseScope(requestedDatabaseSchema);
    },
    send,
    observe() {
      return outputHub.subscribe();
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
