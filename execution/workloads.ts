import type { WorkerWorkHandler } from "@oxian/oxian-js/worker";
import type { DeliveryExecutor } from "./delivery-executor.ts";
import type { StreamExecutor } from "./stream-executor.ts";
import type { EventBus } from "./event-bus.ts";
import { createDeliveryWorkload } from "./delivery-workload.ts";
import { createStreamWorkload } from "./stream-workload.ts";
import {
  COPILOTZ_DELIVERY_WORKLOAD,
  COPILOTZ_STREAM_WORKLOAD,
} from "./protocol.ts";

/** Workload map for private hosts and app-owned Oxian workers. */
export function createCopilotzWorkloads(options: {
  delivery: DeliveryExecutor;
  stream: StreamExecutor;
  bus: EventBus;
}): Readonly<Record<string, WorkerWorkHandler>> {
  return Object.freeze({
    [COPILOTZ_DELIVERY_WORKLOAD]: createDeliveryWorkload({
      executor: options.delivery,
      bus: options.bus,
    }),
    [COPILOTZ_STREAM_WORKLOAD]: createStreamWorkload({
      executor: options.stream,
      bus: options.bus,
    }),
  });
}
