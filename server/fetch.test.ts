import { assert, assertEquals } from "@std/assert";

import type {
  ApplicationOutput,
  StreamOutput,
} from "../runtime/streams/index.ts";
import {
  decodeOperationReplayCursor,
  encodeOperationReplayCursor,
} from "../runtime/streams/index.ts";
import { createEphemeralEvent } from "../runtime/events/index.ts";
import {
  EVENT_NATIVE_OUTPUT_STREAM,
  type EventNativeApp,
  type EventNativeAppRequest,
  type EventNativeOutputStream,
} from "./event-native.ts";
import { createEventNativeFetchHandler } from "./fetch.ts";

Deno.test("Fetch adapter maps routes, repeated queries, JSON, bytes, and context", async () => {
  const observed: EventNativeAppRequest[] = [];
  const app: EventNativeApp = Object.freeze({
    resources: () => [],
    handle(request) {
      observed.push(request);
      return Promise.resolve({ status: 201, data: { accepted: true } });
    },
  });
  const handle = createEventNativeFetchHandler(app, {
    basePath: "/v2/",
    resolveContext: () => ({ namespace: "tenant-a" }),
    responseHeaders: { "x-contract": "true" },
  });
  const response = await handle(
    new Request(
      "https://example.test/v2/widgets/echo/ping?tag=a&tag=b&limit=2",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ hello: "world" }),
      },
    ),
  );
  assertEquals(response.status, 201);
  assertEquals(response.headers.get("x-contract"), "true");
  assertEquals(await response.json(), { data: { accepted: true } });
  assertEquals(observed[0].resource, "widgets");
  assertEquals(observed[0].path, ["echo", "ping"]);
  assertEquals(observed[0].query, { tag: ["a", "b"], limit: "2" });
  assertEquals(observed[0].body, { hello: "world" });
  assertEquals(observed[0].context?.namespace, "tenant-a");
  assert(observed[0].context?.rawBody instanceof Uint8Array);
});

Deno.test("Fetch adapter returns bounded HTTP errors and preserves native Responses", async () => {
  let native = false;
  const app: EventNativeApp = Object.freeze({
    resources: () => [],
    handle() {
      if (native) {
        return Promise.resolve({
          status: 200,
          data: new Response("stream", {
            headers: { "content-type": "text/plain" },
          }),
        });
      }
      throw Object.assign(new Error("Missing contract route."), {
        status: 404,
        code: "missing_contract",
      });
    },
  });
  const handle = createEventNativeFetchHandler(app);
  const missing = await handle(
    new Request("https://example.test/threads/missing"),
  );
  assertEquals(missing.status, 404);
  assertEquals(await missing.json(), {
    error: { code: "missing_contract", message: "Missing contract route." },
  });
  const invalid = await handle(
    new Request("https://example.test/threads", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    }),
  );
  assertEquals(invalid.status, 400);
  assertEquals((await invalid.json()).error.code, "invalid_json");
  native = true;
  const streamed = await handle(new Request("https://example.test/widgets"));
  assertEquals(await streamed.text(), "stream");
  assertEquals(streamed.headers.get("content-type"), "text/plain");
});

Deno.test("Fetch adapter exposes bounded retryable persistence failures as HTTP 503", async () => {
  const app: EventNativeApp = Object.freeze({
    resources: () => [],
    handle() {
      throw Object.assign(
        new Error("Application persistence is temporarily unavailable."),
        {
          status: 503,
          code: "persistence_unavailable",
          retryAfterSeconds: 4,
        },
      );
    },
  });
  const response = await createEventNativeFetchHandler(app)(
    new Request("https://example.test/threads"),
  );
  assertEquals(response.status, 503);
  assertEquals(response.headers.get("retry-after"), "4");
  assertEquals(await response.json(), {
    error: {
      code: "persistence_unavailable",
      message: "Application persistence is temporarily unavailable.",
    },
  });
});

Deno.test("Fetch adapter preserves application response headers for JSON, empty, and SSE responses", async () => {
  let mode: "json" | "empty" | "sse" = "json";
  const stream: EventNativeOutputStream = Object.freeze({
    type: EVENT_NATIVE_OUTPUT_STREAM,
    outputs: new ReadableStream<ApplicationOutput>({
      start(controller) {
        controller.close();
      },
    }),
    done: Promise.resolve(),
    cancel: () => Promise.resolve(),
  });
  const app: EventNativeApp = Object.freeze({
    resources: () => [],
    handle() {
      return Promise.resolve({
        status: mode === "empty" ? 204 : 200,
        headers: [
          ["set-cookie", "session=application; Path=/; HttpOnly"],
          ["set-cookie", "tenant=acme; Path=/; Secure"],
          ["x-application", mode],
          ["x-shared", "application"],
        ],
        ...(mode === "sse"
          ? { data: stream }
          : mode === "json"
          ? { data: { ok: true } }
          : {}),
      });
    },
  });
  const handle = createEventNativeFetchHandler(app, {
    responseHeaders: { "x-shared": "default" },
  });
  for (const candidate of ["json", "empty", "sse"] as const) {
    mode = candidate;
    const response = await handle(new Request("https://example.test/test"));
    assertEquals(response.headers.get("x-application"), candidate);
    assertEquals(response.headers.get("x-shared"), "application");
    assertEquals(response.headers.getSetCookie(), [
      "session=application; Path=/; HttpOnly",
      "tenant=acme; Path=/; Secure",
    ]);
  }
});

function sseData(frame: string): Record<string, unknown> {
  const line = frame.split("\n").find((item) => item.startsWith("data: "));
  if (!line) throw new Error(`SSE frame missing data: ${frame}`);
  return JSON.parse(line.slice("data: ".length)) as Record<string, unknown>;
}

function sseId(frame: string): string | undefined {
  const line = frame.split("\n").find((item) => item.startsWith("id: "));
  return line?.slice("id: ".length);
}

Deno.test("Fetch adapter is runtime-neutral and factory-first", async () => {
  const source = await Deno.readTextFile(new URL("fetch.ts", import.meta.url));
  assert(!/\bDeno\./.test(source));
  assert(!/from\s+["']node:/.test(source));
  assert(!/^\s*(?:export\s+)?class\s/m.test(source));
});

Deno.test("Fetch adapter incrementally projects request-bound outputs as SSE without embedding byte streams", async () => {
  const semantic: ApplicationOutput = Object.freeze({
    ...createEphemeralEvent({
      type: "text.delta",
      namespace: "tenant-a",
      threadId: "thread-a",
      payload: { text: "Hello" },
      correlationId: "correlation-a",
    }),
    data: Object.freeze({ text: "Hello" }),
  });
  const media: StreamOutput = Object.freeze({
    type: "stream.output",
    namespace: "tenant-a",
    streamId: "audio-a",
    replayKey: "17",
    mediaType: "audio/pcm;rate=24000",
    kind: "audio",
    role: "assistant.audio",
    correlationId: "correlation-a",
    metadata: Object.freeze({ voice: "alloy" }),
    payload: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        controller.close();
      },
    }),
  });
  const stream: EventNativeOutputStream = Object.freeze({
    type: EVENT_NATIVE_OUTPUT_STREAM,
    outputs: new ReadableStream<ApplicationOutput>({
      start(controller) {
        controller.enqueue(semantic);
        controller.enqueue(media);
        controller.close();
      },
    }),
    done: Promise.resolve(),
    cancel: () => Promise.resolve(),
  });
  const app: EventNativeApp = Object.freeze({
    resources: () => [],
    handle: () => Promise.resolve({ status: 200, data: stream }),
  });
  const response = await createEventNativeFetchHandler(app)(
    new Request("https://example.test/channels/web", { method: "POST" }),
  );
  assertEquals(
    response.headers.get("content-type"),
    "text/event-stream; charset=utf-8",
  );
  assertEquals(response.headers.get("cache-control"), "no-cache");
  const frames = (await response.text()).trim().split("\n\n");
  assertEquals(sseData(frames[0]).type, "text.delta");
  assertEquals(decodeOperationReplayCursor(sseId(frames[0])), {
    streamOffsets: {},
  });
  assertEquals(sseData(frames[1]), {
    type: "stream.output",
    namespace: "tenant-a",
    streamId: "audio-a",
    mediaType: "audio/pcm;rate=24000",
    kind: "audio",
    role: "assistant.audio",
    correlationId: "correlation-a",
    metadata: { voice: "alloy" },
  });
  assertEquals(decodeOperationReplayCursor(sseId(frames[2])).streamOffsets, {
    r17: 3,
  });
});

Deno.test("Fetch adapter drains progressive streams before exposing an operation terminal frame", async () => {
  let release!: () => void;
  const released = new Promise<void>((resolve) => release = resolve);
  const media: StreamOutput = Object.freeze({
    type: "stream.output",
    namespace: "tenant-a",
    streamId: "answer-a",
    replayKey: "23",
    mediaType: "text/plain",
    kind: "text",
    role: "assistant",
    operationId: "operation-a",
    metadata: Object.freeze({}),
    payload: new ReadableStream<Uint8Array>({
      async pull(controller) {
        await released;
        controller.enqueue(new TextEncoder().encode("done"));
        controller.close();
      },
    }),
  } as StreamOutput);
  const terminal = Object.freeze({
    ...createEphemeralEvent({
      type: "operation.completed",
      namespace: "tenant-a",
      correlationId: "operation-a",
      payload: { status: "completed" },
    }),
    operationId: "operation-a",
    state: "completed",
    data: Object.freeze({ status: "completed" }),
  }) as ApplicationOutput;
  const stream: EventNativeOutputStream = Object.freeze({
    type: EVENT_NATIVE_OUTPUT_STREAM,
    outputs: new ReadableStream<ApplicationOutput>({
      start(controller) {
        controller.enqueue(media);
        controller.enqueue(terminal);
        controller.close();
      },
    }),
    done: Promise.resolve(),
    cancel: () => Promise.resolve(),
  });
  const app: EventNativeApp = Object.freeze({
    resources: () => [],
    handle: () => Promise.resolve({ status: 200, data: stream }),
  });
  const response = await createEventNativeFetchHandler(app)(
    new Request("https://example.test/channels/web", { method: "POST" }),
  );
  setTimeout(release, 25);

  const frames = (await response.text()).trim().split("\n\n");
  assertEquals(frames.map((frame) => sseData(frame).type), [
    "stream.output",
    "stream.chunk",
    "stream.end",
    "operation.completed",
  ]);
});

Deno.test("Fetch adapter supports versioned SSE projection and cancels request work", async () => {
  let sourceCancelled = false;
  let workCancelled: string | undefined;
  const stream: EventNativeOutputStream = Object.freeze({
    type: EVENT_NATIVE_OUTPUT_STREAM,
    outputs: new ReadableStream<ApplicationOutput>({
      start(controller) {
        controller.enqueue(Object.freeze({
          ...createEphemeralEvent({
            type: "text.delta",
            namespace: "tenant-a",
            payload: { text: "Hi" },
            correlationId: "correlation-a",
          }),
          data: Object.freeze({ text: "Hi" }),
        }));
      },
      cancel() {
        sourceCancelled = true;
      },
    }),
    done: new Promise<void>(() => undefined),
    cancel(reason?: string) {
      workCancelled = reason;
      return Promise.resolve();
    },
  });
  const app: EventNativeApp = Object.freeze({
    resources: () => [],
    handle: () => Promise.resolve({ status: 200, data: stream }),
  });
  const handler = createEventNativeFetchHandler(app, {
    projectSseOutput(output) {
      return output.type === "text.delta"
        ? [{ type: "TOKEN", token: (output.payload as { text: string }).text }]
        : null;
    },
  });
  const response = await handler(
    new Request("https://example.test/channels/web", { method: "POST" }),
  );
  const reader = response.body!.getReader();
  const frame = await reader.read();
  const projected = new TextDecoder().decode(frame.value);
  assertEquals(sseData(projected), { type: "TOKEN", token: "Hi" });
  assertEquals(decodeOperationReplayCursor(sseId(projected)), {
    streamOffsets: {},
  });
  await reader.cancel("client_disconnected");
  assertEquals(sourceCancelled, true);
  assertEquals(workCancelled, "client_disconnected");
});

Deno.test("Fetch adapter emits durable event position as SSE id", async () => {
  const durable: ApplicationOutput = Object.freeze({
    durable: true,
    id: "event-uuid",
    position: "42",
    schemaVersion: 1,
    type: "message.created",
    namespace: "tenant-a",
    threadId: "thread-a",
    payload: { ok: true },
    routing: {},
    visibility: { kind: "public" as const },
    metadata: {},
    correlationId: "correlation-a",
    createdAt: "2026-08-19T00:00:00.000Z",
    data: Object.freeze({ ok: true }),
  });
  const stream: EventNativeOutputStream = Object.freeze({
    type: EVENT_NATIVE_OUTPUT_STREAM,
    outputs: new ReadableStream<ApplicationOutput>({
      start(controller) {
        controller.enqueue(durable);
        controller.close();
      },
    }),
    done: Promise.resolve(),
    cancel: () => Promise.resolve(),
  });
  const app: EventNativeApp = Object.freeze({
    resources: () => [],
    handle: () => Promise.resolve({ status: 200, data: stream }),
  });
  const response = await createEventNativeFetchHandler(app)(
    new Request("https://example.test/channels/web", { method: "POST" }),
  );
  const frame = (await response.text()).trim();
  assertEquals(decodeOperationReplayCursor(sseId(frame)), {
    eventPosition: "42",
    streamOffsets: {},
  });
  assertEquals(sseData(frame).id, "event-uuid");
  const source = await Deno.readTextFile(new URL("fetch.ts", import.meta.url));
  assertEquals(source.includes("id: ${resumeId}"), true);
});

Deno.test("SSE cursor commits a durable event only with its final projected frame", async () => {
  let projectionStarted!: () => void;
  const projecting = new Promise<void>((resolve) =>
    projectionStarted = resolve
  );
  const durable: ApplicationOutput = Object.freeze({
    durable: true,
    id: "event-projected",
    position: "42",
    schemaVersion: 1,
    type: "message.created",
    namespace: "tenant-a",
    threadId: "thread-a",
    payload: { ok: true },
    routing: {},
    visibility: { kind: "public" as const },
    metadata: {},
    correlationId: "correlation-a",
    createdAt: "2026-08-19T00:00:00.000Z",
    data: Object.freeze({ ok: true }),
  });
  const media: StreamOutput = Object.freeze({
    type: "stream.output",
    namespace: "tenant-a",
    streamId: "answer-projected",
    replayKey: "31",
    mediaType: "text/plain",
    kind: "text",
    role: "assistant",
    metadata: Object.freeze({}),
    payload: new ReadableStream<Uint8Array>({
      async pull(controller) {
        await projecting;
        controller.enqueue(new TextEncoder().encode("x"));
        controller.close();
      },
    }),
  });
  const outputStream: EventNativeOutputStream = Object.freeze({
    type: EVENT_NATIVE_OUTPUT_STREAM,
    outputs: new ReadableStream<ApplicationOutput>({
      start(controller) {
        controller.enqueue(media);
        controller.enqueue(durable);
        controller.close();
      },
    }),
    done: Promise.resolve(),
    cancel: () => Promise.resolve(),
  });
  const app: EventNativeApp = Object.freeze({
    resources: () => [],
    handle: () => Promise.resolve({ status: 200, data: outputStream }),
  });
  const response = await createEventNativeFetchHandler(app, {
    async projectSseOutput(output) {
      if (output !== durable) {
        const { payload: _payload, replayKey: _replayKey, ...descriptor } =
          output as StreamOutput;
        return descriptor;
      }
      projectionStarted();
      await new Promise((resolve) => setTimeout(resolve, 25));
      return [{ type: "message.part", part: 1 }, {
        type: "message.part",
        part: 2,
      }];
    },
  })(new Request("https://example.test/channels/web", { method: "POST" }));
  const frames = (await response.text()).trim().split("\n\n");
  const byType = (type: string) =>
    frames.filter((frame) => sseData(frame).type === type);

  assertEquals(
    decodeOperationReplayCursor(sseId(byType("stream.chunk")[0]))
      .eventPosition,
    undefined,
  );
  const parts = byType("message.part");
  assertEquals(parts.length, 2);
  assertEquals(
    decodeOperationReplayCursor(sseId(parts[0])).eventPosition,
    undefined,
  );
  assertEquals(
    decodeOperationReplayCursor(sseId(parts[1])).eventPosition,
    "42",
  );
});

Deno.test("SSE cursor never leaks an unencodable concurrent stream offset", async () => {
  const oversizedId = "a".repeat(513);
  let closeOutputs!: () => void;
  const stream = (streamId: string): StreamOutput =>
    Object.freeze({
      type: "stream.output",
      namespace: "tenant-a",
      streamId,
      mediaType: "text/plain",
      kind: "text",
      role: "assistant",
      metadata: Object.freeze({}),
      payload: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([0x78]));
          controller.close();
        },
      }),
    });
  const outputStream: EventNativeOutputStream = Object.freeze({
    type: EVENT_NATIVE_OUTPUT_STREAM,
    outputs: new ReadableStream<ApplicationOutput>({
      start(controller) {
        controller.enqueue(stream(oversizedId));
        controller.enqueue(stream("lane-b"));
        closeOutputs = () => controller.close();
      },
    }),
    done: Promise.resolve(),
    cancel: () => Promise.resolve(),
  });
  const app: EventNativeApp = Object.freeze({
    resources: () => [],
    handle: () => Promise.resolve({ status: 200, data: outputStream }),
  });
  const response = await createEventNativeFetchHandler(app)(
    new Request("https://example.test/channels/web", { method: "POST" }),
  );
  const reader = response.body!.getReader();
  let received = "";
  let frame: string | undefined;
  try {
    while (!frame) {
      const next = await reader.read();
      if (next.done) break;
      received += new TextDecoder().decode(next.value);
      frame = received.split("\n\n").find((candidate) =>
        candidate.includes('"type":"stream.chunk"') &&
        candidate.includes('"streamId":"lane-b"')
      );
    }
    assert(frame);
    assertEquals(decodeOperationReplayCursor(sseId(frame)).streamOffsets, {
      "s:lane-b": 1,
    });
  } finally {
    closeOutputs();
    await reader.cancel().catch(() => undefined);
  }
});

Deno.test("thread feed cursor preserves out-of-order positions independently per operation", async () => {
  const durable = (operationId: string, position: string): ApplicationOutput =>
    Object.freeze({
      durable: true,
      id: `${operationId}:event`,
      position,
      schemaVersion: 1,
      type: "message.created",
      namespace: "tenant-a",
      threadId: "thread-a",
      payload: { operationId },
      routing: {},
      visibility: { kind: "public" as const },
      metadata: {},
      correlationId: `${operationId}:correlation`,
      createdAt: "2026-08-31T00:00:00.000Z",
      data: Object.freeze({ operationId }),
      operationId,
    });
  const stream: EventNativeOutputStream = Object.freeze({
    type: EVENT_NATIVE_OUTPUT_STREAM,
    compositeCursor: true,
    replayCursor: encodeOperationReplayCursor({
      eventPosition: "50",
      streamOffsets: {},
    }),
    outputs: new ReadableStream<ApplicationOutput>({
      start(controller) {
        // Concurrent attachment A wins the transport race even though B owns
        // the earlier global Event position.
        controller.enqueue(durable("operation-a", "100"));
        controller.enqueue(durable("operation-b", "99"));
        controller.close();
      },
    }),
    done: Promise.resolve(),
    cancel: () => Promise.resolve(),
  });
  const app: EventNativeApp = Object.freeze({
    resources: () => [],
    handle: () => Promise.resolve({ status: 200, data: stream }),
  });
  const response = await createEventNativeFetchHandler(app)(
    new Request("https://example.test/threads/thread-a/feed"),
  );
  const frames = (await response.text()).trim().split("\n\n");
  const first = decodeOperationReplayCursor(sseId(frames[0]));
  const disconnected = decodeOperationReplayCursor(sseId(frames[1]));
  assertEquals(first, {
    eventPosition: "50",
    operationEventPositions: { "operation-a": "100" },
    streamOffsets: {},
  });
  assertEquals(disconnected, {
    eventPosition: "50",
    operationEventPositions: {
      "operation-a": "100",
      "operation-b": "99",
    },
    streamOffsets: {},
  });
});

Deno.test("SSE reports concurrent replay capacity in-band and only detaches", async () => {
  const payloads: ReadableStreamDefaultController<Uint8Array>[] = [];
  let detached = false;
  const media = (ordinal: number): StreamOutput =>
    Object.freeze({
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
        start(controller) {
          payloads.push(controller);
        },
      }),
    });
  const stream: EventNativeOutputStream = Object.freeze({
    type: EVENT_NATIVE_OUTPUT_STREAM,
    operationId: "operation-wide",
    outputs: new ReadableStream<ApplicationOutput>({
      start(controller) {
        for (let ordinal = 1; ordinal <= 257; ordinal++) {
          controller.enqueue(media(ordinal));
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
          // A transport pump may already have released this lane.
        }
      }
    },
  });
  const app: EventNativeApp = Object.freeze({
    resources: () => [],
    handle: () => Promise.resolve({ status: 200, data: stream }),
  });
  const response = await createEventNativeFetchHandler(app)(
    new Request("https://example.test/operations/operation-wide/outputs"),
  );
  const frames = (await response.text()).trim().split("\n\n");
  const capacity = frames.find((frame) =>
    sseData(frame).type === "replay.capacity"
  );
  assert(capacity);
  assertEquals(sseData(capacity).code, "operation_replay_capacity_exceeded");
  assertEquals(detached, true);
  assertEquals(
    Object.values(
      decodeOperationReplayCursor(sseId(capacity)).operationStreamPositions?.[
        "operation-wide"
      ]?.offsets ?? {},
    ).length,
    256,
  );
});

Deno.test("SSE closes a fully read sparse lane into the operation high-watermark", async () => {
  const operationId = "operation-resume-end";
  const media: StreamOutput = Object.freeze({
    type: "stream.output",
    namespace: "tenant-a",
    streamId: "lane-one",
    replayKey: "44",
    streamOrdinal: "1",
    mediaType: "text/plain",
    kind: "text",
    role: "assistant",
    metadata: Object.freeze({}),
    payload: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.close();
      },
    }),
  });
  const stream: EventNativeOutputStream = Object.freeze({
    type: EVENT_NATIVE_OUTPUT_STREAM,
    operationId,
    replayCursor: encodeOperationReplayCursor({
      operationStreamPositions: {
        [operationId]: { highWatermark: 0, offsets: { "1": 12 } },
      },
      streamOffsets: {},
    }),
    outputs: new ReadableStream<ApplicationOutput>({
      start(controller) {
        controller.enqueue(media);
        controller.close();
      },
    }),
    done: Promise.resolve(),
    cancel: () => Promise.resolve(),
  });
  const app: EventNativeApp = Object.freeze({
    resources: () => [],
    handle: () => Promise.resolve({ status: 200, data: stream }),
  });
  const response = await createEventNativeFetchHandler(app)(
    new Request("https://example.test/operations/operation-resume-end/outputs"),
  );
  const frames = (await response.text()).trim().split("\n\n");
  const end = frames.find((frame) => sseData(frame).type === "stream.end");
  assert(end);
  assertEquals(
    decodeOperationReplayCursor(sseId(end)).operationStreamPositions?.[
      operationId
    ],
    { highWatermark: 1, offsets: {} },
  );
});

Deno.test("direct operation SSE advances global and operation event positions together", async () => {
  const operationId = "operation-direct-resume";
  const durable: ApplicationOutput = Object.freeze({
    durable: true,
    id: "event-two",
    position: "2",
    schemaVersion: 1,
    type: "message.created",
    namespace: "tenant-a",
    payload: { ok: true },
    routing: {},
    visibility: { kind: "public" as const },
    metadata: {},
    correlationId: operationId,
    createdAt: "2026-08-31T00:00:00.000Z",
    data: Object.freeze({ ok: true }),
  });
  const stream: EventNativeOutputStream = Object.freeze({
    type: EVENT_NATIVE_OUTPUT_STREAM,
    operationId,
    replayCursor: encodeOperationReplayCursor({
      eventPosition: "1",
      operationEventPositions: { [operationId]: "1" },
      streamOffsets: {},
    }),
    outputs: new ReadableStream<ApplicationOutput>({
      start(controller) {
        controller.enqueue(durable);
        controller.close();
      },
    }),
    done: Promise.resolve(),
    cancel: () => Promise.resolve(),
  });
  const app: EventNativeApp = Object.freeze({
    resources: () => [],
    handle: () => Promise.resolve({ status: 200, data: stream }),
  });
  const response = await createEventNativeFetchHandler(app)(
    new Request(
      "https://example.test/operations/operation-direct-resume/outputs",
    ),
  );
  const cursor = decodeOperationReplayCursor(
    sseId((await response.text()).trim()),
  );
  assertEquals(cursor.eventPosition, "2");
  assertEquals(cursor.operationEventPositions?.[operationId], "2");
});
