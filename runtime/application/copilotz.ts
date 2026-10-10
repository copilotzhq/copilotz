import type { HypervisorTransport } from "../../dependencies/oxian-hypervisor.ts";
import { createCopilotzGateway } from "./gateway.ts";
import type {
  CreateCopilotzGatewayOptions,
  InternalCopilotzGateway,
} from "./gateway.ts";
import {
  type CopilotzPersistenceLifecycleCallbacks,
  openCopilotzPersistence,
} from "@copilotz/copilotz/persistence";
import { createCopilotzWorker } from "./worker.ts";
import type { CopilotzApplication } from "./types.ts";

type EmbeddedWorkerOptions = Readonly<{
  id?: string;
  capacity?: number;
}>;

export type CreateCopilotzOptions =
  & Omit<
    CreateCopilotzGatewayOptions,
    | "transports"
    | "dispatcher"
    | "target"
    | "workloadTargets"
    | "admit"
    | "assign"
    | "sessions"
    | "signal"
    | "hypervisorConfig"
    | "http"
    | "resolveDatabaseSchema"
  >
  & Readonly<{ worker?: EmbeddedWorkerOptions }>;

export type CopilotzEmbeddedApplication = CopilotzApplication;

/** Builds the embedded Gateway's Fetch handler; the caller owns HTTP policy. */
export type EmbeddedFetchFactory = (
  gateway: InternalCopilotzGateway,
) => (request: Request) => Promise<Response>;

export type CopilotzEmbeddedFetchApplication =
  & CopilotzEmbeddedApplication
  & Readonly<{ fetch(request: Request): Promise<Response> }>;

/**
 * Creates the normal factory-first Copilotz application.
 *
 * With no database, Copilotz owns one private Ominipg connection. Injected
 * databases and execution infrastructure remain application-owned.
 */
export async function createCopilotz(
  options?: CreateCopilotzOptions,
  lifecycle?: CopilotzPersistenceLifecycleCallbacks,
): Promise<CopilotzEmbeddedApplication>;
export async function createCopilotz(
  options: CreateCopilotzOptions,
  lifecycle: CopilotzPersistenceLifecycleCallbacks | undefined,
  createFetch: EmbeddedFetchFactory,
): Promise<CopilotzEmbeddedFetchApplication>;
export async function createCopilotz(
  options: CreateCopilotzOptions = {},
  lifecycle: CopilotzPersistenceLifecycleCallbacks =
    options.databaseLifecycle ?? {},
  createFetch?: EmbeddedFetchFactory,
): Promise<CopilotzEmbeddedApplication | CopilotzEmbeddedFetchApplication> {
  const persistence = await openCopilotzPersistence(options, lifecycle);
  const workerId = options.worker?.id?.trim() ||
    `copilotz-embedded-${crypto.randomUUID()}`;
  const transport: HypervisorTransport = {
    type: "in-process",
    config: {
      topic: `copilotz.embedded.${crypto.randomUUID()}`,
    } as const,
  } as const;
  const engine = options.engine ?? {};
  const { publish: _publish, ...workerEngine } = engine;
  let gateway: Awaited<ReturnType<typeof createCopilotzGateway>> | undefined;
  let worker: Awaited<ReturnType<typeof createCopilotzWorker>> | undefined;
  let fetch: ((request: Request) => Promise<Response>) | undefined;
  try {
    gateway = await createCopilotzGateway({
      namespace: options.namespace,
      databaseSchema: options.databaseSchema,
      plugins: options.plugins,
      collections: options.collections,
      actions: options.actions,
      processors: options.processors,
      resources: options.resources,
      adapters: options.adapters,
      assets: options.assets,
      onDeliveryDiagnostic: options.onDeliveryDiagnostic,
      persistence,
      transports: [transport],
      target: { workerId },
      engine,
    });
    worker = await createCopilotzWorker({
      namespace: options.namespace,
      databaseSchema: options.databaseSchema,
      plugins: options.plugins,
      collections: options.collections,
      actions: options.actions,
      processors: options.processors,
      resources: options.resources,
      adapters: options.adapters,
      assets: options.assets,
      onDeliveryDiagnostic: options.onDeliveryDiagnostic,
      persistence,
      id: workerId,
      transport,
      capacity: options.worker?.capacity ?? 8,
      engine: workerEngine,
    });
    await worker.ready;
    if (createFetch) {
      fetch = createFetch(gateway);
      gateway.installFetchFallback(fetch);
    }
  } catch (error) {
    await Promise.allSettled([
      worker?.stop("copilotz_embedded_initialization_failed"),
      gateway?.shutdown("copilotz_embedded_initialization_failed"),
      persistence.close("copilotz_embedded_initialization_failed"),
    ]);
    throw error;
  }

  let shutdownTask: Promise<void> | undefined;
  const shutdown = (reason = "copilotz_embedded_shutdown"): Promise<void> => {
    if (shutdownTask) return shutdownTask;
    shutdownTask = (async () => {
      const roleResults = await Promise.allSettled([
        gateway!.shutdown(reason),
        worker!.stop(reason),
      ]);
      const persistenceResult = await Promise.allSettled([
        persistence.close(reason),
      ]);
      const failures = [
        ...roleResults,
        ...persistenceResult,
      ].flatMap((result) =>
        result.status === "rejected" ? [result.reason] : []
      );
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) {
        throw new AggregateError(
          failures,
          "Embedded Copilotz shutdown failed.",
        );
      }
    })();
    shutdownTask.catch(() => undefined);
    return shutdownTask;
  };

  return ({
    async send(input: Parameters<CopilotzApplication["send"]>[0]) {
      return await gateway!.send(input);
    },
    actions: gateway.actions,
    collections: gateway.collections,
    attach: (input) => gateway!.attach(input),
    operationStatus: (input) => gateway!.operationStatus(input),
    listOperations: (input) => gateway!.listOperations(input),
    operationCheckpoint: (input) => gateway!.operationCheckpoint(input),
    cancelOperation: (input) => gateway!.cancelOperation(input),
    maintenance: (input) => gateway!.maintenance(input),
    observe: () => gateway!.observe(),
    close: shutdown,
    ...(fetch ? { fetch } : {}),
  } as const);
}
