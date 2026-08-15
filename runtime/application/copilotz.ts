import type { HypervisorTransport } from "../../dependencies/oxian-hypervisor.ts";
import { createCopilotzGateway } from "./gateway.ts";
import type { CreateCopilotzGatewayOptions } from "./gateway.ts";
import {
  type CopilotzPersistenceLifecycleCallbacks,
  openCopilotzPersistence,
} from "./persistence.ts";
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

export type CopilotzEmbeddedApplication =
  & CopilotzApplication
  & Readonly<{ role: "embedded" }>;

/**
 * Creates the normal factory-first Copilotz application.
 *
 * With no database, Copilotz owns one private Ominipg connection. Injected
 * databases and execution infrastructure remain application-owned.
 */
export async function createCopilotz(
  options: CreateCopilotzOptions = {},
  lifecycle: CopilotzPersistenceLifecycleCallbacks =
    options.databaseLifecycle ?? {},
): Promise<CopilotzEmbeddedApplication> {
  const persistence = await openCopilotzPersistence(options, lifecycle);
  const workerId = options.worker?.id?.trim() ||
    `copilotz-embedded-${crypto.randomUUID()}`;
  const transport: HypervisorTransport = Object.freeze({
    type: "in-process",
    config: Object.freeze({
      topic: `copilotz.embedded.${crypto.randomUUID()}`,
    }),
  });
  const engine = options.engine ?? {};
  const { publish: _publish, ...workerEngine } = engine;
  let gateway: Awaited<ReturnType<typeof createCopilotzGateway>> | undefined;
  let worker: Awaited<ReturnType<typeof createCopilotzWorker>> | undefined;
  try {
    gateway = await createCopilotzGateway({
      namespace: options.namespace,
      databaseSchema: options.databaseSchema,
      core: options.core,
      plugins: options.plugins,
      resources: options.resources,
      pluginResolver: options.pluginResolver,
      toolCatalog: options.toolCatalog,
      assets: options.assets,
      persistence,
      transports: [transport],
      target: { workerId },
      engine,
    });
    worker = await createCopilotzWorker({
      namespace: options.namespace,
      databaseSchema: options.databaseSchema,
      core: options.core,
      plugins: options.plugins,
      resources: options.resources,
      pluginResolver: options.pluginResolver,
      toolCatalog: options.toolCatalog,
      assets: options.assets,
      persistence,
      id: workerId,
      transport,
      capacity: options.worker?.capacity,
      engine: workerEngine,
    });
    await worker.ready;
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

  const {
    role: _gatewayRole,
    transports: _gatewayTransports,
    hypervisor: _gatewayHypervisor,
    fetch: _gatewayFetch,
    ...application
  } = gateway;

  return Object.freeze({
    ...application,
    config: Object.freeze({
      ...gateway.config,
      databaseOwnership: persistence.ownership,
    }),
    role: "embedded",
    async databaseScope(databaseSchema: string) {
      await persistence.recovery?.admit();
      return await gateway!.databaseScope(databaseSchema);
    },
    async connect(input: Parameters<CopilotzApplication["connect"]>[0]) {
      await persistence.recovery?.admit();
      return await gateway!.connect(input);
    },
    async run(input: Parameters<CopilotzApplication["run"]>[0]) {
      await persistence.recovery?.admit();
      return await gateway!.run(input);
    },
    async goal(input: Parameters<CopilotzApplication["goal"]>[0]) {
      await persistence.recovery?.admit();
      return await gateway!.goal(input);
    },
    shutdown,
  });
}
