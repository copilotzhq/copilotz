import { assert, assertEquals } from "@std/assert";

import type {
  AttachmentOutput,
  AttachmentStreamOutput,
} from "../runtime/attachments/index.ts";
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
      "https://example.test/v2/features/echo/ping?tag=a&tag=b&limit=2",
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
  assertEquals(observed[0].resource, "features");
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
  const streamed = await handle(new Request("https://example.test/features"));
  assertEquals(await streamed.text(), "stream");
  assertEquals(streamed.headers.get("content-type"), "text/plain");
});

Deno.test("Fetch adapter is runtime-neutral and factory-first", async () => {
  const source = await Deno.readTextFile(new URL("fetch.ts", import.meta.url));
  assert(!/\bDeno\./.test(source));
  assert(!/from\s+["']node:/.test(source));
  assert(!/^\s*(?:export\s+)?class\s/m.test(source));
});

Deno.test("Fetch adapter incrementally projects request-bound outputs as SSE without embedding byte streams", async () => {
  const semantic = createEphemeralEvent({
    type: "text.delta",
    namespace: "tenant-a",
    threadId: "thread-a",
    payload: { text: "Hello" },
    correlationId: "correlation-a",
  });
  const media: AttachmentStreamOutput = Object.freeze({
    type: "stream.output",
    streamId: "audio-a",
    participant: Object.freeze({
      id: "agent-a",
      externalId: "support",
      type: "agent",
      name: "Support",
    }),
    mediaType: "audio/pcm;rate=24000",
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
    outputs: new ReadableStream<AttachmentOutput>({
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
  const frames = (await response.text()).trim().split("\n\n").map((frame) =>
    JSON.parse(frame.slice("data: ".length)) as Record<string, unknown>
  );
  assertEquals(frames[0].type, "text.delta");
  assertEquals(frames[1], {
    type: "stream.output",
    streamId: "audio-a",
    participant: {
      id: "agent-a",
      externalId: "support",
      type: "agent",
      name: "Support",
    },
    mediaType: "audio/pcm;rate=24000",
    correlationId: "correlation-a",
    metadata: { voice: "alloy" },
  });
});

Deno.test("Fetch adapter supports versioned SSE projection and cancels request work", async () => {
  let sourceCancelled = false;
  let workCancelled: string | undefined;
  const stream: EventNativeOutputStream = Object.freeze({
    type: EVENT_NATIVE_OUTPUT_STREAM,
    outputs: new ReadableStream<AttachmentOutput>({
      start(controller) {
        controller.enqueue(createEphemeralEvent({
          type: "text.delta",
          namespace: "tenant-a",
          payload: { text: "Hi" },
          correlationId: "correlation-a",
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
  assertEquals(
    new TextDecoder().decode(frame.value),
    'data: {"type":"TOKEN","token":"Hi"}\n\n',
  );
  await reader.cancel("client_disconnected");
  assertEquals(sourceCancelled, true);
  assertEquals(workCancelled, "client_disconnected");
});
