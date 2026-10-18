import {
  createWorker,
  type Worker,
  type WorkerLifecycleCallbacks,
  type WorkerOptions,
  type WorkerResult,
} from "../../dependencies/oxian-worker.ts";
import { createCopilotzWorkOutputRelay } from "../execution/index.ts";
import { connectOwnerExecution } from "../execution/workload.ts";
import { createPluginRegistry } from "../plugins/index.ts";
import { withApplicationIngress } from "./ingress/registry.ts";
import type { CreateCopilotzApplicationOptions } from "./types.ts";
import type { CopilotzPersistenceOptions } from "@copilotz/copilotz/persistence";

export type CreateCopilotzWorkerOptions =
  & Omit<
    CreateCopilotzApplicationOptions,
    "database" | "engine"
  >
  & CopilotzPersistenceOptions
  & Omit<WorkerOptions, "workloads">;

/** Private execution-role authority projected by the package factory. */
export type InternalCopilotzWorker =
  & Omit<Worker, "closed" | "stop">
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
  const relay = createCopilotzWorkOutputRelay();
  const registry = withApplicationIngress(
    createPluginRegistry({
      plugins: options.plugins,
      collections: options.collections,
      actions: options.actions,
      processors: options.processors,
      views: options.views,
      resources: options.resources,
      adapters: options.adapters,
    }),
  );
  const workloads = connectOwnerExecution(
    options.transport,
    options.database ?? options.persistence,
    options.databaseSchema?.trim() || "public",
    {
      registry,
      publish: relay.publish,
      workerId: options.id,
      onDiagnostic: options.onDeliveryDiagnostic,
    },
  );
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
    workloads: relay.wrap(workloads),
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
