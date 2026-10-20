/** Portable entry for the sole worker role. No database implementation. @module */
export * from "./authoring.ts";
import {
  createCopilotzWorker,
  type CreateCopilotzWorkerOptions,
} from "./runtime/application/worker.ts";
import type { WorkerLifecycleCallbacks } from "./dependencies/oxian-worker.ts";
export type CreateCopilotzOptions =
  & CreateCopilotzWorkerOptions
  & Readonly<{ role: "worker" }>;
export async function createCopilotz(
  options: CreateCopilotzOptions,
  lifecycle: WorkerLifecycleCallbacks = {},
): Promise<
  Readonly<
    {
      ready: Promise<void>;
      closed: Promise<void>;
      close(reason?: string): Promise<void>;
    }
  >
> {
  if (options.role !== "worker") {
    throw new TypeError("The worker entry accepts only the worker role.");
  }
  const worker = await createCopilotzWorker(options, lifecycle);
  return {
    ready: worker.ready.then(() => undefined),
    closed: worker.closed.then(() => undefined),
    close: (reason?: string) => worker.stop(reason),
  };
}
