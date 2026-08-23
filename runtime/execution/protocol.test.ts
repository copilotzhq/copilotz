import { assertEquals, assertRejects } from "@std/assert";
import { createHypervisor } from "../../dependencies/oxian-hypervisor.ts";
import { createWorker } from "../../dependencies/oxian-worker.ts";
import type { WorkHandle } from "../../dependencies/oxian-work.ts";
import { createEphemeralEvent } from "../events/index.ts";
import {
  COPILOTZ_WORK_FRAME_SCHEMA,
  COPILOTZ_WORK_OUTPUT_SCHEMA,
  createCopilotzWorkOutputRelay,
  relayCopilotzWorkHandle,
} from "./protocol.ts";

const encoder = new TextEncoder();

function framedHeader(kind: number, length: number): Uint8Array {
  const bytes = new Uint8Array(7);
  bytes[0] = 0x43;
  bytes[1] = 1;
  bytes[2] = kind;
  new DataView(bytes.buffer).setUint32(3, length, false);
  return bytes;
}

function fakeFramedWork(output: Uint8Array): WorkHandle {
  const terminal = Object.freeze({
    operationId: "malformed-operation",
    workload: "copilotz.delivery.v1",
    metadata: {},
    status: "completed" as const,
    deliveryCount: 0,
    openedAtMs: 0,
    updatedAtMs: 0,
  });
  return Object.freeze({
    operationId: terminal.operationId,
    streamId: "malformed-stream",
    metadata: Promise.resolve(Object.freeze({
      schema: COPILOTZ_WORK_OUTPUT_SCHEMA,
      framing: COPILOTZ_WORK_FRAME_SCHEMA,
      workload: terminal.workload,
    })),
    output: new ReadableStream({
      start(controller) {
        controller.enqueue(output);
        controller.close();
      },
    }),
    started: Promise.resolve(),
    completed: Promise.resolve(terminal),
    cancel: () => Promise.resolve(terminal),
  });
}

Deno.test("Copilotz work framing relays semantic events, metadata, and bytes", async () => {
  const transport = {
    type: "in-process",
    config: { topic: `copilotz.protocol.${crypto.randomUUID()}` },
  } as const;
  const hypervisor = createHypervisor({ transports: [transport] });
  const relay = createCopilotzWorkOutputRelay();
  const worker = createWorker({
    id: "copilotz-protocol-worker",
    transport,
    workloads: relay.wrap({
      "copilotz.delivery.v1": async ({ metadata }) => {
        await relay.publish(createEphemeralEvent({
          type: "text.delta",
          namespace: "protocol-test",
          correlationId: "correlation-1",
          payload: { text: "hello" },
          metadata: { sourceDeliveryId: metadata.deliveryId },
        }));
        await relay.publish(Object.freeze({
          type: "stream.output" as const,
          namespace: "protocol-test",
          streamId: "protocol-stream-a",
          mediaType: "text/plain",
          kind: "text" as const,
          role: "assistant",
          causationId: "event-a",
          correlationId: "correlation-1",
          metadata: Object.freeze({
            sourceDeliveryId: metadata.deliveryId,
            lane: "protocol",
          }),
        }));
        return {
          metadata: { status: "succeeded" },
          body: encoder.encode("framed output"),
        };
      },
    }),
  });

  try {
    await worker.ready;
    const outputs: unknown[] = [];
    const dispatched = await hypervisor.dispatch({
      workload: "copilotz.delivery.v1",
      metadata: {
        schema: "copilotz.delivery.dispatch.v1",
        deliveryId: "delivery-1",
      },
    });
    const work = relayCopilotzWorkHandle(dispatched, {
      onOutput(output) {
        outputs.push(output);
      },
    });

    assertEquals(await work.metadata, { status: "succeeded" });
    assertEquals(await new Response(work.output).text(), "framed output");
    assertEquals((await work.completed).status, "completed");
    assertEquals(outputs.map((output) => (output as { type: string }).type), [
      "text.delta",
      "stream.output",
    ]);
    assertEquals(outputs.at(1), {
      type: "stream.output",
      namespace: "protocol-test",
      streamId: "protocol-stream-a",
      mediaType: "text/plain",
      kind: "text",
      role: "assistant",
      causationId: "event-a",
      correlationId: "correlation-1",
      metadata: {
        sourceDeliveryId: "delivery-1",
        lane: "protocol",
      },
    });
    assertEquals(Object.isFrozen(outputs.at(1)), true);
    assertEquals(
      Object.isFrozen((outputs.at(1) as { metadata: object }).metadata),
      true,
    );
  } finally {
    await worker.stop("protocol test complete");
    await worker.closed;
    await hypervisor.shutdown("protocol test complete");
  }
});

Deno.test("Copilotz work framing rejects unknown and oversized frames before buffering", async (test) => {
  await test.step("unknown kind", async () => {
    const work = relayCopilotzWorkHandle(fakeFramedWork(framedHeader(99, 0)));
    const completed = work.completed.catch(() => undefined);
    const output = work.output.pipeTo(new WritableStream()).catch(() =>
      undefined
    );
    await assertRejects(
      () => work.metadata,
      TypeError,
      "Unknown Copilotz work frame kind '99'",
    );
    await Promise.all([completed, output]);
  });

  await test.step("oversized output", async () => {
    const work = relayCopilotzWorkHandle(
      fakeFramedWork(framedHeader(3, 64 * 1024 + 1)),
    );
    const completed = work.completed.catch(() => undefined);
    const output = work.output.pipeTo(new WritableStream()).catch(() =>
      undefined
    );
    await assertRejects(
      () => work.metadata,
      TypeError,
      "output frame exceeds its byte limit",
    );
    await Promise.all([completed, output]);
  });
});
