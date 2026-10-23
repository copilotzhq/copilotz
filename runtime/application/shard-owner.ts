import { resolveDeliveryTimeoutMs } from "../execution/deadlines.ts";
import {
  createWorker,
  type Worker,
  type WorkerOptions,
} from "../../dependencies/oxian-worker.ts";
import type {
  WorkerCallContext,
  WorkerCallOptions,
} from "../../dependencies/oxian-hypervisor.ts";

export const SHARD_OWNER_WORKLOAD = "copilotz.shard.owner.v1";
const bytes = (value: unknown) =>
  new TextEncoder().encode(JSON.stringify(value));
/** An authenticated shard uplink; callbacks use Oxian callHost, never HTTP Actions. */
export type ShardOwnerConnection = Readonly<{
  ready: Worker["ready"];
  close(reason?: string): Promise<void>;
  call(input: unknown, signal?: AbortSignal): Promise<unknown>;
}>;
export function connectShardOwner(
  options: Omit<WorkerOptions, "workloads">,
): ShardOwnerConnection {
  const worker = createWorker({
    ...options,
    hostCalls: {
      ...options.hostCalls,
      timeoutMs: resolveDeliveryTimeoutMs(options.hostCalls?.timeoutMs),
    },
    workloads: { "copilotz.shard.control.v1": () => undefined },
  });
  return {
    ready: worker.ready,
    close: (reason?: string) => worker.stop(reason),
    async call(input: unknown, signal?: AbortSignal): Promise<unknown> {
      await worker.ready;
      const handle = await worker.callHost({
        workload: SHARD_OWNER_WORKLOAD,
        body: bytes(input),
        signal,
      });
      const reply = await new Response(handle.output).json();
      await handle.completed;
      if (reply.error) {
        throw Object.assign(new Error(reply.error.message), reply.error);
      }
      return reply.value;
    },
  };
}
/** Admission supplies identity. The callback payload cannot override it. */
export function shardOwnerCalls<T>(options: {
  deliveryTimeoutMs?: number;
  authorize(context: WorkerCallContext): T | undefined;
  invoke(
    identity: T,
    input: unknown,
    signal: AbortSignal,
  ): unknown | Promise<unknown>;
}): WorkerCallOptions {
  return {
    admit: () => undefined,
    admitUnassigned(context) {
      if (context.workload !== SHARD_OWNER_WORKLOAD) return;
      const identity = options.authorize(context);
      if (identity === undefined) return;
      return async (call) => {
        try {
          const input = await new Response(call.input).json();
          context.signal.throwIfAborted();
          const value = await options.invoke(identity, input, context.signal);
          return bytes({ value: value ?? null });
        } catch (error) {
          const e = error as {
            code?: string;
            status?: number;
            retryable?: boolean;
          };
          return bytes({
            error: {
              message: "Owner callback failed",
              code: e.code ?? "owner_callback_failed",
              status: e.status,
              retryable: e.retryable,
            },
          });
        }
      };
    },
    maxRequestBytes: 1024 * 1024,
    maxResponseBytes: 1024 * 1024,
    maxConcurrent: 1024,
    maxPerConnection: 128,
    // Host calls carry whole deliveries (nested LLM calls); Oxian uses the
    // lower of both sides' limits, so match the worker's delivery deadline.
    timeoutMs: resolveDeliveryTimeoutMs(options.deliveryTimeoutMs),
  };
}
