import { assertEquals, assertRejects } from "@std/assert";
import { createEphemeralEvent } from "@copilotz/copilotz/events";
import type {
  ApplicationOutput,
  StreamOutput,
} from "@copilotz/copilotz/streams";
import {
  EVENT_NATIVE_OUTPUT_STREAM,
  type EventNativeOutputStream,
} from "./event-native.ts";
import {
  applicationOutputsMultipartResponse,
  decodeCopilotzOutputs,
} from "./multipart.ts";
import { decodeOperationReplayCursor } from "../runtime/streams/index.ts";

async function allBytes(stream: ReadableStream<Uint8Array>): Promise<number[]> {
  const result: number[] = [];
  for await (const chunk of stream) result.push(...chunk);
  return result;
}

function completedTerminal(
  offset: number,
): Promise<StreamOutput["terminal"] extends Promise<infer T> ? T : never> {
  return Promise.resolve(Object.freeze({
    outcome: "completed" as const,
    availability: "retained" as const,
    capture: "complete" as const,
    offset,
    terminalAt: "2026-09-01T12:00:00.000Z",
  }));
}

Deno.test("multipart round-trips exact descriptors and independent raw streams", async () => {
  const event = Object.freeze({
    ...createEphemeralEvent({
      type: "test.output",
      namespace: "tenant-a",
      correlationId: "run-a",
      payload: { value: 1 },
    }),
    data: Object.freeze({ value: 1 }),
  });
  const media = (
    streamId: string,
    streamOrdinal: string,
    chunks: readonly number[][],
  ): StreamOutput =>
    Object.freeze({
      type: "stream.output",
      namespace: "tenant-a",
      streamId,
      streamOrdinal,
      mediaType: "application/octet-stream",
      kind: "file",
      role: "assistant.file",
      correlationId: "run-a",
      metadata: Object.freeze({}),
      payload: new ReadableStream<Uint8Array>({
        start(controller) {
          for (const chunk of chunks) {
            controller.enqueue(Uint8Array.from(chunk));
          }
          controller.close();
        },
      }),
      terminal: completedTerminal(chunks.flat().length),
    });
  const source: EventNativeOutputStream = Object.freeze({
    type: EVENT_NATIVE_OUTPUT_STREAM,
    operationId: "operation-roundtrip",
    outputs: new ReadableStream<ApplicationOutput>({
      start(controller) {
        controller.enqueue(event);
        controller.enqueue(media("a", "1", [[1, 2], [3]]));
        controller.enqueue(media("b", "2", [[9], [8, 7]]));
        controller.close();
      },
    }),
    done: Promise.resolve(),
    cancel: () => Promise.resolve(),
  });
  const response = applicationOutputsMultipartResponse(source, {
    boundary: "copilotz-test",
  });
  const outputs: ApplicationOutput[] = [];
  for await (const output of decodeCopilotzOutputs(response)) {
    outputs.push(output);
  }
  assertEquals(outputs.length, 3);
  assertEquals(outputs[0], event);
  assertEquals((outputs[1] as StreamOutput).streamId, "a");
  assertEquals((outputs[2] as StreamOutput).streamId, "b");
  assertEquals(await allBytes((outputs[1] as StreamOutput).payload), [1, 2, 3]);
  assertEquals(await allBytes((outputs[2] as StreamOutput).payload), [9, 8, 7]);
});

Deno.test("multipart cursor tracks an operation lane independently of its stream identifier", async () => {
  const media = (streamId: string, streamOrdinal: string): StreamOutput =>
    Object.freeze({
      type: "stream.output",
      namespace: "tenant-a",
      streamId,
      streamOrdinal,
      mediaType: "application/octet-stream",
      kind: "file",
      role: "assistant.file",
      metadata: Object.freeze({}),
      payload: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([1]));
          controller.close();
        },
      }),
      terminal: completedTerminal(1),
    });
  const source: EventNativeOutputStream = Object.freeze({
    type: EVENT_NATIVE_OUTPUT_STREAM,
    operationId: "operation-cursor-atomicity",
    outputs: new ReadableStream<ApplicationOutput>({
      start(controller) {
        controller.enqueue(media("a".repeat(513), "1"));
        controller.enqueue(media("lane-b", "2"));
        controller.close();
      },
    }),
    done: Promise.resolve(),
    cancel: () => Promise.resolve(),
  });
  const response = applicationOutputsMultipartResponse(source, {
    boundary: "copilotz-cursor-atomicity",
  });
  const raw = new TextDecoder().decode(await response.arrayBuffer());
  const match = raw.match(
    /x-copilotz-stream-id: lane-b\r\nx-copilotz-offset: 0\r\nx-copilotz-cursor: ([^\r]+)\r\n/,
  );
  assertEquals(match !== null, true);
  assertEquals(decodeOperationReplayCursor(match![1]), {
    operationStreamPositions: {
      "operation-cursor-atomicity": { highWatermark: 1, offsets: { "2": 1 } },
    },
  });
});

Deno.test("multipart keeps retained stream failure in-band and round-trips terminal status", async () => {
  const failed: StreamOutput = Object.freeze({
    type: "stream.output",
    namespace: "tenant-a",
    streamId: "failed-prefix",
    streamOrdinal: "1",
    mediaType: "text/plain",
    kind: "text",
    role: "assistant",
    metadata: Object.freeze({}),
    payload: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("partial"));
        controller.close();
      },
    }),
    terminal: Promise.resolve(Object.freeze({
      outcome: "cancelled",
      availability: "retained",
      capture: "truncated",
      offset: 7,
      terminalAt: "2026-09-01T12:00:00.000Z",
    })),
  });
  const source: EventNativeOutputStream = Object.freeze({
    type: EVENT_NATIVE_OUTPUT_STREAM,
    operationId: "operation-failed-prefix",
    outputs: new ReadableStream<ApplicationOutput>({
      start(controller) {
        controller.enqueue(failed);
        controller.close();
      },
    }),
    done: Promise.resolve(),
    cancel: () => Promise.resolve(),
  });
  const decoded: ApplicationOutput[] = [];
  for await (
    const output of decodeCopilotzOutputs(
      applicationOutputsMultipartResponse(source, {
        boundary: "copilotz-retained-failure",
      }),
    )
  ) decoded.push(output);

  const stream = decoded[0] as StreamOutput;
  const reader = stream.payload.getReader();
  const prefix = await reader.read();
  assertEquals(prefix.done, false);
  assertEquals(
    new TextDecoder().decode(prefix.value),
    "partial",
  );
  await assertRejects(
    () => reader.read(),
    Error,
    "terminated before completion",
  );
  reader.releaseLock();
  assertEquals(await stream.terminal, {
    outcome: "cancelled",
    availability: "retained",
    capture: "truncated",
    offset: 7,
    terminalAt: "2026-09-01T12:00:00.000Z",
  });
});

Deno.test("multipart reports concurrent replay capacity in-band and detaches", async () => {
  const payloads: ReadableStreamDefaultController<Uint8Array>[] = [];
  let detached = false;
  const source: EventNativeOutputStream = Object.freeze({
    type: EVENT_NATIVE_OUTPUT_STREAM,
    operationId: "operation-wide",
    outputs: new ReadableStream<ApplicationOutput>({
      start(controller) {
        for (let ordinal = 1; ordinal <= 257; ordinal++) {
          controller.enqueue(Object.freeze({
            type: "stream.output",
            namespace: "tenant-a",
            streamId: `lane-${ordinal}`,
            streamOrdinal: String(ordinal),
            mediaType: "text/plain",
            kind: "text",
            role: "assistant",
            metadata: Object.freeze({}),
            terminal: completedTerminal(0),
            payload: new ReadableStream<Uint8Array>({
              start(payloadController) {
                payloads.push(payloadController);
              },
            }),
          }));
        }
        controller.close();
      },
    }),
    done: new Promise<void>(() => undefined),
    cancel() {
      detached = true;
      for (const controller of payloads) {
        try {
          controller.error(new Error("detached"));
        } catch {
          // The transport may already have released this lane.
        }
      }
      return Promise.resolve();
    },
  });
  const raw = new TextDecoder().decode(
    await applicationOutputsMultipartResponse(
      source,
      { boundary: "copilotz-capacity" },
    ).arrayBuffer(),
  );
  assertEquals(raw.includes('"type":"replay.capacity"'), true);
  assertEquals(
    raw.includes('"code":"operation_replay_capacity_exceeded"'),
    true,
  );
  assertEquals(detached, true);
  assertEquals(raw.endsWith("--copilotz-capacity--\r\n"), true);
});

Deno.test("multipart truncation settles every published terminal promise", async () => {
  const boundary = "copilotz-truncated";
  const descriptor = JSON.stringify({
    type: "stream.output",
    namespace: "tenant-a",
    streamId: "truncated-stream",
    streamOrdinal: "1",
    mediaType: "text/plain",
    kind: "text",
    role: "assistant",
    metadata: {},
  });
  const raw = [
    `--${boundary}`,
    "content-type: application/json; charset=utf-8",
    `content-length: ${new TextEncoder().encode(descriptor).byteLength}`,
    "x-copilotz-frame: output",
    "",
    descriptor,
    `--${boundary}--`,
    "",
  ].join("\r\n");
  const response = new Response(new TextEncoder().encode(raw), {
    headers: { "content-type": `multipart/mixed; boundary=${boundary}` },
  });
  const outputs: ApplicationOutput[] = [];
  for await (const output of decodeCopilotzOutputs(response)) {
    outputs.push(output);
  }
  const stream = outputs[0] as StreamOutput;
  assertEquals(await stream.terminal, {
    outcome: "abandoned",
    availability: "missing",
    capture: "truncated",
    offset: 0,
    terminalAt: (await stream.terminal)?.terminalAt,
  });
  await assertRejects(
    () => new Response(stream.payload).arrayBuffer(),
    Error,
    "truncated",
  );
});
