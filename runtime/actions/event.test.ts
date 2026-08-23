import { assertEquals, assertRejects } from "@std/assert";
import {
  isRegisteredActionLifecycleEventType,
  isReservedActionLifecycleDeduplicationId,
  parseActionLifecycleEvent,
} from "./event.ts";
import { defineAction } from "./define.ts";
import { createActionLifecycleLoader } from "./persistence.ts";

function completedEvent() {
  const namespace = "tenant-actions";
  const deduplicationId = "run-1:action:terminal";
  return {
    durable: true as const,
    type: "search.query.completed",
    namespace,
    subject: { type: "search.query", id: "run-1" },
    payload: {
      dataRef: {
        eventBodyId: `event-body:${namespace}:${deduplicationId}`,
        schemaVersion: 1,
        mediaType: "application/json",
      },
    },
    metadata: {
      sourceDeliveryId: "delivery-1",
      actionId: "search.query",
      actionStatus: "completed",
    },
    deduplicationId,
    data: {
      actionRunId: "run-1",
      actionId: "search.query",
      metadata: { request: { traceId: "trace-1" } },
      status: "completed" as const,
      input: { query: "hello" },
      output: { matches: 3 },
    },
  };
}

Deno.test("Action lifecycle parser accepts one exact durable terminal", () => {
  const event = completedEvent();
  assertEquals(
    parseActionLifecycleEvent(event, {
      actionId: "search.query",
      statuses: ["completed"],
      requireRoot: true,
    }),
    event.data,
  );
});

Deno.test("Action lifecycle parser validates every status-specific body", () => {
  const base = completedEvent();
  const variants = [
    {
      status: "invoked" as const,
      data: {
        actionRunId: "run-1",
        actionId: "search.query",
        metadata: {},
        status: "invoked" as const,
        input: null,
      },
    },
    {
      status: "progress" as const,
      data: {
        actionRunId: "run-1",
        actionId: "search.query",
        metadata: {},
        status: "progress" as const,
        input: null,
        progressIndex: 1,
        progress: null,
      },
    },
    {
      status: "failed" as const,
      data: {
        actionRunId: "run-1",
        actionId: "search.query",
        parentActionRunId: "parent-1",
        metadata: {},
        status: "failed" as const,
        input: null,
        error: { name: "Error", message: "failed" },
      },
    },
    {
      status: "cancelled" as const,
      data: {
        actionRunId: "run-1",
        actionId: "search.query",
        metadata: {},
        status: "cancelled" as const,
        input: null,
        error: { name: "AbortError", message: "cancelled" },
      },
    },
  ];
  for (const variant of variants) {
    const deduplicationId = variant.status === "invoked"
      ? "run-1:action:invoked"
      : variant.status === "progress"
      ? "run-1:action:progress:1"
      : "run-1:action:terminal";
    const event = {
      ...base,
      type: `search.query.${variant.status}`,
      payload: {
        dataRef: {
          eventBodyId: `event-body:${base.namespace}:${deduplicationId}`,
          schemaVersion: 1,
          mediaType: "application/json",
        },
      },
      metadata: {
        ...base.metadata,
        actionStatus: variant.status,
      },
      deduplicationId,
      data: variant.data,
    };
    assertEquals(parseActionLifecycleEvent(event), variant.data);
  }
});

Deno.test("Action lifecycle parser rejects forged or malformed coordinates", () => {
  const base = completedEvent();
  const rejected = [
    { ...base, durable: false },
    { ...base, type: "search.query.failed" },
    { ...base, subject: undefined },
    { ...base, subject: { ...base.subject, id: "run-forged" } },
    { ...base, subject: { ...base.subject, extra: true } },
    { ...base, payload: base.data },
    {
      ...base,
      payload: {
        dataRef: {
          ...base.payload.dataRef,
          eventBodyId: "event-body:tenant-actions:forged",
        },
      },
    },
    { ...base, deduplicationId: "run-1:action:invoked" },
    {
      ...base,
      metadata: { ...base.metadata, actionId: "search.other" },
    },
    {
      ...base,
      metadata: { ...base.metadata, actionStatus: "failed" },
    },
    { ...base, data: { ...base.data, actionRunId: "" } },
    { ...base, data: { ...base.data, actionId: " search.query" } },
    { ...base, data: { ...base.data, extra: true } },
    {
      ...base,
      data: {
        actionRunId: "run-1",
        actionId: "search.query",
        metadata: {},
        status: "completed",
        input: null,
      },
    },
    {
      ...base,
      type: "search.query.failed",
      metadata: { ...base.metadata, actionStatus: "failed" },
      data: {
        actionRunId: "run-1",
        actionId: "search.query",
        metadata: {},
        status: "failed",
        input: null,
        error: { name: "Error", message: "failed", stack: "private" },
      },
    },
  ];
  for (const event of rejected) {
    assertEquals(parseActionLifecycleEvent(event), null);
  }
});

Deno.test("Action lifecycle parser requires strict JSON metadata", () => {
  const base = completedEvent();
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  const accessor = {};
  Object.defineProperty(accessor, "trace", {
    enumerable: true,
    get: () => "forged",
  });
  for (const metadata of [[], new Date(), cyclic, accessor]) {
    assertEquals(
      parseActionLifecycleEvent({
        ...base,
        data: { ...base.data, metadata },
      }),
      null,
    );
  }
});

Deno.test("Action lifecycle parser can require root and exact status semantics", () => {
  const base = completedEvent();
  const nested = {
    ...base,
    data: { ...base.data, parentActionRunId: "parent-1" },
  };
  assertEquals(parseActionLifecycleEvent(nested), nested.data);
  assertEquals(
    parseActionLifecycleEvent(nested, { requireRoot: true }),
    null,
  );
  assertEquals(
    parseActionLifecycleEvent(base, { statuses: ["failed", "cancelled"] }),
    null,
  );
  assertEquals(
    parseActionLifecycleEvent(base, { actionId: "search.other" }),
    null,
  );
});

Deno.test("registered Action lifecycle event types are exactly reserved", () => {
  const actions = {
    search: defineAction({ id: "search.query", execute: () => null }),
  };
  assertEquals(
    isRegisteredActionLifecycleEventType("search.query.completed", actions),
    true,
  );
  assertEquals(
    isRegisteredActionLifecycleEventType(" search.query.failed ", actions),
    true,
  );
  assertEquals(
    isRegisteredActionLifecycleEventType("search.query.requested", actions),
    false,
  );
  assertEquals(
    isRegisteredActionLifecycleEventType("other.completed", actions),
    false,
  );
});

Deno.test("Action lifecycle receipt deduplication identities are reserved", () => {
  for (
    const id of [
      "run-1:action:invoked",
      "run-1:action:terminal",
      "run-1:action:progress:1",
      "nested:run:action:progress:42",
    ]
  ) assertEquals(isReservedActionLifecycleDeduplicationId(id), true);
  for (
    const id of [
      undefined,
      "",
      "action:terminal",
      "run-1:action:progress:0",
      "run-1:action:progress:-1",
      "run-1:action:completed",
      "run-1:terminal",
    ]
  ) assertEquals(isReservedActionLifecycleDeduplicationId(id), false);
});

Deno.test("Action receipt loading rejects public inline dedup poisoning", async () => {
  const lifecycle = completedEvent().data;
  const loader = createActionLifecycleLoader({
    store: {
      session: {} as never,
      tables: {} as never,
      getEventByDeduplicationId() {
        return Promise.resolve({
          durable: true as const,
          id: "event-poison",
          position: "1",
          schemaVersion: 1,
          type: "search.query.completed",
          namespace: "tenant-actions",
          subject: { type: "search.query", id: "run-1" },
          payload: lifecycle,
          routing: {},
          visibility: { kind: "public" as const },
          metadata: {
            actionId: "search.query",
            actionStatus: "completed",
          },
          correlationId: "correlation-poison",
          deduplicationId: "run-1:action:terminal",
          createdAt: "2026-08-23T00:00:00.000Z",
        });
      },
    },
  });
  await assertRejects(
    () => loader("tenant-actions", "run-1:action:terminal"),
    Error,
    "not an authoritative Action lifecycle Event",
  );
});
