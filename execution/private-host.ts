import {
  createWorkerHost,
  type InProcessWorker,
  type WorkerHost,
} from "@oxian/oxian-js/host";
import type { WorkerWorkHandler } from "@oxian/oxian-js/worker";
import { resolveAutoProviders } from "omnipg/auto";
import { createOminipgWorkload } from "omnipg/workload";
import { OMINIPG_SESSION_WORKLOAD } from "omnipg/session";
import type { DatabaseConfig } from "@/database/database.ts";

export interface PrivateExecutionHost {
  readonly host: WorkerHost;
  readonly databaseTransport: { dispatcher: WorkerHost };
  attach(
    workloads: Readonly<Record<string, WorkerWorkHandler>>,
  ): InProcessWorker;
  close(reason?: string): Promise<void>;
}

/** One private host with a long-lived Ominipg session worker and Copilotz workers. */
export function createPrivateExecutionHost(
  database: DatabaseConfig,
): PrivateExecutionHost {
  const host = createWorkerHost({
    persistAcceptance: () => Promise.resolve(),
    heartbeatIntervalMs: 30_000,
    leaseTimeoutMs: 120_000,
  });
  const workers: InProcessWorker[] = [];
  if (!database.instance) {
    const providers = resolveAutoProviders(database);
    workers.push(host.attachInProcessWorker({
      workerId: `copilotz-db-${crypto.randomUUID()}`,
      workloads: {
        [OMINIPG_SESSION_WORKLOAD]: createOminipgWorkload({
          dependencies: {
            ...providers,
            pgliteConfig: database.pgliteConfig,
          },
        }),
      },
      capacity: 1,
    }));
  }
  return {
    host,
    databaseTransport: { dispatcher: host },
    attach(workloads) {
      const worker = host.attachInProcessWorker({
        workerId: `copilotz-core-${crypto.randomUUID()}`,
        workloads,
        capacity: 32,
      });
      workers.push(worker);
      return worker;
    },
    async close(reason = "copilotz_shutdown") {
      await Promise.all(workers.map((worker) => worker.shutdown(reason)));
      await host.shutdown(reason);
    },
  };
}
