import { assertEquals, assertRejects } from "@std/assert";
import { recordedOperationResult } from "./result.ts";
import { SERVER_INVOKE_ACTION_ID } from "./invoke-action.ts";
import { SERVER_ACTION_REQUEST_EVENT_TYPE } from "./contracts.ts";
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
