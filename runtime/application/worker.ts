import { createShardWorker as createWorker } from "./shard-worker.ts";
import type {
  Worker,
  WorkerLifecycleCallbacks,
  WorkerOptions,
  WorkerResult,
} from "../../dependencies/oxian-worker.ts";
import { createOwnerWorkerWorkloads } from "../execution/owner-capability-worker.ts";
import { resolveDeliveryTimeoutMs } from "../execution/deadlines.ts";
import { createPluginRegistry } from "../plugins/registry.ts";
import type { CreateCopilotzApplicationOptions } from "./types.ts";

export type CreateCopilotzWorkerOptions =
  & Pick<
    CreateCopilotzApplicationOptions,
    | "deliveryTimeoutMs"
    | "namespace"
    | "databaseSchema"
    | "plugins"
    | "collections"
    | "actions"
    | "processors"
    | "views"
    | "resources"
    | "adapters"
  >
  & Omit<WorkerOptions, "workloads">
  & Readonly<
    {
      hostCommands?: never;
      databaseScopes?: never;
      authorization?: never;
    }
  >;

/** Private execution-role authority projected by the package factory. */
export type InternalCopilotzWorker =
  & Omit<Worker, "closed" | "stop" | "callHost">
  & Readonly<{
    role: "worker";
    closed: Promise<WorkerResult>;
    stop(reason?: string): Promise<void>;
  }>;

/** Runs the common execution kernel using its gateway owner's capabilities. */
export async function createCopilotzWorker(
  options: CreateCopilotzWorkerOptions,
  lifecycle: WorkerLifecycleCallbacks = {},
): Promise<InternalCopilotzWorker> {
  if (
    [
      "database",
      "persistence",
      "assets",
      "hostCommands",
      "databaseScopes",
      "authorization",
    ]
      .some((key) => Object.hasOwn(options, key))
  ) {
    throw new TypeError(
      "Workers accept transport capabilities, never database or persistence options.",
    );
  }
  const registry = createPluginRegistry({
    plugins: options.plugins,
    collections: options.collections,
    actions: options.actions,
    processors: options.processors,
    views: options.views,
    resources: options.resources,
    adapters: options.adapters,
  });
  const deliveryTimeoutMs = resolveDeliveryTimeoutMs(
    options.deliveryTimeoutMs ?? options.hostCalls?.timeoutMs,
    registry.actions,
  );
  const workloads = createOwnerWorkerWorkloads({
    registry,
    deliveryTimeoutMs,
  });
  const worker = createWorker({
    id: options.id,
    transport: options.transport,
    activate: options.activate,
    register: options.register,
    handshake: options.handshake,
    handshakeTimeoutMs: options.handshakeTimeoutMs,
    readyTimeoutMs: options.readyTimeoutMs,
    resumeExpirySkewMs: options.resumeExpirySkewMs,
    inputBufferBytes: options.inputBufferBytes,
    createHeartbeatMetadata: options.createHeartbeatMetadata,
    reconnectDelay: options.reconnectDelay,
    maxReconnectDelayMs: options.maxReconnectDelayMs,
    createHandshakeId: options.createHandshakeId,
    now: options.now,
    capacity: options.capacity ?? 8,
    signal: options.signal,
    hostCalls: {
      ...options.hostCalls,
      maxConcurrent: options.hostCalls?.maxConcurrent ?? 128,
      timeoutMs: deliveryTimeoutMs,
    },
    workloads,
  }, lifecycle);
  return await Promise.resolve({
    role: "worker",
    ready: worker.ready,
    closed: worker.closed,
    events: worker.events,
    snapshot: worker.snapshot,
    async stop(reason = "copilotz_worker_stopped") {
      await worker.stop(reason);
      await worker.closed;
    },
  });
}
