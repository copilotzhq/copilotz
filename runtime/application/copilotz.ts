import type { HypervisorTransport } from "../../dependencies/oxian-hypervisor.ts";
import { createCopilotzGateway } from "./gateway.ts";
import type { CreateCopilotzGatewayOptions } from "./gateway.ts";
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
      plugins: options.plugins,
      resources: options.resources,
      adapters: options.adapters,
      assets: options.assets,
      persistence,
      transports: [transport],
      target: { workerId },
      engine,
    });
    worker = await createCopilotzWorker({
      namespace: options.namespace,
      databaseSchema: options.databaseSchema,
      plugins: options.plugins,
      resources: options.resources,
      adapters: options.adapters,
      assets: options.assets,
      persistence,
      id: workerId,
      transport,
      capacity: options.worker?.capacity ?? 8,
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

  return Object.freeze({
    async send(input: Parameters<CopilotzApplication["send"]>[0]) {
      return await gateway!.send(input);
    },
    observe: () => gateway!.observe(),
    close: shutdown,
  });
}
