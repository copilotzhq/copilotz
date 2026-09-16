import { assert, assertEquals, assertRejects } from "@std/assert";
import { isNonRetryableError } from "../failure.ts";
import { defineAction } from "./define.ts";
import {
  createActionCallers,
  isActionInputValidationError,
} from "./invoker.ts";
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
});

Deno.test("Action input-schema failures are typed before lifecycle invocation", async () => {
  const { lifecycle, emitted } = recordingLifecycle();
  let executions = 0;
  const action = defineAction({
    id: "test.input-validation",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { value: { type: "string" } },
      required: ["value"],
    },
    execute() {
      executions += 1;
      return { ok: true };
    },
  });
  const actions = createActionCallers({ action }, {
    actionLifecycle: lifecycle,
    signal: new AbortController().signal,
    createInvocationKey: () => "run-input-validation",
    createContext: invocationContext,
  });

  for (
    const input of [
      { value: "valid", unexpected: true },
      {},
      { value: 42 },
    ]
  ) {
    const error = await assertRejects(() => actions.action(input));
    assert(isActionInputValidationError(error));
    assert(error instanceof TypeError);
    assert(isNonRetryableError(error));
    assertEquals(error.actionId, action.id);
  }
  assertEquals(executions, 0);
  assertEquals(emitted, []);
});

Deno.test("invalid Action schemas are not classified as caller input failures", async () => {
  const { lifecycle, emitted } = recordingLifecycle();
  let executions = 0;
  const action = defineAction({
    id: "test.invalid-input-schema",
    inputSchema: { type: "string", pattern: "[" },
    execute() {
      executions += 1;
      return null;
    },
  });
  const actions = createActionCallers({ action }, {
    actionLifecycle: lifecycle,
    signal: new AbortController().signal,
    createInvocationKey: () => "run-invalid-input-schema",
    createContext: invocationContext,
  });

  const error = await assertRejects(() => actions.action({}));
  assertEquals(isActionInputValidationError(error), false);
  assertEquals(executions, 0);
  assertEquals(emitted, []);
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

Deno.test("prepared Action skips its factory for invoked and terminal receipts", async () => {
  const { lifecycle } = recordingLifecycle();
  let executions = 0;
  let preparations = 0;
  const action = defineAction({
    id: "test.prepare.receipts",
    execute(input: Readonly<{ value: string }>) {
      executions += 1;
      return { value: input.value };
    },
  });
  const actions = createActionCallers({ action }, {
    actionLifecycle: lifecycle,
    signal: new AbortController().signal,
    createInvocationKey: () => "run-prepared-receipts",
    createContext: invocationContext,
  });
  const factory = () => {
    preparations += 1;
    return { input: { value: "captured" }, metadata: { source: "latest" } };
  };
  assertEquals(
    await actions.action.prepare(factory, { operationKey: "latest" }),
    { value: "captured" },
  );
  assertEquals(preparations, 1);
  assertEquals(executions, 1);
  assertEquals(
    await actions.action.prepare(factory, { operationKey: "latest" }),
    { value: "captured" },
  );
  assertEquals(preparations, 1);
  assertEquals(executions, 1);
});

Deno.test("prepared Action reuses its first capture without calling an unstable host key", async () => {
  const { lifecycle, emitted } = recordingLifecycle();
  let hostCalls = 0;
  let preparations = 0;
  let executions = 0;
  const action = defineAction({
    id: "test.prepare.retry",
    execute(input: Readonly<{ value: string }>) {
      executions += 1;
      return input;
    },
  });
  const actions = createActionCallers({ action }, {
    actionLifecycle: lifecycle,
    signal: new AbortController().signal,
    invocationScope: "delivery:stable",
    createInvocationKey: () => `unstable:${++hostCalls}`,
    createContext: invocationContext,
  });
  const factory = () => {
    preparations += 1;
    return { input: { value: "captured" } };
  };
  assertEquals(
    await actions.action.prepare(factory, { operationKey: "route:message" }),
    { value: "captured" },
  );
  assertEquals(
    await actions.action.prepare(factory, { operationKey: "route:message" }),
    { value: "captured" },
  );
  assertEquals(preparations, 1);
  assertEquals(executions, 1);
  assertEquals(hostCalls, 0);
  assertEquals(
    emitted.filter((event) => event.status === "invoked").map((event) =>
      event.actionRunId
    ),
    ["delivery:stable:action:test.prepare.retry:route:message"],
  );
});

Deno.test("prepared Actions with the same key retain distinct parent scopes", async () => {
  const { lifecycle, emitted } = recordingLifecycle();
  let executions = 0;
  const child = defineAction({
    id: "test.prepare.child",
    execute(input: Readonly<{ owner: string }>) {
      executions += 1;
      return input;
    },
  });
  const parent = (id: string, owner: string) =>
    defineAction({
      id,
      async execute(_input: unknown, context: ActionContext) {
        return await context.actions.child.prepare(
          () => ({ input: { owner } }),
          { operationKey: "shared" },
        );
      },
    });
  const actions = createActionCallers({
    first: parent("test.prepare.parent.first", "first"),
    second: parent("test.prepare.parent.second", "second"),
    child,
  }, {
    actionLifecycle: lifecycle,
    signal: new AbortController().signal,
    invocationScope: "delivery:stable",
    createContext: invocationContext,
  });
  assertEquals(await actions.first({}, { operationKey: "first" }), {
    owner: "first",
  });
  assertEquals(await actions.second({}, { operationKey: "second" }), {
    owner: "second",
  });
  assertEquals(executions, 2);
  assertEquals(
    emitted.filter((event) =>
      event.actionId === "test.prepare.child" && event.status === "invoked"
    ).map((event) => event.actionRunId),
    [
      "first/action:test.prepare.parent.first/action:test.prepare.child:shared",
      "second/action:test.prepare.parent.second/action:test.prepare.child:shared",
    ],
  );
});

Deno.test("prepared Action reloads the first durable invoked capture after a race", async () => {
  const invoked = new Map<string, ActionInvokedData>();
  let first = true;
  const lifecycle: ActionLifecycleEmitter = {
    async emit(event) {
      if (event.status === "invoked") {
        if (first) {
          first = false;
          invoked.set(event.actionRunId, {
            actionRunId: event.actionRunId,
            actionId: event.actionId,
            metadata: { winner: true },
            status: "invoked",
            input: { value: "winner" },
          });
          throw new Error("duplicate invoked receipt");
        }
      }
      return undefined as never;
    },
    invoked: async (id) => invoked.get(id) ?? null,
    terminal: async () => null,
  };
  let executed: unknown;
  const action = defineAction({
    id: "test.prepare.race",
    execute(input: unknown, context: ActionContext) {
      executed = { input, metadata: context.action.metadata };
      return input;
    },
  });
  const actions = createActionCallers({ action }, {
    actionLifecycle: lifecycle,
    signal: new AbortController().signal,
    createInvocationKey: () => "run-prepared-race",
    createContext: invocationContext,
  });
  assertEquals(
    await actions.action.prepare(
      () => ({ input: { value: "loser" }, metadata: { winner: false } }),
      { operationKey: "latest" },
    ),
    { value: "winner" },
  );
  assertEquals(executed, {
    input: { value: "winner" },
    metadata: { winner: true },
  });
});

Deno.test("prepared Action replays hydrated secret input without evaluating a newer factory", async () => {
  const receipt: ActionInvokedData = {
    actionRunId: "lifecycle:action:test.prepare.secret:latest",
    actionId: "test.prepare.secret",
    status: "invoked",
    metadata: { source: "captured" },
    // The real protected lifecycle loader hydrates this value before it reaches
    // the invoker; the prepared path must keep it intact and never call factory.
    input: { token: "hydrated-secret" },
  };
  const { lifecycle } = recordingLifecycle(receipt);
  let factoryCalls = 0;
  let executed: unknown;
  const action = defineAction({
    id: "test.prepare.secret",
    inputSchema: {
      type: "object",
      properties: {
        token: { type: "string", "x-copilotz-secret": true },
      },
      required: ["token"],
    },
    execute(input: unknown) {
      executed = input;
      return "ok";
    },
  });
  const actions = createActionCallers({ action }, {
    actionLifecycle: lifecycle,
    signal: new AbortController().signal,
    createInvocationKey: () => "run-prepared-secret",
    createContext: invocationContext,
  });
  assertEquals(
    await actions.action.prepare(() => {
      factoryCalls += 1;
      return { input: { token: "new-secret" } };
    }, { operationKey: "latest" }),
    "ok",
  );
  assertEquals(factoryCalls, 0);
  assertEquals(executed, { token: "hydrated-secret" });
});

Deno.test("prepared Action requires a stable non-empty operation key", async () => {
  const { lifecycle } = recordingLifecycle();
  const action = defineAction({ id: "test.prepare.key", execute: () => null });
  const actions = createActionCallers({ action }, {
    actionLifecycle: lifecycle,
    signal: new AbortController().signal,
    createContext: invocationContext,
  });
  await assertRejects(
    () =>
      actions.action.prepare(
        () => ({ input: {} }),
        { operationKey: " " } as never,
      ),
    TypeError,
    "operationKey",
  );
});
