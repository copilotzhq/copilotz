import type { HypervisorTransport } from "../../dependencies/oxian-hypervisor.ts";
import { createCopilotzGateway } from "./gateway.ts";
import type { CreateCopilotzGatewayOptions } from "./gateway.ts";
import { openCopilotzPersistence } from "./persistence.ts";
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
  >
  & Readonly<{ worker?: EmbeddedWorkerOptions }>;

export type CopilotzEmbeddedApplication =
  & CopilotzApplication
  & Readonly<{ role: "embedded" }>;

/**
 * Creates the normal factory-first Copilotz application.
 *
 * With no session, Copilotz owns one private Ominipg connection. Injected
 * sessions and execution infrastructure remain application-owned unless an
 * explicit close callback grants ownership.
 */
export async function createCopilotz(
  options: CreateCopilotzOptions = {},
): Promise<CopilotzEmbeddedApplication> {
  const persistence = await openCopilotzPersistence(options);
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
      schema: options.schema,
      core: options.core,
      plugins: options.plugins,
      resources: options.resources,
      pluginResolver: options.pluginResolver,
      toolCatalog: options.toolCatalog,
      session: persistence.session,
      transports: [transport],
      target: { workerId },
      engine,
    });
    worker = await createCopilotzWorker({
      namespace: options.namespace,
      schema: options.schema,
      core: options.core,
      plugins: options.plugins,
      resources: options.resources,
      pluginResolver: options.pluginResolver,
      toolCatalog: options.toolCatalog,
      session: persistence.session,
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
      sessionOwnership: persistence.ownership,
    }),
    role: "embedded",
    shutdown,
  });
}
