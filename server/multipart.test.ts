import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { createEphemeralEvent } from "@copilotz/copilotz/events";
import type {
  ApplicationOutput,
  StreamOutput,
} from "@copilotz/copilotz/streams";
import { HTTP_OBSERVATION, type HttpObservation } from "./http-types.ts";
import { applicationOutputsMultipartResponse } from "./multipart.ts";
import {
  decodeObservation,
  MAX_FRAME_BYTES,
  OBSERVATION_FRAME_CAPACITY_CODE,
  ProtocolError,
  RenewalObservationError,
} from "../client/protocol.ts";
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

Deno.test("multipart preserves resolved output envelopes above the binary chunk limit", async () => {
  const value = "x".repeat(MAX_FRAME_BYTES + 4096);
  const event = Object.freeze({
    ...createEphemeralEvent({
      type: "large.output",
      namespace: "tenant-a",
      correlationId: "large-output",
      payload: { value },
    }),
    data: Object.freeze({ value }),
  });
  const frames = await Array.fromAsync(
    decodeObservation(applicationOutputsMultipartResponse({
      type: HTTP_OBSERVATION,
      operationId: "large-stream-operation",
      outputs: new ReadableStream({
        start(controller) {
          controller.enqueue(event);
          controller.close();
        },
      }),
      done: Promise.resolve(),
      cancel: () => Promise.resolve(),
    })),
  );
  const output = frames.find((frame) => frame.kind === "output");
  assertEquals(output?.kind === "output" && output.output.data, { value });
});

Deno.test("multipart keeps binary stream chunks capped at 1 MiB", async () => {
  const bytes = new Uint8Array(MAX_FRAME_BYTES + 1).fill(7);
  const frames = await Array.fromAsync(
    decodeObservation(applicationOutputsMultipartResponse({
      type: HTTP_OBSERVATION,
      operationId: "large-stream-operation",
      outputs: new ReadableStream({
        start(controller) {
          controller.enqueue(
            {
              type: "stream.output",
              namespace: "tenant-a",
              streamId: "large-stream",
              streamOrdinal: "1",
              mediaType: "application/octet-stream",
              kind: "file",
              role: "assistant.file",
              metadata: {},
              payload: new ReadableStream({
                start(payloadController) {
                  payloadController.enqueue(bytes);
                  payloadController.close();
                },
              }),
              terminal: completedTerminal(bytes.length),
            } satisfies StreamOutput,
          );
          controller.close();
        },
      }),
      done: Promise.resolve(),
      cancel: () => Promise.resolve(),
    })),
  );
  const chunks = frames.filter((frame) => frame.kind === "stream-chunk");
  assertEquals(chunks.map((frame) => frame.bytes.length), [MAX_FRAME_BYTES, 1]);
});

Deno.test("multipart reports oversized output as a non-retryable observation failure", async () => {
  let detached = "";
  const safe = Object.freeze({
    ...createEphemeralEvent({
      type: "safe.output",
      namespace: "tenant-a",
      correlationId: "oversized-output",
      payload: { value: "safe" },
    }),
    durable: true,
    id: "safe-event",
    position: "1",
    schemaVersion: 1,
    data: { value: "safe" },
  }) as ApplicationOutput;
  const source: HttpObservation = {
    type: HTTP_OBSERVATION,
    operationId: "oversized-output",
    outputs: new ReadableStream({
      start(controller) {
        controller.enqueue(safe);
        controller.enqueue({
          ...createEphemeralEvent({
            type: "oversized.output",
            namespace: "tenant-a",
            correlationId: "oversized-output",
            payload: { value: "x".repeat(2048) },
          }),
          durable: true,
          id: "oversized-event",
          position: "2",
          schemaVersion: 1,
          data: { value: "x".repeat(2048) },
        } as ApplicationOutput);
        controller.close();
      },
    }),
    done: Promise.resolve(),
    cancel(reason) {
      detached = reason ?? "";
      return Promise.resolve();
    },
  };
  const response = applicationOutputsMultipartResponse(source, {
    maxJsonFrameBytes: 1024,
  });
  const bytes = await response.arrayBuffer();
  const raw = new TextDecoder().decode(bytes);
  const errorCursor = raw.match(
    /x-copilotz-frame: observation-error\r\nx-copilotz-cursor: ([^\r\n]+)/,
  )?.[1];
  const iterator = decodeObservation(
    new Response(bytes, { headers: response.headers }),
  );
  const safeFrame = await iterator.next();
  const error = await assertRejects(
    () => iterator.next(),
    ProtocolError,
    "capacity",
  );
  assertEquals(error.code, OBSERVATION_FRAME_CAPACITY_CODE);
  assertEquals(detached, OBSERVATION_FRAME_CAPACITY_CODE);
  assertEquals(safeFrame.value?.kind, "output");
  assertEquals(errorCursor, safeFrame.value?.checkpoint);
});

Deno.test("multipart rejects invalid lower JSON envelope capacities", () => {
  const source: HttpObservation = {
    type: HTTP_OBSERVATION,
    outputs: new ReadableStream(),
    done: Promise.resolve(),
    cancel: () => Promise.resolve(),
  };
  assertThrows(
    () => applicationOutputsMultipartResponse(source, { maxJsonFrameBytes: 0 }),
    RangeError,
    "between 1",
  );
  assertThrows(
    () =>
      applicationOutputsMultipartResponse(source, { maxJsonFrameBytes: -1 }),
    RangeError,
    "between 1",
  );
});

Deno.test("runtime logical capacity errors stay non-retryable through multipart and the client", async () => {
  const { createCopilotzClient } = await import("../client/index.ts");
  let calls = 0;
  let detached = "";
  const client = createCopilotzClient({
    baseUrl: "/api",
    fetch: (() => {
      calls++;
      return Promise.resolve(applicationOutputsMultipartResponse({
        type: HTTP_OBSERVATION,
        outputs: new ReadableStream({
          start(controller) {
            controller.error(
              Object.assign(new Error("Logical output exceeds its capacity."), {
                code: OBSERVATION_FRAME_CAPACITY_CODE,
              }),
            );
          },
        }),
        done: Promise.resolve(),
        cancel(reason) {
          detached = reason ?? "";
          return Promise.resolve();
        },
      }));
    }) as typeof fetch,
  });
  const error = await assertRejects(
    () => client.operations.observe({ operationIds: ["op"], onFrame() {} }),
    ProtocolError,
    "capacity",
  );
  assertEquals(error.code, OBSERVATION_FRAME_CAPACITY_CODE);
  assertEquals(calls, 1);
  assertEquals(detached, OBSERVATION_FRAME_CAPACITY_CODE);
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

Deno.test("replay read interruption does not fabricate a terminal stream failure", async () => {
  const source: HttpObservation = {
    type: HTTP_OBSERVATION,
    operationId: "interrupted",
    outputs: new ReadableStream({
      start(c) {
        c.enqueue({
          type: "stream.output",
          namespace: "tenant",
          streamId: "s",
          streamOrdinal: "1",
          mediaType: "text/plain",
          kind: "text",
          role: "content",
          metadata: {},
          payload: new ReadableStream({
            pull() {
              throw new Error("temporary storage read failure");
            },
          }),
          terminal: completedTerminal(1),
        });
        c.close();
      },
    }),
    done: Promise.resolve(),
    cancel: () => Promise.resolve(),
  };
  const frames: string[] = [];
  await assertRejects(
    async () => {
      for await (
        const frame of decodeObservation(
          applicationOutputsMultipartResponse(source),
        )
      ) frames.push(frame.kind);
    },
    ProtocolError,
    "interrupted",
  );
  assertEquals(frames.includes("stream-error"), false);
});

Deno.test("bootstrap drains historical terminal lanes without exhausting concurrent cursor capacity", async () => {
  const count = 300;
  const source: HttpObservation = {
    type: HTTP_OBSERVATION,
    operationId: "long-run",
    bootstrap: Array.from(
      { length: count },
      (_, i) => ({ streamId: `s${i}`, offset: 1, terminal: true }),
    ),
    outputs: new ReadableStream({
      start(c) {
        for (let i = 0; i < count; i++) {
          c.enqueue({
            type: "stream.output",
            namespace: "tenant",
            streamId: `s${i}`,
            streamOrdinal: String(i + 1),
            mediaType: "text/plain",
            kind: "text",
            role: "content",
            metadata: {},
            payload: new ReadableStream({
              start(p) {
                p.enqueue(new Uint8Array([65]));
                p.close();
              },
            }),
            terminal: completedTerminal(1),
          });
        }
        c.close();
      },
    }),
    done: Promise.resolve(),
    cancel: () => Promise.resolve(),
  };
  const frames = await Array.fromAsync(
    decodeObservation(applicationOutputsMultipartResponse(source)),
  );
  assertEquals(frames.filter((f) => f.kind === "stream-end").length, count);
});

Deno.test("terminal checkpoints retire more than 32 sequential selected operations", async () => {
  const outputs: ApplicationOutput[] = [];
  for (let index = 1; index <= 100; index++) {
    const operationId = `operation-${index}`;
    outputs.push(
      {
        type: "observation.selection",
        selectionPosition: String(index),
        operationIds: [operationId],
      } as unknown as ApplicationOutput,
    );
    outputs.push(
      {
        type: "operation.completed",
        operationId,
        durable: true,
        position: String(index * 100),
        replayPosition: "2",
      } as unknown as ApplicationOutput,
    );
  }
  const response = applicationOutputsMultipartResponse({
    type: HTTP_OBSERVATION,
    compositeCursor: true,
    outputs: new ReadableStream({
      start(controller) {
        outputs.forEach((value) => controller.enqueue(value));
        controller.close();
      },
    }),
    done: Promise.resolve(),
    cancel: () => Promise.resolve(),
  });
  let count = 0;
  for await (const frame of decodeObservation(response)) {
    if (
      frame.kind === "output" && frame.output.type === "operation.completed"
    ) {
      count++;
      assertEquals(decodeOperationReplayCursor(frame.checkpoint), {
        selectionPosition: String(count),
      });
    }
  }
  assertEquals(count, 100);
});

Deno.test("blocked frame handler renews and resumes a partial lane from its processed checkpoint", async () => {
  const { createCopilotzClient } = await import("../client/index.ts");
  const bytes = new Uint8Array([1, 2, 3, 4, 5, 6]);
  let firstOutputs!: ReadableStreamDefaultController<ApplicationOutput>;
  let detached!: () => void;
  const detachedPromise = new Promise<void>((resolve) => detached = resolve);
  let releaseHandler!: () => void;
  const blockedHandler = new Promise<void>((resolve) =>
    releaseHandler = resolve
  );
  let handlerStarted!: () => void;
  const handlerStartedPromise = new Promise<void>((resolve) =>
    handlerStarted = resolve
  );
  let payloadCancelled = false;
  let calls = 0;
  const requested: (string | undefined)[] = [];
  const client = createCopilotzClient({
    baseUrl: "/api",
    fetch: ((_url, init) => {
      const checkpoint = JSON.parse(String(init?.body)).checkpoint as
        | string
        | undefined;
      requested.push(checkpoint);
      const first = calls++ === 0;
      const offset =
        decodeOperationReplayCursor(checkpoint).operationStreamPositions?.op
          .offsets["1"] ?? 0;
      const output = {
        type: "stream.output",
        namespace: "tenant",
        operationId: "op",
        streamId: "lane",
        streamOrdinal: "1",
        mediaType: "application/octet-stream",
        kind: "file",
        role: "content",
        metadata: {},
        payload: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              first ? bytes.subarray(0, 3) : bytes.subarray(offset),
            );
            if (!first) controller.close();
          },
          cancel() {
            payloadCancelled = true;
          },
        }),
        terminal: completedTerminal(bytes.length),
      } as StreamOutput;
      const source: HttpObservation = {
        type: HTTP_OBSERVATION,
        operationId: "op",
        replayCursor: checkpoint,
        compositeCursor: true,
        outputs: new ReadableStream({
          start(controller) {
            if (first) {
              firstOutputs = controller;
              controller.enqueue(
                {
                  type: "observation.selection",
                  selectionPosition: "1",
                  operationIds: ["op"],
                } as unknown as ApplicationOutput,
              );
            }
            controller.enqueue(output);
            if (!first) {
              controller.enqueue(
                {
                  type: "operation.completed",
                  operationId: "op",
                } as unknown as ApplicationOutput,
              );
              controller.close();
            }
          },
        }),
        done: Promise.resolve(),
        cancel() {
          detached();
          return Promise.resolve();
        },
      };
      return Promise.resolve(applicationOutputsMultipartResponse(source));
    }) as typeof fetch,
  });
  const received: number[] = [];
  const observing = client.operations.observe({
    operationIds: ["op"],
    async onFrame(frame) {
      if (frame.kind === "stream-chunk") {
        received.push(...frame.bytes);
        if (calls === 1) {
          handlerStarted();
          await blockedHandler;
        }
      }
    },
  });
  await handlerStartedPromise;
  firstOutputs.error(
    Object.assign(new Error("slow observer queue full"), {
      code: "observation_renewal_required",
    }),
  );
  await detachedPromise;
  assertEquals(payloadCancelled, true);
  assertEquals(calls, 1);
  releaseHandler();
  const terminalCheckpoint = await observing;
  assertEquals(calls, 2);
  assertEquals(
    decodeOperationReplayCursor(requested[1]).operationStreamPositions?.op
      .offsets["1"],
    3,
  );
  assertEquals(received, [...bytes]);
  assertEquals(decodeOperationReplayCursor(terminalCheckpoint), {
    selectionPosition: "1",
  });
});

Deno.test("transport queue overflow detaches blocked readers and automatically reconnects every lane", async () => {
  const { createCopilotzClient } = await import("../client/index.ts");
  const count = 16;
  const length = 256 * 1024;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => release = resolve);
  let detached!: () => void;
  const detachedPromise = new Promise<void>((resolve) => detached = resolve);
  let calls = 0;
  let cancelledReaders = 0;
  const totals = Array<number>(count).fill(0);
  const client = createCopilotzClient({
    baseUrl: "/api",
    fetch: ((_url, init) => {
      const first = calls++ === 0;
      const checkpoint = JSON.parse(String(init?.body)).checkpoint as
        | string
        | undefined;
      const replay = decodeOperationReplayCursor(checkpoint);
      const outputs = new ReadableStream<ApplicationOutput>({
        start(controller) {
          for (let index = 0; index < count; index++) {
            const offset =
              replay.operationStreamPositions?.op.offsets[String(index + 1)] ??
                0;
            let emitted = false;
            controller.enqueue({
              type: "stream.output",
              namespace: "tenant",
              streamId: `lane-${index}`,
              streamOrdinal: String(index + 1),
              mediaType: "application/octet-stream",
              kind: "file",
              role: "content",
              metadata: {},
              payload: new ReadableStream<Uint8Array>({
                async pull(body) {
                  if (emitted) {
                    if (!first) body.close();
                    return;
                  }
                  emitted = true;
                  if (first) await gate;
                  try {
                    body.enqueue(
                      new Uint8Array(length - offset).fill(index + 1),
                    );
                  } catch {
                    /* The renewal has already detached this reader. */
                  }
                  if (!first) {
                    body.close();
                  }
                },
                cancel() {
                  cancelledReaders++;
                },
              }),
              terminal: completedTerminal(length),
            } as StreamOutput);
          }
          controller.close();
        },
      });
      return Promise.resolve(
        applicationOutputsMultipartResponse({
          type: HTTP_OBSERVATION,
          operationId: "op",
          replayCursor: checkpoint,
          outputs,
          done: Promise.resolve(),
          cancel() {
            detached();
            return Promise.resolve();
          },
        }),
      );
    }) as typeof fetch,
  });
  // Build the first response without reading any network bytes, then release
  // all lane producers together to exercise the serialized-frame budget.
  const firstResponse = await client.http.request("/test", {
    method: "POST",
    body: "{}",
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  release();
  await detachedPromise;
  assertEquals(cancelledReaders, count);
  let firstUsed = false;
  const reconnecting = createCopilotzClient({
    baseUrl: "/api",
    fetch: (async (url, init) => {
      if (!firstUsed) {
        firstUsed = true;
        return firstResponse;
      }
      return await client.http.request(String(url).replace("/api", ""), init);
    }) as typeof fetch,
  });
  await reconnecting.operations.observe({
    operationIds: ["op"],
    onFrame(frame) {
      if (frame.kind === "stream-chunk") {
        const index = Number(frame.streamId.slice(5));
        assertEquals(frame.bytes.every((value) => value === index + 1), true);
        totals[index] += frame.bytes.length;
      }
    },
  });
  assertEquals(calls, 2);
  assertEquals(totals, Array<number>(count).fill(length));
});

Deno.test("terminal frames keep a bounded tombstone until discovery covers the final selection revision", async () => {
  const outputs = [
    {
      type: "observation.selection",
      selectionPosition: "1",
      operationIds: ["op"],
    },
    {
      type: "operation.completed",
      operationId: "op",
      durable: true,
      position: "999",
      replayPosition: "2",
      finalSelectionPosition: "5",
    },
    { type: "observation.selection", selectionPosition: "5", operationIds: [] },
  ] as unknown as ApplicationOutput[];
  const frames = await Array.fromAsync(
    decodeObservation(
      applicationOutputsMultipartResponse({
        type: HTTP_OBSERVATION,
        compositeCursor: true,
        outputs: new ReadableStream({
          start(controller) {
            outputs.forEach((value) => controller.enqueue(value));
            controller.close();
          },
        }),
        done: Promise.resolve(),
        cancel: () => Promise.resolve(),
      }),
    ),
  );
  assertEquals(decodeOperationReplayCursor(frames[1].checkpoint), {
    selectionPosition: "1",
    operationRetirementPositions: { op: "5" },
  });
  assertEquals(
    frames[1].kind === "output" && frames[1].output.finalSelectionPosition,
    undefined,
  );
  assertEquals(
    frames[1].kind === "output" && frames[1].output.replayPosition,
    undefined,
  );
  assertEquals(decodeOperationReplayCursor(frames[2].checkpoint), {
    selectionPosition: "5",
  });
});

Deno.test("bounded observation lifetime detaches server readers before a blocked response drains and resumes", async () => {
  const { createCopilotzClient } = await import("../client/index.ts");
  const bytes = new Uint8Array(1024 * 1024).fill(7);
  let detached!: () => void;
  const detachedPromise = new Promise<void>((resolve) => detached = resolve);
  let payloadCancelled = false;
  let outputController!: ReadableStreamDefaultController<ApplicationOutput>;
  const first = applicationOutputsMultipartResponse({
    type: HTTP_OBSERVATION,
    operationId: "op",
    done: Promise.resolve(),
    outputs: new ReadableStream({
      start(controller) {
        outputController = controller;
        controller.enqueue(
          {
            type: "stream.output",
            namespace: "tenant",
            streamId: "lane",
            streamOrdinal: "1",
            mediaType: "application/octet-stream",
            kind: "file",
            role: "content",
            metadata: {},
            payload: new ReadableStream<Uint8Array>({
              start(body) {
                body.enqueue(bytes);
              },
              cancel() {
                payloadCancelled = true;
              },
            }),
            terminal: completedTerminal(bytes.length),
          } as StreamOutput,
        );
      },
    }),
    cancel() {
      outputController.close();
      detached();
      return Promise.resolve();
    },
  }, { renewAfterMs: 10 });
  // The 1 MiB chunk blocks the 256 KiB response queue. Expiry must cancel
  // server resources without waiting for the network consumer to read it.
  await detachedPromise;
  assertEquals(payloadCancelled, true);
  let calls = 0;
  const checkpoints: (string | undefined)[] = [];
  const client = createCopilotzClient({
    baseUrl: "/api",
    fetch: ((_url, init) => {
      const checkpoint = JSON.parse(String(init?.body)).checkpoint as
        | string
        | undefined;
      checkpoints.push(checkpoint);
      if (calls++ === 0) return Promise.resolve(first);
      const offset =
        decodeOperationReplayCursor(checkpoint).operationStreamPositions?.op
          .offsets["1"] ?? 0;
      return Promise.resolve(applicationOutputsMultipartResponse({
        type: HTTP_OBSERVATION,
        operationId: "op",
        replayCursor: checkpoint,
        done: Promise.resolve(),
        cancel: () => Promise.resolve(),
        outputs: new ReadableStream({
          start(controller) {
            controller.enqueue(
              {
                type: "stream.output",
                namespace: "tenant",
                streamId: "lane",
                streamOrdinal: "1",
                mediaType: "application/octet-stream",
                kind: "file",
                role: "content",
                metadata: {},
                payload: new ReadableStream({
                  start(body) {
                    if (offset < bytes.length) {
                      body.enqueue(bytes.subarray(offset));
                    }
                    body.close();
                  },
                }),
                terminal: completedTerminal(bytes.length),
              } as StreamOutput,
            );
            controller.close();
          },
        }),
      }));
    }) as typeof fetch,
  });
  let received = 0;
  await client.operations.observe({
    operationIds: ["op"],
    onFrame(frame) {
      if (frame.kind === "stream-chunk") received += frame.bytes.length;
    },
  });
  assertEquals(calls, 2);
  assertEquals(received, bytes.length);
  assertEquals(
    decodeOperationReplayCursor(checkpoints[1]).operationStreamPositions?.op
      .offsets["1"],
    bytes.length,
  );
});

Deno.test("observation lifetime overrides can only shorten the five-minute ceiling", () => {
  const source: HttpObservation = {
    type: HTTP_OBSERVATION,
    outputs: new ReadableStream(),
    done: Promise.resolve(),
    cancel: () => Promise.resolve(),
  };
  for (const renewAfterMs of [0, -1, 300001, Number.POSITIVE_INFINITY, 1.5]) {
    assertThrows(
      () => applicationOutputsMultipartResponse(source, { renewAfterMs }),
      RangeError,
      "renewAfterMs",
    );
  }
});

Deno.test("lifetime renewal interrupts pending lane terminals and source completion", async () => {
  for (const lane of [false, true]) {
    let detached = false;
    const source: HttpObservation = {
      type: HTTP_OBSERVATION,
      operationId: "op",
      done: new Promise<void>(() => {}),
      cancel() {
        detached = true;
        return Promise.resolve();
      },
      outputs: new ReadableStream({
        start(controller) {
          if (lane) {
            controller.enqueue(
              {
                type: "stream.output",
                namespace: "tenant",
                streamId: "lane",
                streamOrdinal: "1",
                mediaType: "text/plain",
                kind: "text",
                role: "content",
                metadata: {},
                payload: new ReadableStream({
                  start(body) {
                    body.close();
                  },
                }),
                terminal: new Promise(() => {}),
              } as StreamOutput,
            );
          }
          controller.close();
        },
      }),
    };
    const frames: string[] = [];
    await assertRejects(async () => {
      for await (
        const frame of decodeObservation(
          applicationOutputsMultipartResponse(source, { renewAfterMs: 10 }),
        )
      ) {
        frames.push(frame.kind);
        if (frame.kind === "observation-renew") {
          assertEquals(frame.reason, "lifetime");
        }
      }
    }, RenewalObservationError);
    assertEquals(detached, true);
    assertEquals(
      frames,
      lane ? ["output", "observation-renew"] : ["observation-renew"],
    );
  }
});
