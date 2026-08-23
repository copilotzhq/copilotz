import { assertEquals, assertRejects } from "@std/assert";
import { defineAction } from "./define.ts";
import { createActionCallers } from "./invoker.ts";
import type {
  ActionCompletedData,
  ActionContext,
  ActionFailedData,
  ActionInvokedData,
  ActionLifecycleEmitter,
  ActionLifecycleInput,
} from "./types.ts";

function recordingLifecycle(
  receipt?: ActionInvokedData,
): Readonly<{
  lifecycle: ActionLifecycleEmitter;
  emitted: ActionLifecycleInput[];
}> {
  const invoked = new Map<string, ActionInvokedData>();
  const terminal = new Map<
    string,
    ActionCompletedData | ActionFailedData
  >();
  if (receipt) invoked.set(receipt.actionRunId, receipt);
  const emitted: ActionLifecycleInput[] = [];
  const lifecycle: ActionLifecycleEmitter = {
    emit(input) {
      emitted.push(input);
      if (input.status === "invoked") {
        invoked.set(input.actionRunId, input);
      } else if (
        input.status === "completed" || input.status === "failed" ||
        input.status === "cancelled"
      ) {
        terminal.set(input.actionRunId, input);
      }
      return Promise.resolve(undefined as never);
    },
    invoked: (actionRunId) => Promise.resolve(invoked.get(actionRunId) ?? null),
    terminal: (actionRunId) =>
      Promise.resolve(terminal.get(actionRunId) ?? null),
  };
  return { lifecycle, emitted };
}

function invocationContext(
  input: Parameters<
    Parameters<typeof createActionCallers>[1]["createContext"]
  >[0],
): ActionContext {
  return Object.freeze({
    action: Object.freeze({
      id: input.frame.actionId,
      runId: input.frame.actionRunId,
      metadata: input.frame.metadata,
      ...(input.frame.parentActionRunId
        ? { parentRunId: input.frame.parentActionRunId }
        : {}),
    }),
    actions: input.actions,
    progress: input.progress,
  }) as unknown as ActionContext;
}

Deno.test("root Action identity combines host invocation and local operation", async () => {
  const terminal = new Map<
    string,
    ActionCompletedData | ActionFailedData
  >();
  const emitted: ActionLifecycleInput[] = [];
  const lifecycle: ActionLifecycleEmitter = {
    emit(input) {
      emitted.push(input);
      if (
        input.status === "completed" || input.status === "failed" ||
        input.status === "cancelled"
      ) {
        terminal.set(input.actionRunId, input);
      }
      return Promise.resolve(undefined as never);
    },
    invoked: () => Promise.resolve(null),
    terminal: (actionRunId) =>
      Promise.resolve(terminal.get(actionRunId) ?? null),
  };
  let executions = 0;
  const echo = defineAction({
    id: "test.echo",
    execute(input: Readonly<{ value: number }>) {
      executions += 1;
      return input;
    },
  });
  let hostInvocationKey = "event-1:action:1:test.echo";
  const actions = createActionCallers({ echo }, {
    actionLifecycle: lifecycle,
    signal: new AbortController().signal,
    createInvocationKey: () => hostInvocationKey,
    createContext: () => Object.freeze({}) as ActionContext,
  });

  assertEquals(
    await actions.echo({ value: 1 }, { operationKey: "core-message-input" }),
    { value: 1 },
  );
  assertEquals(
    await actions.echo({ value: 1 }, { operationKey: "core-message-input" }),
    { value: 1 },
  );
  hostInvocationKey = "event-2:action:1:test.echo";
  assertEquals(
    await actions.echo({ value: 2 }, { operationKey: "core-message-input" }),
    { value: 2 },
  );

  assertEquals(executions, 2);
  assertEquals(
    emitted.filter((event) => event.status === "invoked").map((event) =>
      event.actionRunId
    ),
    [
      "event-1:action:1:test.echo:core-message-input",
      "event-2:action:1:test.echo:core-message-input",
    ],
  );
});

Deno.test("Action metadata has one required empty lifecycle shape when omitted", async () => {
  const { lifecycle, emitted } = recordingLifecycle();
  const action = defineAction({
    id: "test.empty-metadata",
    async execute(_input: unknown, context: ActionContext) {
      await context.progress({ step: 1 });
      return { ok: true };
    },
  });
  const actions = createActionCallers({ action }, {
    actionLifecycle: lifecycle,
    signal: new AbortController().signal,
    createInvocationKey: () => "run-empty-metadata",
    createContext: invocationContext,
  });

  await actions.action({});

  assertEquals(emitted.map((event) => event.status), [
    "invoked",
    "progress",
    "completed",
  ]);
  assertEquals(emitted.map((event) => event.metadata), [{}, {}, {}]);
  assertEquals(emitted.every((event) => Object.isFrozen(event.metadata)), true);
});

Deno.test("Action metadata propagates through every lifecycle status", async () => {
  const { lifecycle, emitted } = recordingLifecycle();
  const completed = defineAction({
    id: "test.metadata.completed",
    async execute(_input: unknown, context: ActionContext) {
      await context.progress({ step: 1 });
      return { ok: true };
    },
  });
  const failed = defineAction({
    id: "test.metadata.failed",
    execute() {
      throw new Error("failed");
    },
  });
  const cancelled = defineAction({
    id: "test.metadata.cancelled",
    execute() {
      throw new DOMException("cancelled", "AbortError");
    },
  });
  const actions = createActionCallers({ completed, failed, cancelled }, {
    actionLifecycle: lifecycle,
    signal: new AbortController().signal,
    createInvocationKey: (actionId) => `run:${actionId}`,
    createContext: invocationContext,
  });
  const metadata = { request: { id: "request-1" } };

  await actions.completed({}, { metadata });
  await assertRejects(() => actions.failed({}, { metadata }), Error, "failed");
  await assertRejects(
    () => actions.cancelled({}, { metadata }),
    Error,
    "cancelled",
  );

  assertEquals(
    [...new Set(emitted.map((event) => event.status))].sort(),
    ["cancelled", "completed", "failed", "invoked", "progress"],
  );
  assertEquals(
    emitted.every((event) =>
      JSON.stringify(event.metadata) ===
        JSON.stringify({ request: { id: "request-1" } })
    ),
    true,
  );
});

Deno.test("Action retry requires identical invocation metadata", async () => {
  const { lifecycle } = recordingLifecycle();
  let executions = 0;
  const echo = defineAction({
    id: "test.metadata.retry",
    execute(input: Readonly<{ value: number }>) {
      executions += 1;
      return input;
    },
  });
  const actions = createActionCallers({ echo }, {
    actionLifecycle: lifecycle,
    signal: new AbortController().signal,
    createInvocationKey: () => "run-metadata-retry",
    createContext: invocationContext,
  });

  assertEquals(
    await actions.echo({ value: 1 }, {
      metadata: { z: 2, nested: { b: true, a: false } },
    }),
    { value: 1 },
  );
  assertEquals(
    await actions.echo({ value: 1 }, {
      metadata: { nested: { a: false, b: true }, z: 2 },
    }),
    { value: 1 },
  );
  await assertRejects(
    () =>
      actions.echo({ value: 1 }, {
        metadata: { nested: { a: false, b: true }, z: 3 },
      }),
    Error,
    "retried with different metadata",
  );
  assertEquals(executions, 1);
});

Deno.test("Action invocation receipts are validated before retry execution", async () => {
  const base: ActionInvokedData = {
    actionRunId: "run-invoked-receipt",
    actionId: "test.invoked-receipt",
    metadata: { requestId: "request-1" },
    status: "invoked",
    input: { value: 1 },
  };
  const mismatches = [
    {
      receipt: { ...base, actionId: "test.other" },
      message: "belongs to 'test.other'",
    },
    {
      receipt: { ...base, parentActionRunId: "parent-run" },
      message: "different parent",
    },
    {
      receipt: { ...base, input: { value: 2 } },
      message: "different input",
    },
    {
      receipt: { ...base, metadata: { requestId: "request-2" } },
      message: "different metadata",
    },
  ] as const;

  for (const mismatch of mismatches) {
    let executions = 0;
    const action = defineAction({
      id: "test.invoked-receipt",
      execute(input: Readonly<{ value: number }>) {
        executions += 1;
        return input;
      },
    });
    const { lifecycle } = recordingLifecycle(mismatch.receipt);
    const actions = createActionCallers({ action }, {
      actionLifecycle: lifecycle,
      signal: new AbortController().signal,
      createInvocationKey: () => "run-invoked-receipt",
      createContext: invocationContext,
    });
    await assertRejects(
      () =>
        actions.action({ value: 1 }, {
          metadata: { requestId: "request-1" },
        }),
      Error,
      mismatch.message,
    );
    assertEquals(executions, 0);
  }

  const { lifecycle, emitted } = recordingLifecycle(base);
  let executions = 0;
  const action = defineAction({
    id: "test.invoked-receipt",
    execute(input: Readonly<{ value: number }>) {
      executions += 1;
      return input;
    },
  });
  const actions = createActionCallers({ action }, {
    actionLifecycle: lifecycle,
    signal: new AbortController().signal,
    createInvocationKey: () => "run-invoked-receipt",
    createContext: invocationContext,
  });
  assertEquals(
    await actions.action({ value: 1 }, {
      metadata: { requestId: "request-1" },
    }),
    { value: 1 },
  );
  assertEquals(executions, 1);
  assertEquals(emitted.map((event) => event.status), ["completed"]);
});

Deno.test("nested Actions do not inherit invocation metadata", async () => {
  const { lifecycle, emitted } = recordingLifecycle();
  let childMetadata: Readonly<Record<string, unknown>> | undefined;
  const child = defineAction({
    id: "test.metadata.child",
    execute(_input: unknown, context: ActionContext) {
      childMetadata = context.action.metadata;
      return { ok: true };
    },
  });
  const parent = defineAction({
    id: "test.metadata.parent",
    execute(_input: unknown, context: ActionContext) {
      return context.actions.child({});
    },
  });
  const actions = createActionCallers({ parent, child }, {
    actionLifecycle: lifecycle,
    signal: new AbortController().signal,
    createInvocationKey: () => "run-metadata-parent",
    createContext: invocationContext,
  });

  await actions.parent({}, { metadata: { requestId: "request-1" } });

  assertEquals(childMetadata, {});
  assertEquals(
    emitted.find((event) =>
      event.actionId === "test.metadata.parent" && event.status === "invoked"
    )?.metadata,
    { requestId: "request-1" },
  );
  assertEquals(
    emitted.find((event) =>
      event.actionId === "test.metadata.child" && event.status === "invoked"
    )?.metadata,
    {},
  );
});

Deno.test("invalid Action metadata is rejected before invoked is emitted", async () => {
  const { lifecycle, emitted } = recordingLifecycle();
  let executions = 0;
  const action = defineAction({
    id: "test.invalid-metadata",
    execute() {
      executions += 1;
      return null;
    },
  });
  const actions = createActionCallers({ action }, {
    actionLifecycle: lifecycle,
    signal: new AbortController().signal,
    createInvocationKey: () => "run-invalid-metadata",
    createContext: invocationContext,
  });

  const circular: Record<string, unknown> = {};
  circular.self = circular;
  for (
    const metadata of [
      { invalid: undefined },
      { invalid: Number.NaN },
      { invalid: new Date("2026-08-23T00:00:00.000Z") },
      circular,
    ]
  ) {
    await assertRejects(
      () => actions.action({}, { metadata }),
      TypeError,
      "strict JSON-safe object",
    );
  }
  assertEquals(executions, 0);
  assertEquals(emitted, []);
});
