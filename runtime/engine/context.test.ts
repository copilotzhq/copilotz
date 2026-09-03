import { assertEquals, assertExists, assertRejects } from "@std/assert";
import { createEphemeralEvent } from "../events/index.ts";
import { createMemoryBodyStore } from "../content/index.ts";
import { createPluginRegistry } from "../plugins/index.ts";
import type { StreamOutput } from "../streams/index.ts";
import type { CreateProcessorContextOptions } from "./types.ts";
import { createProcessorContext } from "./context.ts";

Deno.test("scoped streams without an operation require a local authority", async () => {
  const bodyStore = createMemoryBodyStore();
  let published = 0;
  const event = createEphemeralEvent({
    type: "test.context.missing-operation",
    namespace: "tenant-a",
    correlationId: "correlation-a",
    payload: {},
  });
  const context = createProcessorContext({
    base: {
      databaseSchema: "public",
      event,
      signal: new AbortController().signal,
      settlementScopeId: "missing-operation",
      idempotencyKey: "processor-run-a",
      createMutationIdentity: () => ({
        deduplicationId: "mutation-a",
        correlationId: "correlation-a",
      }),
    },
    registry: createPluginRegistry(),
    streamBodyStore: bodyStore,
    streamBodyPrefix: "",
    operationCatalog: {
      get: () => Promise.resolve(null),
    },
    collections: {
      withScope: () => ({}),
    },
    publishOutput() {
      published += 1;
      return Promise.resolve();
    },
    assets: {},
    preparer: {},
    resolver: {},
    eventHub: {},
    actionLifecycle: {},
  } as unknown as CreateProcessorContextOptions);

  await assertRejects(
    () =>
      context.streams.open({
        id: "unowned-stream",
        mediaType: "text/plain",
        role: "assistant",
      }),
    Error,
    "require a local output authority",
  );
  assertEquals(published, 0);
  assertEquals(
    await bodyStore.head({
      bodyId: "content-streams/tenant-a/unowned-stream",
    }),
    null,
  );
});

Deno.test("Processor/unscoped streams do not invent Action provenance", async () => {
  const bodyStore = createMemoryBodyStore();
  let published: StreamOutput | undefined;
  const context = createProcessorContext({
    base: {
      databaseSchema: "public",
      event: createEphemeralEvent({
        type: "test.context.local-completed",
        namespace: "tenant-a",
        correlationId: "correlation-a",
        payload: {},
      }),
      signal: new AbortController().signal,
      idempotencyKey: "processor-run-a",
      createMutationIdentity: () => ({
        deduplicationId: "mutation-a",
        correlationId: "correlation-a",
      }),
    },
    registry: createPluginRegistry(),
    streamBodyStore: bodyStore,
    streamBodyPrefix: "",
    operationCatalog: {},
    collections: { withScope: () => ({}) },
    publishLocalStream(output: StreamOutput) {
      published = output;
      return Promise.resolve();
    },
    assets: {},
    preparer: {},
    resolver: {},
    eventHub: {},
    actionLifecycle: {},
    now: () => new Date("2026-09-01T12:00:00.000Z"),
  } as unknown as CreateProcessorContextOptions);

  const writer = await context.streams.open({
    id: "local-completed",
    mediaType: "text/plain",
    role: "assistant",
  });
  const stream = published;
  assertExists(stream);
  assertEquals(Object.hasOwn(stream.metadata, "sourceActionRunId"), false);
  await writer.append({
    appendId: "local-completed:1",
    bytes: new TextEncoder().encode("done"),
  });
  await writer.close({ assetId: "asset-local-completed" });

  assertEquals(await new Response(stream.payload).text(), "done");
  assertEquals(await stream.terminal, {
    outcome: "completed",
    availability: "retained",
    capture: "complete",
    offset: 4,
    terminalAt: "2026-09-01T12:00:00.000Z",
  });
});

Deno.test("unscoped streams publish an exact local failed prefix", async () => {
  const bodyStore = createMemoryBodyStore();
  let published: StreamOutput | undefined;
  const context = createProcessorContext({
    base: {
      databaseSchema: "public",
      event: createEphemeralEvent({
        type: "test.context.local-failed",
        namespace: "tenant-a",
        correlationId: "correlation-a",
        payload: {},
      }),
      signal: new AbortController().signal,
      idempotencyKey: "processor-run-a",
      createMutationIdentity: () => ({
        deduplicationId: "mutation-a",
        correlationId: "correlation-a",
      }),
    },
    registry: createPluginRegistry(),
    streamBodyStore: bodyStore,
    streamBodyPrefix: "",
    operationCatalog: {},
    collections: { withScope: () => ({}) },
    publishLocalStream(output: StreamOutput) {
      published = output;
      return Promise.resolve();
    },
    assets: {},
    preparer: {},
    resolver: {},
    eventHub: {},
    actionLifecycle: {},
    now: () => new Date("2026-09-01T12:01:00.000Z"),
  } as unknown as CreateProcessorContextOptions);

  const writer = await context.streams.open({
    id: "local-failed",
    mediaType: "text/plain",
    role: "assistant",
  });
  const stream = published;
  assertExists(stream);
  await writer.append({
    appendId: "local-failed:1",
    bytes: new TextEncoder().encode("partial"),
  });
  await writer.abort({ outcome: "failed", capture: "truncated" });

  assertEquals(await new Response(stream.payload).text(), "partial");
  assertEquals(await stream.terminal, {
    outcome: "failed",
    availability: "retained",
    capture: "truncated",
    offset: 7,
    terminalAt: "2026-09-01T12:01:00.000Z",
  });
});

Deno.test("unscoped streams reject publication without a local authority", async () => {
  const bodyStore = createMemoryBodyStore();
  const context = createProcessorContext({
    base: {
      databaseSchema: "public",
      event: createEphemeralEvent({
        type: "test.context.local-without-authority",
        namespace: "tenant-a",
        correlationId: "correlation-a",
        payload: {},
      }),
      signal: new AbortController().signal,
      idempotencyKey: "processor-run-a",
      createMutationIdentity: () => ({
        deduplicationId: "mutation-a",
        correlationId: "correlation-a",
      }),
    },
    registry: createPluginRegistry(),
    streamBodyStore: bodyStore,
    streamBodyPrefix: "",
    operationCatalog: {},
    collections: { withScope: () => ({}) },
    assets: {},
    preparer: {},
    resolver: {},
    eventHub: {},
    actionLifecycle: {},
  } as unknown as CreateProcessorContextOptions);

  await assertRejects(
    () =>
      context.streams.open({
        id: "local-without-authority",
        mediaType: "text/plain",
        role: "assistant",
      }),
    Error,
    "require a local output authority",
  );
  assertEquals(
    await bodyStore.head({
      bodyId: "content-streams/tenant-a/local-without-authority",
    }),
    null,
  );
});

Deno.test("unscoped observed publication rejection retains an exact terminal", async () => {
  const bodyStore = createMemoryBodyStore();
  let published: StreamOutput | undefined;
  const context = createProcessorContext({
    base: {
      databaseSchema: "public",
      event: createEphemeralEvent({
        type: "test.context.local-publication-rejection",
        namespace: "tenant-a",
        correlationId: "correlation-a",
        payload: {},
      }),
      signal: new AbortController().signal,
      idempotencyKey: "processor-run-a",
      createMutationIdentity: () => ({
        deduplicationId: "mutation-a",
        correlationId: "correlation-a",
      }),
    },
    registry: createPluginRegistry(),
    streamBodyStore: bodyStore,
    streamBodyPrefix: "",
    operationCatalog: {},
    collections: { withScope: () => ({}) },
    publishLocalStream(output: StreamOutput) {
      published = output;
      return Promise.reject(new Error("local publication relay failed"));
    },
    assets: {},
    preparer: {},
    resolver: {},
    eventHub: {},
    actionLifecycle: {},
    now: () => new Date("2026-09-01T12:02:00.000Z"),
  } as unknown as CreateProcessorContextOptions);

  await assertRejects(
    () =>
      context.streams.open({
        id: "local-publication-rejection",
        mediaType: "text/plain",
        role: "assistant",
      }),
    Error,
    "local publication relay failed",
  );

  assertExists(published);
  assertEquals(await new Response(published.payload).text(), "");
  assertEquals(await published.terminal, {
    outcome: "abandoned",
    availability: "retained",
    capture: "truncated",
    offset: 0,
    terminalAt: "2026-09-01T12:02:00.000Z",
  });
  assertEquals(
    (await bodyStore.head({
      bodyId: "content-streams/tenant-a/local-publication-rejection",
    }))?.state,
    "incomplete",
  );
});
