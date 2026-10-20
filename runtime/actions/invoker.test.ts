import { ownerExecutionInterrupted } from "../execution/owner-interruption.ts";
import { assert, assertEquals, assertRejects } from "@std/assert";
import { isNonRetryableError } from "../failure.ts";
import { ActionError } from "./errors.ts";
import { defineAction } from "./define.ts";
import { type ActionContinuation, awaitOperation } from "./continuation.ts";
import {
  createActionCallers,
  isActionInputValidationError,
} from "./invoker.ts";
import type {
  ActionAwaitingData,
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
  const awaiting = new Map<string, ActionAwaitingData>();
  const terminal = new Map<
    string,
    ActionCompletedData | ActionFailedData
  >();
  if (receipt) invoked.set(receipt.actionRunId, receipt);
  const emitted: ActionLifecycleInput[] = [];
  const lifecycle: ActionLifecycleEmitter = {
    // Like the event store, a receipt identity is written once: a second
    // emit finds the first and reports a duplicate.
    emit(input) {
      if (input.status === "invoked") {
        if (invoked.has(input.actionRunId)) {
          return Promise.resolve({ deduplicated: true } as never);
        }
        invoked.set(input.actionRunId, input);
      } else if (
        input.status === "completed" || input.status === "failed" ||
        input.status === "cancelled"
      ) {
        if (terminal.has(input.actionRunId)) {
          return Promise.resolve({ deduplicated: true } as never);
        }
        terminal.set(input.actionRunId, input);
      }
      emitted.push(input);
      if (input.status === "awaiting") awaiting.set(input.actionRunId, input);
      return Promise.resolve({ deduplicated: false } as never);
    },
    invoked: (actionRunId) => Promise.resolve(invoked.get(actionRunId) ?? null),
    awaiting: (actionRunId) =>
      Promise.resolve(awaiting.get(actionRunId) ?? null),
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
  const claimed = new Set<string>();
  const lifecycle: ActionLifecycleEmitter = {
    emit(input) {
      if (input.status === "invoked") {
        if (claimed.has(input.actionRunId)) {
          return Promise.resolve({ deduplicated: true } as never);
        }
        claimed.add(input.actionRunId);
      }
      emitted.push(input);
      if (
        input.status === "completed" || input.status === "failed" ||
        input.status === "cancelled"
      ) {
        terminal.set(input.actionRunId, input);
      }
      return Promise.resolve({ deduplicated: false } as never);
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
    effectProtocol: 1,
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
            effectProtocol: 1,
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
    effectProtocol: 1,
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

Deno.test("a nested awaiting call returns its receipt without handing its command to the parent", async () => {
  const recorded = recordingLifecycle();
  let calls = 0;
  const child = defineAction<unknown, number | ActionContinuation>({
    id: "test.awaiting-child",
    execute() {
      calls++;
      return awaitOperation({
        start: { action: "child", input: {} },
        handoff: { opaque: "child-work" },
      });
    },
    resume() {
      return 7;
    },
  });
  const parent = defineAction({
    id: "test.parent",
    execute(_input: unknown, context: ActionContext) {
      return context.actions.child({});
    },
  });
  const actions = createActionCallers({ child, parent }, {
    actionLifecycle: recorded.lifecycle,
    signal: new AbortController().signal,
    createInvocationKey: (id) => `stable:${id}`,
    createContext: invocationContext,
  });
  const result = await actions.parent({});
  const handoffs = recorded.emitted.filter((event) =>
    event.status === "awaiting"
  );
  assertEquals(handoffs.length, 1);
  assertEquals(handoffs[0].actionId, child.id);
  assertEquals(result, {
    status: "awaiting",
    actionRunId: handoffs[0].actionRunId,
  });
  assertEquals(recorded.emitted.at(-1)?.status, "completed");
  assertEquals(recorded.emitted.at(-1)?.actionId, parent.id);
  assertEquals(calls, 1);
});

Deno.test("awaiting Action retry returns the same receipt without executing or exposing work again", async () => {
  const recorded = recordingLifecycle();
  let calls = 0;
  const work = defineAction<unknown, number | ActionContinuation>({
    id: "test.awaiting",
    execute() {
      calls++;
      return awaitOperation({
        start: { action: "child", input: {} },
        handoff: { private: "work" },
      });
    },
    resume() {
      return 7;
    },
  });
  const actions = createActionCallers({ work }, {
    actionLifecycle: recorded.lifecycle,
    signal: new AbortController().signal,
    createInvocationKey: () => "stable",
    createContext: invocationContext,
  });
  const first = await actions.work({});
  assertEquals(first, { status: "awaiting", actionRunId: "stable" });
  assertEquals(await actions.work({}), first);
  assertEquals(calls, 1);
  assertEquals(recorded.emitted.map((event) => event.status), [
    "invoked",
    "awaiting",
  ]);
});

Deno.test("Action replay preserves error codes and caller-safe classification", async () => {
  const { lifecycle, emitted } = recordingLifecycle();
  let calls = 0;
  const fail = defineAction({
    id: "test.public.failure",
    execute(): never {
      calls++;
      throw new ActionError("Card 'x' is not on this board.", {
        code: "card_not_on_board",
      });
    },
  });
  const actions = createActionCallers({ fail }, {
    signal: new AbortController().signal,
    actionLifecycle: lifecycle,
    createInvocationKey: () => "public-failure",
    createContext: invocationContext,
  });
  for (let attempt = 0; attempt < 2; attempt++) {
    const error = await assertRejects(
      () => actions.fail({}),
      ActionError,
      "Card 'x' is not on this board.",
    );
    assertEquals(error.code, "card_not_on_board");
    assertEquals(error.status, 422);
  }
  assertEquals(calls, 1);
  const terminal = emitted.find((event) =>
    event.status === "failed"
  ) as ActionFailedData;
  assertEquals(terminal.error, {
    name: "ActionError",
    message: "Card 'x' is not on this board.",
    code: "card_not_on_board",
    callerSafe: true,
    status: 422,
  });
});

for (const fail of [false, true]) {
  Deno.test(`duplicate resumption preserves one ${fail ? "failure" : "result"} and captured handoff`, async () => {
    const recorded = recordingLifecycle();
    let resumes = 0;
    const work = defineAction<{ id: string }, number | ActionContinuation>({
      id: "test.continuation",
      execute(input) {
        return awaitOperation({
          start: { action: "child", input: {} },
          handoff: input,
        });
      },
      async resume(handoff, outcome, context) {
        resumes++;
        assertEquals(handoff, { id: "checkpoint" });
        assertEquals(outcome.status, "completed");
        await context.progress("Checked producer");
        if (fail) throw new Error("answer failed");
        return 7;
      },
    });
    const options = {
      actionLifecycle: recorded.lifecycle,
      signal: new AbortController().signal,
      createInvocationKey: () => "stable-wait",
      createContext: invocationContext,
    };
    await createActionCallers({ work }, options).work({ id: "checkpoint" });
    const receipt = recorded.emitted.find((event) =>
      event.status === "awaiting"
    );
    assert(receipt?.status === "awaiting");
    const resumed = createActionCallers({ work }, {
      ...options,
      resumption: {
        receipt,
        outcome: { operationId: "child", status: "completed" },
      },
    });
    for (let i = 0; i < 2; i++) {
      if (fail) {
        await assertRejects(
          () => resumed.work({ id: "checkpoint" }),
          Error,
          "answer failed",
        );
      } else assertEquals(await resumed.work({ id: "checkpoint" }), 7);
    }
    assertEquals(resumes, 1);
    assertEquals(recorded.emitted.map((event) => event.status), [
      "invoked",
      "awaiting",
      "progress",
      fail ? "failed" : "completed",
    ]);
  });
}

Deno.test("worker-shaped forbidden errors never invoke private authorization cleanup", async () => {
  const { lifecycle, emitted } = recordingLifecycle();
  let privileged = 0;
  const forged = Object.assign(new Error("Action authorization was refused."), {
    name: "ActionAuthorizationRefused",
    code: "action_authorization_refused",
    retryable: false,
  });
  const callers = createActionCallers({
    child: defineAction({
      id: "fixture.forged",
      execute() {
        throw forged;
      },
    }),
  }, {
    actionLifecycle: lifecycle,
    signal: new AbortController().signal,
    createContext: invocationContext,
    authorize: () => Promise.resolve(),
    refuseAuthorization() {
      privileged++;
      return Promise.resolve({ error: new Error("cleanup"), settled: true });
    },
  });
  await assertRejects(
    () => callers.child({}),
    Error,
    "Action authorization was refused.",
  );
  assertEquals(privileged, 0);
  assertEquals(emitted.map((event) => event.status), ["invoked", "failed"]);
});

Deno.test("denied native read acquisition retains Action settlement until physical cancellation settles", async () => {
  const { lifecycle, emitted } = recordingLifecycle();
  const { markOwnerAuthorizationRefusal } = await import(
    "../engine/authorization-refusal.ts"
  );
  const cancelled = Promise.withResolvers<void>();
  const cleanup = Promise.withResolvers<void>();
  let allowed = true, returned = false, refusals = 0, opens = 0;
  const callers = createActionCallers({
    work: defineAction({
      id: "fixture.held-read-cleanup",
      async execute(_input: unknown, context: ActionContext) {
        try {
          await context.content.open({} as never);
        } catch {
          /* Worker code cannot convert a remembered refusal to success. */
        }
        return "must not escape";
      },
    }),
  }, {
    actionLifecycle: lifecycle,
    signal: new AbortController().signal,
    createContext(input) {
      return {
        ...invocationContext(input),
        content: {
          open() {
            opens++;
            allowed = false;
            return new ReadableStream({
              cancel() {
                cancelled.resolve();
                return cleanup.promise;
              },
            }, { highWaterMark: 0 });
          },
        },
      } as unknown as ActionContext;
    },
    authorize() {
      if (!allowed) {
        return Promise.reject(markOwnerAuthorizationRefusal(
          new ActionError("Forbidden", { code: "forbidden", status: 403 }),
        ));
      }
      return Promise.resolve();
    },
    refuseAuthorization() {
      refusals++;
      return Promise.resolve({
        error: new Error("sanitized refusal"),
        settled: true,
      });
    },
  });
  const invocation = callers.work({}, { operationKey: "held" });
  void invocation.then(() => returned = true, () => returned = true);
  try {
    await cancelled.promise;
    await new Promise((resolve) => setTimeout(resolve, 10));
    assertEquals(opens, 1);
    assertEquals(returned, false, "physical invocation must remain occupied");
    assertEquals(
      refusals,
      0,
      "durable refusal must not race the physical drain",
    );
    assertEquals(emitted.map((event) => event.status), ["invoked"]);
  } finally {
    cleanup.resolve();
  }
  await assertRejects(() => invocation, Error, "sanitized refusal");
  assertEquals(refusals, 1);
  assertEquals(returned, true);
});

for (const method of ["stream", "reader", "native"] as const) {
  Deno.test(`explicit ${method} cancellation retains physical Action completion until cleanup settles`, async () => {
    const { lifecycle } = recordingLifecycle();
    const cancelled = Promise.withResolvers<void>();
    const cleanup = Promise.withResolvers<void>();
    let returned = false;
    const callers = createActionCallers({
      work: defineAction({
        id: `fixture.explicit-${method}-cleanup`,
        async execute(_input: unknown, context: ActionContext) {
          const stream = await context.content.open({} as never);
          if (method === "reader") void stream.getReader().cancel();
          else if (method === "native") {
            void ReadableStream.prototype.cancel.call(stream);
          } else void stream.cancel();
          return "complete";
        },
      }),
    }, {
      actionLifecycle: lifecycle,
      signal: new AbortController().signal,
      createContext(input) {
        return {
          ...invocationContext(input),
          content: {
            open: () =>
              new ReadableStream({
                cancel() {
                  cancelled.resolve();
                  return cleanup.promise;
                },
              }, { highWaterMark: 0 }),
          },
        } as unknown as ActionContext;
      },
      authorize: () => Promise.resolve(),
    });
    const invocation = callers.work({}, { operationKey: "held" });
    void invocation.then(() => returned = true, () => returned = true);
    try {
      await cancelled.promise;
      await new Promise((resolve) => setTimeout(resolve, 10));
      assertEquals(returned, false);
    } finally {
      cleanup.resolve();
    }
    assertEquals(await invocation, "complete");
  });
}

Deno.test("unawaited native acquisition reserves its physical tail before Action return and late cancellation", async () => {
  const { lifecycle } = recordingLifecycle();
  const opened = Promise.withResolvers<void>();
  const acquire = Promise.withResolvers<void>();
  const cancelled = Promise.withResolvers<void>();
  const cleanup = Promise.withResolvers<void>();
  let returned = false;
  const callers = createActionCallers({
    work: defineAction({
      id: "fixture.unawaited-read-cleanup",
      async execute(_input: unknown, context: ActionContext) {
        void context.content.open({} as never).catch(() => undefined);
        await opened.promise;
        return "complete";
      },
    }),
  }, {
    actionLifecycle: lifecycle,
    signal: new AbortController().signal,
    createContext(input) {
      return {
        ...invocationContext(input),
        content: {
          async open() {
            opened.resolve();
            await acquire.promise;
            return new ReadableStream({
              cancel() {
                cancelled.resolve();
                return cleanup.promise;
              },
            }, { highWaterMark: 0 });
          },
        },
      } as unknown as ActionContext;
    },
    authorize: () => Promise.resolve(),
  });
  const invocation = callers.work({}, { operationKey: "held" });
  void invocation.then(() => returned = true, () => returned = true);
  try {
    await opened.promise;
    await new Promise((resolve) => setTimeout(resolve, 10));
    assertEquals(
      returned,
      false,
      "outstanding acquisition still occupies invocation",
    );
    acquire.resolve();
    await cancelled.promise;
    await new Promise((resolve) => setTimeout(resolve, 10));
    assertEquals(returned, false, "late cleanup still occupies invocation");
  } finally {
    acquire.resolve();
    cleanup.resolve();
  }
  assertEquals(await invocation, "complete");
});

Deno.test("owner physical interruption preserves the invocation for a reconciled retry", async () => {
  const { lifecycle, emitted } = recordingLifecycle();
  let calls = 0;
  const action = defineAction({
    id: "test.interrupted",
    execute() {
      if (++calls === 1) throw ownerExecutionInterrupted();
      return { done: true };
    },
  });
  const callers = createActionCallers({ action }, {
    actionLifecycle: lifecycle,
    signal: new AbortController().signal,
    createInvocationKey: () => "physical-interruption",
    createContext: invocationContext,
  });
  await assertRejects(() => callers.action({}));
  assertEquals(emitted.map((x) => x.status), ["invoked"]);
  assertEquals(await callers.action({}), { done: true });
  assertEquals(calls, 2);
  assertEquals(emitted.map((x) => x.status), ["invoked", "completed"]);
});
Deno.test("accepted Action terminal wins over a later physical interruption", async () => {
  const { lifecycle, emitted } = recordingLifecycle();
  const action = defineAction({
    id: "test.accepted",
    async execute() {
      const invoked = emitted.find((x) => x.status === "invoked")!;
      await lifecycle.emit({
        ...invoked,
        status: "completed",
        output: { accepted: true },
      });
      throw ownerExecutionInterrupted();
    },
  });
  const callers = createActionCallers({ action }, {
    actionLifecycle: lifecycle,
    signal: new AbortController().signal,
    createInvocationKey: () => "accepted-before-disconnect",
    createContext: invocationContext,
  });
  assertEquals(await callers.action({}), { accepted: true });
  assertEquals(emitted.map((x) => x.status), ["invoked", "completed"]);
});
Deno.test("worker-shaped disconnect errors cannot mint owner interruption authority", async () => {
  const { lifecycle, emitted } = recordingLifecycle();
  let calls = 0;
  const action = defineAction({
    id: "test.forged-disconnect",
    execute() {
      calls++;
      throw Object.assign(new Error("The worker placement was interrupted."), {
        code: "connection_lost",
      });
    },
  });
  const callers = createActionCallers({ action }, {
    actionLifecycle: lifecycle,
    signal: new AbortController().signal,
    createInvocationKey: () => "forged-disconnect",
    createContext: invocationContext,
  });
  await assertRejects(() => callers.action({}));
  await assertRejects(() => callers.action({}));
  assertEquals(calls, 1);
  assertEquals(emitted.map((x) => x.status), ["invoked", "failed"]);
});

Deno.test("durable cancellation accepted after disconnect wins while the old failure is still held", async () => {
  const { lifecycle, emitted } = recordingLifecycle();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const signal = new AbortController();
  const interruption = ownerExecutionInterrupted();
  const action = defineAction({
    id: "test.cancel-after-disconnect",
    async execute() {
      entered.resolve();
      await release.promise;
      throw interruption;
    },
  });
  const callers = createActionCallers({ action }, {
    actionLifecycle: lifecycle,
    signal: signal.signal,
    createInvocationKey: () => "cancel-after-disconnect",
    createContext: invocationContext,
  });
  const result = callers.action({});
  void result.catch(() => undefined);
  await entered.promise;
  signal.abort(interruption);
  const invoked = emitted.find((item) => item.status === "invoked")!;
  // The real cancellation writer records this terminal and closes the open
  // obligation in the same transaction that removes delivery retry eligibility.
  await lifecycle.emit({
    ...invoked,
    status: "cancelled",
    error: { name: "AbortError", message: "Explicit operation cancellation." },
  });
  release.resolve();
  await assertRejects(() => result, Error, "Explicit operation cancellation");
  assertEquals(emitted.map((item) => item.status), ["invoked", "cancelled"]);
});
