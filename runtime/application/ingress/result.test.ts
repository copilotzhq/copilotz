import { assertEquals, assertRejects } from "@std/assert";
import { recordedOperationResult } from "./result.ts";
const SERVER_INVOKE_ACTION_ID = "copilotz.server.internal.invoke";
import {
  SERVER_ACTION_REQUEST_EVENT_TYPE,
  SERVER_COLLECTION_MUTATION_REQUEST_EVENT_TYPE,
  serverActionRunId,
} from "./contracts.ts";
import type { InternalCopilotzApplication } from "../types.ts";
import type { ActionEventData } from "../../actions/types.ts";

const namespace = "scope";
const actionId = "fixture.target";
const wrapperRun = "delivery:action:named:wrapper:request";
const targetRun = `${wrapperRun}/action:${actionId}:target`;
const forbidden = {
  name: "ActionError",
  message: "Forbidden",
  code: "forbidden",
  status: 403,
  callerSafe: true,
} as const;
function lifecycle(
  status: "completed" | "failed" | "cancelled",
  target = false,
) {
  const runId = target ? targetRun : wrapperRun;
  const id = target ? actionId : SERVER_INVOKE_ACTION_ID;
  const deduplicationId = `${runId}:action:terminal`;
  return {
    durable: true,
    id: `${target ? "target" : "wrapper"}-terminal`,
    position: target ? "2" : "3",
    seq: target ? "2" : "3",
    schemaVersion: 1,
    createdAt: "2026-10-19T00:00:00Z",
    namespace,
    type: `${id}.${status}`,
    subject: { type: id, id: runId },
    correlationId: "request-correlation",
    causationId: "request-event",
    deduplicationId,
    payload: {
      dataRef: {
        eventBodyId: `event-body:${namespace}:${deduplicationId}`,
        mediaType: "application/json",
        schemaVersion: 1,
      },
    },
    metadata: {
      actionId: id,
      actionStatus: status,
      sourceEventId: "request-event",
    },
    data: {
      actionId: id,
      actionRunId: runId,
      ...(target ? { parentActionRunId: wrapperRun } : {}),
      input: target ? {} : { requestId: "request", actionAlias: "target" },
      metadata: {},
      status,
      ...(status === "completed"
        ? {
          output: target
            ? { protected: "accepted-value" }
            : { status: "completed", targetActionRunId: targetRun },
        }
        : { error: forbidden }),
    },
  };
}
function fixture(events: ReturnType<typeof lifecycle>[]) {
  const request = {
    durable: true,
    id: "request-event",
    position: "1",
    namespace,
    type: SERVER_ACTION_REQUEST_EVENT_TYPE,
    correlationId: "request-correlation",
    data: { requestId: "request", actionAlias: "target" },
  };
  return {
    config: { namespace, databaseSchema: "public" },
    plugins: { actions: { target: { id: actionId } } },
    operationStatus() {
      return Promise.resolve({ state: "completed", namespace });
    },
    deliveries: { list: () => Promise.resolve([]) },
    events: {
      list(options: { metadata: { actionId: string } }) {
        return Promise.resolve(
          events.filter((event) =>
            event.metadata.actionId === options.metadata.actionId
          ),
        );
      },
      resolve(_namespace: string, id: string) {
        return Promise.resolve(
          id === request.id ? request : events.find((event) => event.id === id),
        );
      },
      resolveActionLifecycle(_namespace: string, id: string) {
        return Promise.resolve(
          events.find((event) => event.id === id)?.data as ActionEventData,
        );
      },
    },
    operations: {
      listStreams() {
        return Promise.resolve([]);
      },
    },
  } as unknown as InternalCopilotzApplication;
}
async function failure(events: ReturnType<typeof lifecycle>[]) {
  return await assertRejects(
    () => recordedOperationResult(fixture(events), {}, "request-event"),
    Error,
  );
}
Deno.test("pre-capture root refusal requires exact source identity and an input-free sanitized failure", async () => {
  const create = () => {
    const event = lifecycle("failed", true);
    const runId = serverActionRunId("delivery", actionId, "request");
    event.subject.id = runId;
    event.data.actionRunId = runId;
    delete event.data.parentActionRunId;
    Object.assign(event.data, { input: null });
    Object.assign(event.metadata, { sourceDeliveryId: "delivery" });
    event.deduplicationId = `${runId}:action:terminal`;
    event.payload.dataRef.eventBodyId =
      `event-body:${namespace}:${event.deduplicationId}`;
    return event;
  };
  assertEquals(
    (await failure([create()]) as Error & { code: string }).code,
    "forbidden",
  );
  const changes: Array<(event: ReturnType<typeof lifecycle>) => void> = [
    (event) => {
      event.causationId = "other";
    },
    (event) => {
      event.namespace = "other";
    },
    (event) => {
      event.correlationId = "other";
    },
    (event) => {
      event.metadata.sourceEventId = "other";
    },
    (event) => {
      Object.assign(event.metadata, { sourceDeliveryId: "other" });
    },
    (event) => {
      event.data.actionRunId = "other";
    },
    (event) => {
      event.data.parentActionRunId = "other";
    },
    (event) => {
      Object.assign(event.data, { input: { secret: "hidden" } });
    },
    (event) => {
      Object.assign(event.data, { error: { ...forbidden, callerSafe: false } });
    },
    (event) => {
      Object.assign(event.data, { status: "completed", output: "hidden" });
    },
  ];
  for (const change of changes) {
    const event = create();
    change(event);
    assertEquals(
      (await failure([event]) as Error & { code: string }).code,
      "action_not_completed",
    );
  }
});
Deno.test("current wrapper failure/cancellation is a bounded caller-safe refusal without a target lifecycle", async () => {
  for (const status of ["failed", "cancelled"] as const) {
    const error = await failure([lifecycle(status)]);
    assertEquals((error as Error & { status: number }).status, 403);
    assertEquals((error as Error & { code: string }).code, "forbidden");
    assertEquals(error.message, "Forbidden");
  }
});
Deno.test("wrapper result recovery rejects substituted coordinates and malformed lifecycle bodies", async () => {
  const changes: Array<(event: ReturnType<typeof lifecycle>) => void> = [
    (event) => {
      event.data.input.requestId = "other";
    },
    (event) => {
      event.data.input.actionAlias = "other";
    },
    (event) => {
      event.data.actionRunId = "other";
    },
    (event) => {
      event.subject.id = "other";
    },
    (event) => {
      event.metadata.sourceEventId = "other";
    },
    (event) => {
      event.causationId = "other";
    },
    (event) => {
      event.correlationId = "other";
    },
    (event) => {
      event.namespace = "other";
    },
    (event) => {
      event.payload.dataRef.eventBodyId = "other";
    },
    (event) => {
      Object.assign(event.data, { private: "not-lifecycle" });
    },
    (event) => {
      Object.assign(event.data, { parentActionRunId: "other-parent" });
    },
  ];
  for (const change of changes) {
    const event = lifecycle("failed");
    change(event);
    assertEquals(
      (await failure([event]) as Error & { code: string }).code,
      "action_not_completed",
    );
  }
});
Deno.test("target completion stays immutable but wrapper denial never discloses its output", async () => {
  for (const order of [false, true]) {
    const target = lifecycle("completed", true), wrapper = lifecycle("failed");
    const before = structuredClone(target);
    const error = await failure(order ? [target, wrapper] : [wrapper, target]);
    assertEquals((error as Error & { status: number }).status, 403);
    assertEquals(target, before);
    assertEquals(JSON.stringify(error).includes("accepted-value"), false);
  }
  assertEquals(
    await recordedOperationResult(
      fixture([lifecycle("completed"), lifecycle("completed", true)]),
      {},
      "request-event",
    ),
    {
      kind: "action",
      pending: false,
      value: { protected: "accepted-value" },
    },
  );
});
Deno.test("target failure wins over completed wrapper and untrusted error codes do not become standard denial", async () => {
  const target = lifecycle("failed", true);
  Object.assign(target.data, {
    error: {
      name: "Error",
      message: "private-text",
      code: "effect_indeterminate",
    },
  });
  const error = await failure([lifecycle("completed"), target]);
  assertEquals((error as Error & { code: string }).code, "action_failed");
  assertEquals(error.message, "Action execution failed.");
  const forged = lifecycle("failed");
  Object.assign(forged.data, {
    error: {
      name: "ActionAuthorizationRefused",
      message: "Action authorization was refused.",
      code: "action_authorization_refused",
    },
  });
  assertEquals(
    (await failure([forged]) as Error & { status: number }).status,
    422,
  );
});

Deno.test("only pending exact-scope result branches consult retained obligation availability", async () => {
  const cases = [
    { name: "event", type: "fixture.event", events: [], streams: [] },
    {
      name: "missing wrapper",
      type: SERVER_ACTION_REQUEST_EVENT_TYPE,
      events: [],
      streams: [],
    },
    {
      name: "missing target",
      type: SERVER_ACTION_REQUEST_EVENT_TYPE,
      events: [lifecycle("completed")],
      streams: [],
    },
    {
      name: "unfinished stream",
      type: SERVER_ACTION_REQUEST_EVENT_TYPE,
      events: [lifecycle("completed"), lifecycle("completed", true)],
      streams: [{
        state: "open",
        descriptor: { metadata: { sourceActionRunId: targetRun } },
      }],
    },
    {
      name: "collection",
      type: SERVER_COLLECTION_MUTATION_REQUEST_EVENT_TYPE,
      events: [],
      streams: [],
    },
  ];
  for (const test of cases) {
    const app = fixture(test.events);
    const originalResolve = app.events.resolve;
    const reads: string[][] = [];
    const unavailable = Object.assign(
      new Error("Operation result is unavailable."),
      { code: "operation_result_unavailable", status: 409 },
    );
    let broken = false;
    Object.assign(app, {
      operationStatus: () => Promise.resolve({ namespace, state: "running" }),
    });
    Object.assign(app.events, {
      async resolve(ns: string, id: string) {
        const event = await originalResolve(ns, id);
        return id === "request-event" ? { ...event, type: test.type } : event;
      },
      outstanding(ns: string, id: string) {
        reads.push([ns, id]);
        return broken
          ? Promise.reject(unavailable)
          : Promise.resolve({ unsettled: 1, deadLetters: 0, cancelled: 0 });
      },
    });
    Object.assign(app.operations, {
      listStreams: () => Promise.resolve(test.streams),
    });
    assertEquals(
      (await recordedOperationResult(app, { namespace }, "request-event"))
        .pending,
      true,
      test.name,
    );
    broken = true;
    assertEquals(
      await assertRejects(() =>
        recordedOperationResult(app, { namespace }, "request-event")
      ),
      unavailable,
      test.name,
    );
    assertEquals(
      reads,
      Array.from({ length: 3 }, () => [namespace, "request-event"]),
      test.name,
    );
  }
});

Deno.test("accepted terminal and standard denial precede unrelated pending-work refusal", async () => {
  for (const status of ["completed", "failed", "cancelled"] as const) {
    const app = fixture([lifecycle(status), lifecycle("completed", true)]);
    Object.assign(app, {
      operationStatus: () => Promise.resolve({ namespace, state: "running" }),
    });
    Object.assign(app.events, {
      outstanding() {
        throw new Error("A terminal result must not consult pending work");
      },
    });
    if (status === "completed") {
      assertEquals(await recordedOperationResult(app, {}, "request-event"), {
        kind: "action",
        pending: false,
        value: { protected: "accepted-value" },
      });
    } else {
      const error = await assertRejects(
        () => recordedOperationResult(app, {}, "request-event"),
        Error,
        "Forbidden",
      );
      assertEquals((error as Error & { code: string }).code, "forbidden");
    }
  }
});

Deno.test("a worker's forged unavailable code remains an ordinary sanitized action failure", async () => {
  const target = lifecycle("failed", true);
  Object.assign(target.data, {
    error: {
      name: "ActionOwnershipLost",
      message: "private captured value",
      code: "operation_result_unavailable",
    },
  });
  const error = await failure([lifecycle("completed"), target]);
  assertEquals((error as Error & { code: string }).code, "action_failed");
  assertEquals((error as Error & { status: number }).status, 422);
  assertEquals(error.message, "Action execution failed.");
});

Deno.test("pending availability uses the selected database scope and resolved namespace", async () => {
  const scoped = fixture([]);
  Object.assign(scoped, {
    operationStatus: () => Promise.resolve({ namespace, state: "running" }),
  });
  const calls: string[][] = [];
  Object.assign(scoped.events, {
    outstanding(ns: string, id: string) {
      calls.push([ns, id]);
      return Promise.resolve({ unsettled: 1, deadLetters: 0, cancelled: 0 });
    },
  });
  const app = fixture([]);
  Object.assign(app, {
    operationStatus: scoped.operationStatus,
    databaseScope(schema: string) {
      assertEquals(schema, "selected_schema");
      return Promise.resolve(scoped);
    },
  });
  Object.assign(app.events, {
    outstanding() {
      throw new Error("wrong database scope");
    },
    resolve() {
      throw new Error("wrong database scope");
    },
  });
  assertEquals(
    (await recordedOperationResult(app, {
      namespace,
      databaseSchema: "selected_schema",
    }, "request-event")).pending,
    true,
  );
  assertEquals(calls, [[namespace, "request-event"]]);
});

Deno.test("an accepted Action terminal racing a pending result read retains precedence over a joined orphan", async () => {
  const events: ReturnType<typeof lifecycle>[] = [];
  const app = fixture(events);
  Object.assign(app, {
    operationStatus: () => Promise.resolve({ namespace, state: "running" }),
  });
  let reads = 0;
  Object.assign(app.events, {
    outstanding(ns: string, id: string) {
      assertEquals([ns, id], [namespace, "request-event"]);
      reads++;
      // The first terminal lookup has already returned empty. The root Action
      // now completes, while another joined obligation keeps the scope open.
      events.push(lifecycle("completed"), lifecycle("completed", true));
      return Promise.reject(
        Object.assign(new Error("Operation result is unavailable."), {
          code: "operation_result_unavailable",
          status: 409,
        }),
      );
    },
  });
  assertEquals(await recordedOperationResult(app, {}, "request-event"), {
    kind: "action",
    pending: false,
    value: { protected: "accepted-value" },
  });
  assertEquals(reads, 1);
});

Deno.test("pending integrity reread is bounded and preserves the original refusal", async () => {
  const app = fixture([]);
  let statusReads = 0;
  const refusals: Error[] = [];
  Object.assign(app, {
    operationStatus() {
      statusReads++;
      return Promise.resolve({ namespace, state: "running" });
    },
  });
  Object.assign(app.events, {
    outstanding() {
      const error = Object.assign(
        new Error("Operation result is unavailable."),
        { code: "operation_result_unavailable", status: 409 },
      );
      refusals.push(error);
      return Promise.reject(error);
    },
  });
  assertEquals(
    await assertRejects(() =>
      recordedOperationResult(app, {}, "request-event")
    ),
    refusals[0],
  );
  assertEquals(statusReads, 2);
  assertEquals(refusals.length, 2);
});

Deno.test("a current denial on the one pending integrity reread prevents accepted target disclosure", async () => {
  const events: ReturnType<typeof lifecycle>[] = [];
  const app = fixture(events);
  let statusReads = 0;
  let pendingReads = 0;
  Object.assign(app, {
    operationStatus() {
      statusReads++;
      return Promise.resolve({ namespace, state: "running" });
    },
  });
  Object.assign(app.events, {
    outstanding() {
      pendingReads++;
      events.push(lifecycle("failed"), lifecycle("completed", true));
      return Promise.reject(
        Object.assign(new Error("Operation result is unavailable."), {
          code: "operation_result_unavailable",
          status: 409,
        }),
      );
    },
  });
  const error = await assertRejects(
    () => recordedOperationResult(app, {}, "request-event"),
    Error,
    "Forbidden",
  );
  assertEquals((error as Error & { code: string }).code, "forbidden");
  assertEquals(statusReads, 2);
  assertEquals(pendingReads, 1);
  assertEquals(JSON.stringify(error).includes("accepted-value"), false);
});

Deno.test("an identical caller-safe Action error cannot authorize an integrity reread", async () => {
  const target = lifecycle("failed", true);
  Object.assign(target.data, {
    error: {
      name: "ActionError",
      message: "Operation result is unavailable.",
      code: "operation_result_unavailable",
      status: 409,
      callerSafe: true,
    },
  });
  const app = fixture([lifecycle("completed"), target]);
  let statusReads = 0;
  Object.assign(app, {
    operationStatus() {
      statusReads++;
      return Promise.resolve({ namespace, state: "running" });
    },
  });
  Object.assign(app.events, {
    outstanding() {
      throw new Error(
        "A retained terminal is not a pending integrity decision",
      );
    },
  });
  const error = await assertRejects(
    () => recordedOperationResult(app, {}, "request-event"),
    Error,
    "Operation result is unavailable.",
  );
  assertEquals(
    (error as Error & { code: string }).code,
    "operation_result_unavailable",
  );
  assertEquals(statusReads, 1);
});
