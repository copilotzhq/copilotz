import { assertEquals, assertExists, assertRejects } from "@std/assert";
import { createHypervisor } from "../../dependencies/oxian-hypervisor.ts";
import { createWorker } from "../../dependencies/oxian-worker.ts";
import type { WorkHandle } from "../../dependencies/oxian-work.ts";
import { createCopilotzGateway } from "../application/gateway.ts";
import { createCopilotzWorker } from "../application/worker.ts";
import { openManagedOminipgDatabase } from "@copilotz/copilotz/persistence";
import { defineCollection } from "../collections/index.ts";
import { createEphemeralEvent } from "../events/index.ts";
import {
  definePlugin,
  defineProcessor,
  type ProcessorContext,
} from "../plugins/index.ts";
import { withProcessorEventData } from "../plugins/processor.ts";
import {
  COPILOTZ_WORK_FRAME_SCHEMA,
  COPILOTZ_WORK_OUTPUT_SCHEMA,
  createCopilotzWorkOutputRelay,
  relayCopilotzWorkHandle,
} from "./protocol.ts";

const encoder = new TextEncoder();
const LARGE_DERIVED_TEXT = "x".repeat(1024 * 1024 + 128);

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
          replayKey: "101",
          streamOrdinal: "7",
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
      replayKey: "101",
      streamOrdinal: "7",
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

Deno.test("Copilotz work framing omits derived ProcessorEvent data", async () => {
  const transport = {
    type: "in-process",
    config: { topic: `copilotz.protocol.${crypto.randomUUID()}` },
  } as const;
  const hypervisor = createHypervisor({ transports: [transport] });
  const relay = createCopilotzWorkOutputRelay();
  const event = withProcessorEventData({
    durable: true,
    id: "large-event",
    position: "1",
    schemaVersion: 1,
    type: "large.created",
    namespace: "protocol-test",
    payload: { dataRef: { eventBodyId: "body-1", schemaVersion: 1 } },
    metadata: { sourceDeliveryId: "delivery-large", preserved: true },
    correlationId: "correlation-large",
    createdAt: "2026-01-01T00:00:00.000Z",
  }, { text: LARGE_DERIVED_TEXT });
  const ephemeralEvent = withProcessorEventData({
    durable: false,
    type: "large.ephemeral",
    namespace: "protocol-test",
    payload: {
      body: [{
        assetId: "asset-large",
        kind: "text",
        role: "body",
        mediaType: "text/plain",
      }],
    },
    metadata: { sourceDeliveryId: "delivery-large", ephemeral: true },
    correlationId: "correlation-large-ephemeral",
    createdAt: "2026-01-01T00:00:00.000Z",
  }, { body: [{ value: LARGE_DERIVED_TEXT }] });
  const worker = createWorker({
    id: "copilotz-protocol-large-worker",
    transport,
    workloads: relay.wrap({
      "copilotz.delivery.v1": async ({ metadata }) => {
        for (const output of [event, ephemeralEvent]) {
          await relay.publish({
            ...output,
            metadata: {
              ...output.metadata,
              sourceDeliveryId: metadata.deliveryId,
            },
          });
        }
        return { metadata: { status: "succeeded" } };
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
        deliveryId: "delivery-large",
      },
    });
    const work = relayCopilotzWorkHandle(dispatched, {
      onOutput(output) {
        outputs.push(output);
      },
    });
    assertEquals(await work.metadata, { status: "succeeded" });
    await work.completed;
    assertEquals(outputs.length, 2);
    const output = outputs[0] as Record<string, unknown>;
    assertEquals(output.type, "large.created");
    assertEquals(output.payload, event.payload);
    assertEquals(output.metadata, {
      sourceDeliveryId: "delivery-large",
      preserved: true,
    });
    assertEquals(Object.hasOwn(output, "data"), false);
    const ephemeralOutput = outputs[1] as Record<string, unknown>;
    assertEquals(ephemeralOutput.type, "large.ephemeral");
    assertEquals(ephemeralOutput.payload, ephemeralEvent.payload);
    assertEquals(ephemeralOutput.metadata, {
      sourceDeliveryId: "delivery-large",
      ephemeral: true,
    });
    assertEquals(Object.hasOwn(ephemeralOutput, "data"), false);
  } finally {
    await worker.stop("protocol large event test complete");
    await worker.closed;
    await hypervisor.shutdown("protocol large event test complete");
  }
});

Deno.test("Gateway resolves stripped ProcessorEvent data after worker relay", async () => {
  const namespace = "protocol-large-relay";
  const databaseSchema = "protocol_large_relay";
  const largeRecord = defineCollection({
    name: "relay_large_record",
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        id: { type: "string" },
        namespace: { type: "string" },
        body: { type: "array", items: { type: "object" } },
        createdAt: { type: "string" },
        updatedAt: { type: "string" },
      },
      required: ["id", "namespace", "body", "createdAt", "updatedAt"],
    } as const,
    content: { fields: ["body"] },
  });
  const observed: unknown[] = [];
  const plugin = definePlugin({
    id: "test.protocol-large-relay",
    version: "1.0.0",
    collections: { largeRecord },
    processors: {
      seed: defineProcessor<ProcessorContext>({
        id: "test.protocol-large-relay.seed",
        on: [{ eventType: "relay.large.request" }],
        async handle(_event, context) {
          const content = await context.content.prepare({
            type: "text",
            text: LARGE_DERIVED_TEXT,
          }, { operationKey: "large-body" });
          await context.collections.largeRecord.create({
            id: "relay-large-1",
            body: content,
          }, { operationKey: "create-large-record" });
        },
      }),
      observe: defineProcessor<ProcessorContext>({
        id: "test.protocol-large-relay.observe",
        on: [{ eventType: "relay_large_record.created" }],
        handle(event) {
          observed.push(event);
        },
      }),
    },
  });
  const database = await openManagedOminipgDatabase({ url: ":memory:" });
  const transport = {
    type: "in-process" as const,
    config: { topic: `copilotz.protocol.${crypto.randomUUID()}` },
  };
  const shared = {
    database: database.database,
    namespace,
    databaseSchema,
    plugins: [plugin],
    engine: { retryBaseMs: 0, random: () => 0 },
  };
  const gateway = await createCopilotzGateway({
    ...shared,
    transports: [transport],
    target: { workerId: "protocol-large-worker" },
  });
  const worker = await createCopilotzWorker({
    ...shared,
    id: "protocol-large-worker",
    transport,
    capacity: 1,
  });

  try {
    await worker.ready;
    const observedOutput = (async () => {
      for await (const output of gateway.application.observe()) {
        if (output.type === "relay_large_record.created") return output;
      }
      throw new Error("Gateway observer closed before the collection event.");
    })();
    const run = await gateway.application.send({ type: "relay.large.request" });
    const outputs = (async () => {
      const values = [];
      for await (const output of run.outputs) values.push(output);
      return values;
    })();
    await run.done;
    const resolved = await observedOutput;
    const values = await outputs;
    const data = (resolved as {
      data: { record: { body: readonly [{ value?: unknown }] } };
    }).data;
    assertEquals(typeof data.record.body[0].value, "string");
    assertEquals(
      data.record.body[0].value,
      LARGE_DERIVED_TEXT,
    );
    const runOutput = values.find((output) =>
      output.type === "relay_large_record.created"
    );
    assertExists(runOutput);
    const runData = (runOutput as {
      data: { record: { body: readonly [{ value?: unknown }] } };
    }).data;
    assertEquals(runData.record.body[0].value, LARGE_DERIVED_TEXT);
    assertEquals(runOutput, resolved);
    assertEquals(observed.length, 1);
    assertEquals(
      (await gateway.application.events.settlement(namespace, run.eventId))
        .unsettled,
      0,
    );
  } finally {
    await Promise.allSettled([
      gateway.close("protocol large relay test complete"),
      worker.stop("protocol large relay test complete"),
    ]);
    await database.close();
  }
});
