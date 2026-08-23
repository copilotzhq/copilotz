import { assertEquals, assertRejects } from "@std/assert";
import { createActionLifecycleEmitter } from "./lifecycle.ts";
import type { ActionLifecycleAppendInput } from "./types.ts";

Deno.test("Action progress is durable, ordered, and self-contained", async () => {
  const appended: ActionLifecycleAppendInput[] = [];
  const lifecycle = createActionLifecycleEmitter({
    namespace: "tenant-actions",
    metadata: { source: "test" },
    append(input) {
      appended.push(input);
      return Promise.resolve(undefined as never);
    },
  });

  await lifecycle.emit({
    actionRunId: "run-1",
    actionId: "search.query",
    metadata: { traceId: "trace-1" },
    status: "progress",
    progressIndex: 2,
    input: { query: "hello" },
    progress: { matches: 3 },
    correlationId: "correlation-1",
    deduplicationId: "run-1:action:progress:2",
  });

  assertEquals(appended.length, 1);
  assertEquals(appended[0].draft, {
    type: "search.query.progress",
    namespace: "tenant-actions",
    subject: { type: "search.query", id: "run-1" },
    metadata: {
      source: "test",
      actionId: "search.query",
      actionStatus: "progress",
    },
    correlationId: "correlation-1",
    deduplicationId: "run-1:action:progress:2",
  });
  assertEquals(appended[0].data, {
    actionRunId: "run-1",
    actionId: "search.query",
    metadata: { traceId: "trace-1" },
    status: "progress",
    progressIndex: 2,
    input: { query: "hello" },
    progress: { matches: 3 },
  });
});

Deno.test("Action progress requires a positive safe sequence", async () => {
  const lifecycle = createActionLifecycleEmitter({
    namespace: "tenant-actions",
    append: () => Promise.resolve(undefined as never),
  });
  await assertRejects(
    async () => {
      await lifecycle.emit({
        actionRunId: "run-1",
        actionId: "search.query",
        metadata: {},
        status: "progress",
        progressIndex: 0,
        input: {},
        progress: {},
        deduplicationId: "run-1:action:progress:0",
      });
    },
    TypeError,
    "positive safe integer",
  );
});

Deno.test("Action terminal lookup uses one status-independent identity", async () => {
  const loads: string[] = [];
  const lifecycle = createActionLifecycleEmitter({
    namespace: "tenant-actions",
    append: () => Promise.resolve(undefined as never),
    load(_namespace, deduplicationId) {
      loads.push(deduplicationId);
      return Promise.resolve({
        actionRunId: "run-1",
        actionId: "search.query",
        metadata: {},
        status: "completed" as const,
        input: { query: "hello" },
        output: { matches: 3 },
      });
    },
  });

  assertEquals(await lifecycle.terminal("run-1"), {
    actionRunId: "run-1",
    actionId: "search.query",
    metadata: {},
    status: "completed",
    input: { query: "hello" },
    output: { matches: 3 },
  });
  assertEquals(loads, ["run-1:action:terminal"]);
});

Deno.test("Action invoked lookup uses its narrow durable receipt identity", async () => {
  const loads: string[] = [];
  const lifecycle = createActionLifecycleEmitter({
    namespace: "tenant-actions",
    append: () => Promise.resolve(undefined as never),
    load(_namespace, deduplicationId) {
      loads.push(deduplicationId);
      return Promise.resolve({
        actionRunId: "run-1",
        actionId: "search.query",
        metadata: { requestId: "request-1" },
        status: "invoked" as const,
        input: { query: "hello" },
      });
    },
  });

  assertEquals(await lifecycle.invoked("run-1"), {
    actionRunId: "run-1",
    actionId: "search.query",
    metadata: { requestId: "request-1" },
    status: "invoked",
    input: { query: "hello" },
  });
  assertEquals(loads, ["run-1:action:invoked"]);
});
