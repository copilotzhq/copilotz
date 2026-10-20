import {
  createWorker,
  type Worker,
  type WorkerLifecycleCallbacks,
  type WorkerOptions,
} from "../../dependencies/oxian-worker.ts";

/** Database-free worker boundary; private shard routing never reaches workload metadata. */
export function createShardWorker(
  options: WorkerOptions,
  lifecycle: WorkerLifecycleCallbacks = {},
): Worker {
  if (
    ["database", "persistence", "databaseScopes"].some((key) =>
      Object.hasOwn(options, key)
    )
  ) {
    throw new TypeError(
      "Workers accept transport capabilities, never a database.",
    );
  }
  const workloads = Object.fromEntries(
    Object.entries(options.workloads).map((
      [name, handle],
    ) => [name, (context: Parameters<typeof handle>[0]) => {
      const { copilotzShardIntent: _intent, ...metadata } = context.metadata;
      return handle({ ...context, metadata: Object.freeze(metadata) });
    }]),
  );
  return createWorker({ ...options, workloads }, lifecycle);
}
