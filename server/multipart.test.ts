import { assertEquals, assertRejects } from "@std/assert";
import { createEphemeralEvent } from "@copilotz/copilotz/events";
import type {
  ApplicationOutput,
  StreamOutput,
} from "@copilotz/copilotz/streams";
import { HTTP_OBSERVATION, type HttpObservation } from "./http-types.ts";
import { applicationOutputsMultipartResponse } from "./multipart.ts";
import { decodeObservation, ProtocolError } from "../client/protocol.ts";
import { decodeOperationReplayCursor } from "../runtime/streams/index.ts";

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
  const source: HttpObservation = Object.freeze({
    type: HTTP_OBSERVATION,
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
  const frames = await Array.fromAsync(decodeObservation(response));
  const outputs = frames.filter((frame) => frame.kind === "output").map(
    (frame) => frame.output,
  );
  assertEquals(outputs.length, 3);
  assertEquals(outputs[0], event);
  assertEquals(outputs[1].streamId, "a");
  assertEquals(outputs[2].streamId, "b");
  const bytes = (id: string) =>
    frames.flatMap((frame) =>
      frame.kind === "stream-chunk" && frame.streamId === id
        ? [...frame.bytes]
        : []
    );
  assertEquals(bytes("a"), [1, 2, 3]);
  assertEquals(bytes("b"), [9, 8, 7]);
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
  const source: HttpObservation = Object.freeze({
    type: HTTP_OBSERVATION,
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
  const source: HttpObservation = Object.freeze({
    type: HTTP_OBSERVATION,
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
  const frames = await Array.fromAsync(
    decodeObservation(
      applicationOutputsMultipartResponse(source, {
        boundary: "retained-failure",
      }),
    ),
  );
  const prefix = frames.find((frame) => frame.kind === "stream-chunk");
  assertEquals(
    prefix?.kind === "stream-chunk" && new TextDecoder().decode(prefix.bytes),
    "partial",
  );
  const terminal = frames.find((frame) => frame.kind === "stream-error");
  assertEquals(
    terminal?.kind === "stream-error" && terminal.terminal.outcome,
    "cancelled",
  );
  assertEquals(terminal?.kind === "stream-error" && terminal.offset, 7);
  assertEquals(
    frames.filter((frame) => frame.kind === "stream-error").length,
    1,
  );
});

Deno.test("multipart reports concurrent replay capacity in-band and detaches", async () => {
  const payloads: ReadableStreamDefaultController<Uint8Array>[] = [];
  let detached = false;
  const source: HttpObservation = Object.freeze({
    type: HTTP_OBSERVATION,
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

Deno.test("multipart truncation rejects the observation after its last applied descriptor", async () => {
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
    "x-copilotz-cursor: checkpoint",
    "",
    descriptor,
    `--${boundary}--`,
    "",
  ].join("\r\n");
  const response = new Response(new TextEncoder().encode(raw), {
    headers: { "content-type": `multipart/mixed; boundary=${boundary}` },
  });
  const iterator = decodeObservation(response)[Symbol.asyncIterator]();
  const descriptorFrame = await iterator.next();
  assertEquals(descriptorFrame.value?.kind, "output");
  await assertRejects(
    () => iterator.next(),
    ProtocolError,
    "unfinished streams",
  );
});

Deno.test("an Action result waits for its own streams while operation completion waits for all streams", async () => {
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => release = resolve);
  const stream = (id: string, run: string, wait = false): StreamOutput => ({
    type: "stream.output",
    namespace: "tenant",
    streamId: id,
    streamOrdinal: id === "a" ? "1" : "2",
    mediaType: "text/plain",
    kind: "text",
    role: "content",
    metadata: { sourceActionRunId: run },
    payload: new ReadableStream({
      async start(controller) {
        if (wait) await blocked;
        controller.enqueue(new TextEncoder().encode(id));
        controller.close();
      },
    }),
    terminal: completedTerminal(1),
  });
  const event = (
    type: string,
    data: Record<string, unknown>,
  ): ApplicationOutput => ({
    ...createEphemeralEvent({
      type,
      namespace: "tenant",
      correlationId: "operation",
      payload: data,
    }),
    data,
  });
  const response = applicationOutputsMultipartResponse({
    type: HTTP_OBSERVATION,
    operationId: "operation",
    done: Promise.resolve(),
    cancel: () => Promise.resolve(),
    outputs: new ReadableStream({
      start(controller) {
        controller.enqueue(stream("a", "run-a"));
        controller.enqueue(stream("b", "run-b", true));
        controller.enqueue(
          event("test.action.completed", { actionRunId: "run-a" }),
        );
        controller.enqueue(
          event("operation.completed", { status: "completed" }),
        );
        controller.close();
      },
    }),
  });
  const order: string[] = [];
  try {
    for await (const frame of decodeObservation(response)) {
      if (frame.kind === "stream-chunk") order.push(`bytes:${frame.streamId}`);
      if (
        frame.kind === "output" && frame.output.type === "test.action.completed"
      ) {
        assertEquals(order, ["bytes:a"]);
        order.push("result:a");
        release();
      }
      if (
        frame.kind === "output" && frame.output.type === "operation.completed"
      ) order.push("operation:end");
    }
    assertEquals(order, ["bytes:a", "result:a", "bytes:b", "operation:end"]);
  } finally {
    release();
  }
});

Deno.test("an unread HTTP response backpressures progressive body reads and detaches on cancellation", async () => {
  let reads = 0;
  let cancelled = false;
  const stream: StreamOutput = {
    type: "stream.output",
    namespace: "tenant",
    streamId: "slow",
    streamOrdinal: "1",
    mediaType: "text/plain",
    kind: "text",
    role: "content",
    metadata: {},
    payload: new ReadableStream({
      pull(controller) {
        reads++;
        controller.enqueue(new Uint8Array(256 * 1024));
      },
      cancel() {
        cancelled = true;
      },
    }),
    terminal: completedTerminal(1000),
  };
  const response = applicationOutputsMultipartResponse({
    type: HTTP_OBSERVATION,
    operationId: "operation",
    done: Promise.resolve(),
    cancel: () => Promise.resolve(),
    outputs: new ReadableStream({
      start(controller) {
        controller.enqueue(stream);
        controller.close();
      },
    }),
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assertEquals(reads <= 3, true);
  await response.body!.cancel();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assertEquals(cancelled, true);
});
