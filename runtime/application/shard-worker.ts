import {
  createWorker,
  type Worker,
  type WorkerLifecycleCallbacks,
  type WorkerOptions,
} from "../../dependencies/oxian-worker.ts";

import { shardSessionId, type ShardSessionKind } from "./shard-identity.ts";

/** Database-free worker boundary; private shard routing never reaches workload metadata. */
export function createShardWorker(
  options: WorkerOptions & { kind?: ShardSessionKind },
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
  const { kind = "worker", ...workerOptions } = options;
  return createWorker({
    ...workerOptions,
    workloads,
    id: shardSessionId(kind, options.id),
    ...(options.activate
      ? {
        async activate(
          context: Parameters<NonNullable<WorkerOptions["activate"]>>[0],
        ) {
          const result = await options.activate!(context);
          const identity = "identity" in result ? result.identity : result;
          const scoped = {
            ...identity,
            workerId: shardSessionId(kind, identity.workerId),
          };
          return "identity" in result
            ? { ...result, identity: scoped }
            : scoped;
        },
      }
      : {}),
  }, lifecycle);
}
