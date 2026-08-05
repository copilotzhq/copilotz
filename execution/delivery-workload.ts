import type { WorkerWorkHandler } from "@oxian/oxian-js/worker";
import type { DeliveryExecutor } from "./delivery-executor.ts";
import type { EventBus } from "./event-bus.ts";
import {
  COPILOTZ_DELIVERY_WORKLOAD,
  type DeliveryWorkRequest,
  encodeJsonLine,
  readAllBytes,
} from "./protocol.ts";

export function createDeliveryWorkload(options: {
  executor: DeliveryExecutor;
  bus: EventBus;
}): WorkerWorkHandler {
  return async (context) => {
    const request = JSON.parse(
      new TextDecoder().decode(await readAllBytes(context.input)),
    ) as DeliveryWorkRequest;
    if (request.protocol !== COPILOTZ_DELIVERY_WORKLOAD) {
      throw new TypeError("Unsupported Copilotz delivery protocol.");
    }

    let outputController!: ReadableStreamDefaultController<Uint8Array>;
    const output = new ReadableStream<Uint8Array>({
      start(controller) {
        outputController = controller;
      },
    });
    // Durable mutations performed by a processor are published by its worker
    // runtime and relayed to the caller. Ephemeral frames use the direct sink
    // below so an in-process host cannot observe and relay its own frame in a
    // feedback loop.
    const subscription = options.bus.subscribe((event) =>
      event.durable && event.namespace === request.namespace &&
      (event.correlationId === request.correlationId ||
        event.metadata.sourceDeliveryId === request.deliveryId)
    );

    void (async () => {
      const pump = (async () => {
        for await (const event of subscription.stream) {
          outputController.enqueue(encodeJsonLine({ kind: "event", event }));
        }
      })();
      try {
        const result = await options.executor.execute(
          request.deliveryId,
          context.signal,
          (event) => {
            outputController.enqueue(encodeJsonLine({ kind: "event", event }));
          },
        );
        subscription.close();
        await pump;
        outputController.enqueue(encodeJsonLine({
          kind: "settled",
          deliveryId: request.deliveryId,
          outcome: result.outcome,
        }));
        outputController.close();
      } catch (error) {
        subscription.close();
        await pump.catch(() => undefined);
        outputController.error(error);
      }
    })();

    return {
      metadata: {
        protocol: COPILOTZ_DELIVERY_WORKLOAD,
        deliveryId: request.deliveryId,
      },
      body: output,
    };
  };
}
