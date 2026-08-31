import { assertEquals } from "@std/assert";
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
  const media = (streamId: string, chunks: readonly number[][]): StreamOutput =>
    Object.freeze({
      type: "stream.output",
      namespace: "tenant-a",
      streamId,
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
    });
  const source: EventNativeOutputStream = Object.freeze({
    type: EVENT_NATIVE_OUTPUT_STREAM,
    outputs: new ReadableStream<ApplicationOutput>({
      start(controller) {
        controller.enqueue(event);
        controller.enqueue(media("a", [[1, 2], [3]]));
        controller.enqueue(media("b", [[9], [8, 7]]));
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

Deno.test("multipart cursor never leaks a failed concurrent stream offset", async () => {
  const media = (streamId: string): StreamOutput =>
    Object.freeze({
      type: "stream.output",
      namespace: "tenant-a",
      streamId,
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
    });
  const source: EventNativeOutputStream = Object.freeze({
    type: EVENT_NATIVE_OUTPUT_STREAM,
    outputs: new ReadableStream<ApplicationOutput>({
      start(controller) {
        controller.enqueue(media("a".repeat(513)));
        controller.enqueue(media("lane-b"));
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
  assertEquals(
    decodeOperationReplayCursor(match![1]).streamOffsets,
    { "s:lane-b": 1 },
  );
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
            replayKey: String(ordinal),
            streamOrdinal: String(ordinal),
            mediaType: "text/plain",
            kind: "text",
            role: "assistant",
            metadata: Object.freeze({}),
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
    async cancel() {
      detached = true;
      for (const controller of payloads) {
        try {
          controller.error(new Error("detached"));
        } catch {
          // The transport may already have released this lane.
        }
      }
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
