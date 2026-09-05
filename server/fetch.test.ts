import { decodeObservation } from "../client/protocol.ts";
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
  HTTP_OBSERVATION,
  type HttpApplication,
  type HttpObservation,
  type HttpRequest,
} from "./http-types.ts";
import { createHttpFetchHandler } from "./fetch.ts";

function completedTerminal(offset: number) {
  return Promise.resolve(Object.freeze({
    outcome: "completed" as const,
    availability: "retained" as const,
    capture: "complete" as const,
    offset,
    terminalAt: "2026-09-01T12:00:00.000Z",
  }));
}

Deno.test("Fetch adapter maps routes, repeated queries, JSON, bytes, and context", async () => {
  const observed: HttpRequest[] = [];
  const app: HttpApplication = Object.freeze({
    handle(request) {
      observed.push(request);
      return Promise.resolve({ status: 201, data: { accepted: true } });
    },
  });
  const handle = createHttpFetchHandler(app, {
    basePath: "/api/",
    resolveContext: () => ({ namespace: "tenant-a" }),
    responseHeaders: { "x-contract": "true" },
  });
  const response = await handle(
    new Request(
      "https://example.test/api/widgets/echo/ping?tag=a&tag=b&limit=2",
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
  const app: HttpApplication = Object.freeze({
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
  const handle = createHttpFetchHandler(app);
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
  const app: HttpApplication = Object.freeze({
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
  const response = await createHttpFetchHandler(app)(
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

Deno.test("Fetch adapter preserves application response headers for JSON, empty, and multipart responses", async () => {
  let mode: "json" | "empty" | "multipart" = "json";
  const stream: HttpObservation = Object.freeze({
    type: HTTP_OBSERVATION,
    outputs: new ReadableStream<ApplicationOutput>({
      start(controller) {
        controller.close();
      },
    }),
    done: Promise.resolve(),
    cancel: () => Promise.resolve(),
  });
  const app: HttpApplication = Object.freeze({
    handle() {
      return Promise.resolve({
        status: mode === "empty" ? 204 : 200,
        headers: [
          ["set-cookie", "session=application; Path=/; HttpOnly"],
          ["set-cookie", "tenant=acme; Path=/; Secure"],
          ["x-application", mode],
          ["x-shared", "application"],
        ],
        ...(mode === "multipart"
          ? { data: stream }
          : mode === "json"
          ? { data: { ok: true } }
          : {}),
      });
    },
  });
  const handle = createHttpFetchHandler(app, {
    responseHeaders: { "x-shared": "default" },
  });
  for (const candidate of ["json", "empty", "multipart"] as const) {
    mode = candidate;
    const response = await handle(new Request("https://example.test/test"));
    assertEquals(response.headers.get("x-application"), candidate);
    assertEquals(response.headers.get("x-shared"), "application");
    await response.text();
    assertEquals(response.headers.getSetCookie(), [
      "session=application; Path=/; HttpOnly",
      "tenant=acme; Path=/; Secure",
    ]);
  }
});

Deno.test("Fetch adapter is runtime-neutral and factory-first", async () => {
  const source = await Deno.readTextFile(new URL("fetch.ts", import.meta.url));
  assert(!/\bDeno\./.test(source));
  assert(!/from\s+["']node:/.test(source));
  assert(!/^\s*(?:export\s+)?class\s/m.test(source));
});

Deno.test("Fetch adapter drains progressive streams before exposing an operation terminal frame", async () => {
  let release!: () => void;
  const released = new Promise<void>((resolve) => release = resolve);
  const media: StreamOutput = Object.freeze({
    type: "stream.output",
    namespace: "tenant-a",
    streamId: "answer-a",
    streamOrdinal: "1",
    mediaType: "text/plain",
    kind: "text",
    role: "assistant",
    operationId: "operation-a",
    metadata: Object.freeze({}),
    terminal: completedTerminal(4),
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
  const stream: HttpObservation = Object.freeze({
    type: HTTP_OBSERVATION,
    operationId: "operation-a",
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
  const app: HttpApplication = Object.freeze({
    handle: () => Promise.resolve({ status: 200, data: stream }),
  });
  const response = await createHttpFetchHandler(app)(
    new Request("https://example.test/channels/web", { method: "POST" }),
  );
  setTimeout(release, 25);

  const frames = await Array.fromAsync(decodeObservation(response));
  assertEquals(
    frames.map((frame) =>
      frame.kind === "output" ? frame.output.type : frame.kind
    ),
    [
      "stream.output",
      "stream-chunk",
      "stream-end",
      "operation.completed",
    ],
  );
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
  const stream: HttpObservation = Object.freeze({
    type: HTTP_OBSERVATION,
    compositeCursor: true,
    replayCursor: encodeOperationReplayCursor({
      eventPosition: "50",
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
  const app: HttpApplication = Object.freeze({
    handle: () => Promise.resolve({ status: 200, data: stream }),
  });
  const response = await createHttpFetchHandler(app)(
    new Request("https://example.test/threads/thread-a/feed"),
  );
  const frames = await Array.fromAsync(decodeObservation(response));
  const first = decodeOperationReplayCursor(frames[0].checkpoint);
  const disconnected = decodeOperationReplayCursor(frames[1].checkpoint);
  assertEquals(first, {
    eventPosition: "50",
    operationEventPositions: { "operation-a": "100" },
  });
  assertEquals(disconnected, {
    eventPosition: "50",
    operationEventPositions: {
      "operation-a": "100",
      "operation-b": "99",
    },
  });
});

Deno.test("direct operation multipart advances global and operation event positions together", async () => {
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
  const stream: HttpObservation = Object.freeze({
    type: HTTP_OBSERVATION,
    operationId,
    replayCursor: encodeOperationReplayCursor({
      eventPosition: "1",
      operationEventPositions: { [operationId]: "1" },
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
  const app: HttpApplication = Object.freeze({
    handle: () => Promise.resolve({ status: 200, data: stream }),
  });
  const response = await createHttpFetchHandler(app)(
    new Request(
      "https://example.test/operations/operation-direct-resume/outputs",
    ),
  );
  const cursor = decodeOperationReplayCursor(
    (await Array.fromAsync(decodeObservation(response)))[0].checkpoint,
  );
  assertEquals(cursor.eventPosition, "2");
  assertEquals(cursor.operationEventPositions?.[operationId], "2");
});
