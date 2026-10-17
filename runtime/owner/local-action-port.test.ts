import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  OwnerCaller,
  OwnerCommand,
  OwnerCommandBoundary,
  OwnerCommandOutcome,
  OwnerInputCommand,
  OwnerJson,
} from "./boundary.ts";
import type { RegisteredLocalActionReference } from "../execution/registered-local.ts";
import { ownerCompletionKey } from "../execution/owner-port.ts";
import { ownerLocalActionStartKey } from "./execution.ts";
import { createOwnerLocalActionPort } from "./local-action-port.ts";
import {
  createOwnerEffectClient,
  ownerEffectKey,
  type OwnerEffectOperation,
} from "./effects-client.ts";

const ref = (): RegisteredLocalActionReference => ({
  placement: "owner-local",
  ownerId: "owner",
  epoch: 1,
  holderId: "holder",
  attemptId: "attempt",
  namespace: "space",
  sourceEventId: "source",
  deliveryId: "delivery",
  kind: "action",
  actionId: "work",
  actionRunId: "run",
});
function gate<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
type Boundary = {
  -readonly [
    K in keyof Pick<
      OwnerCommandBoundary,
      "execute" | "executeInput" | "project"
    >
  ]: OwnerCommandBoundary[K];
};
function fixture(overrides: Partial<Boundary> = {}) {
  const reference = ref();
  const controlCaller: OwnerCaller = {
    principal: {
      kind: "owner-control",
      ownerId: "owner",
      epoch: 1,
      holderId: "holder",
    },
    ownerEpoch: 1,
    hostControl: "private-control",
  };
  const localCaller: OwnerCaller = {
    principal: {
      kind: "owner-local",
      ownerId: "owner",
      epoch: 1,
      holderId: "holder",
      deliveryId: "delivery",
      attemptId: "attempt",
    },
    ownerEpoch: 1,
    hostLocal: "private-local",
  };
  const calls: { who: OwnerCaller; command: unknown; signal?: AbortSignal }[] =
    [];
  const started: unknown[] = [], terminals: unknown[] = [];
  const state = { current: true };
  const projection = {
    reference,
    actionId: "work",
    namespace: "space",
    databaseSchema: "public",
    ownerId: "owner",
    input: null,
    invocation: {
      actionRunId: "run",
      rootKey: "root",
      operationKey: "run",
      metadata: {},
      identity: {
        causationId: "source",
        correlationId: "correlation",
        settlementScopeId: "scope",
      },
    },
  };
  const boundary: Boundary = {
    execute(who, command, options) {
      calls.push({ who, command, signal: options?.signal });
      return Promise.resolve({
        status: "committed",
        result: command.kind === "owner.local-start"
          ? { binding: structuredClone(reference), attempts: 1 }
          : null,
      });
    },
    executeInput(who, command, options) {
      calls.push({ who, command, signal: options?.signal });
      return Promise.resolve({
        status: "committed",
        result: {
          reference: structuredClone(reference),
          status:
            (command.input as { completion: { status: string } }).completion
              .status,
        },
      });
    },
    project(who, kind, input, options) {
      calls.push({ who, command: { kind, input }, signal: options?.signal });
      return Promise.resolve(
        structuredClone(
          kind === "execution.input"
            ? projection
            : { reference, cancellationRequested: false },
        ),
      );
    },
    ...overrides,
  };
  const options = {
    boundary,
    reference,
    controlCaller,
    localCaller,
    isCurrent: () => state.current,
    onStarted: (value: unknown) => {
      started.push(value);
    },
    onTerminal: (value: unknown) => {
      terminals.push(value);
    },
    maxPendingCalls: 2,
  };
  return {
    options,
    boundary,
    reference,
    controlCaller,
    localCaller,
    calls,
    started,
    terminals,
    state,
    projection,
    create: () => createOwnerLocalActionPort(options),
  };
}
const command: OwnerCommand = {
  kind: "collections",
  domain: "logical",
  key: "run/write",
  intent: { operations: [] },
};
const completion = { status: "completed", output: "done" } as const;

test("actual port binds exact start/input/Collection/state/normalized terminal coordinates", async () => {
  const f = fixture(), port = f.create();
  const start = port.start();
  assert.equal(port.start(), start);
  await start;
  assert.deepEqual(f.calls[0].who, f.controlCaller);
  assert.deepEqual(f.calls[0].command, {
    kind: "owner.local-start",
    domain: "incarnation",
    key: ownerLocalActionStartKey(ref()),
    intent: ref(),
  });
  assert.deepEqual(f.started, [ref()]);
  assert.deepEqual(await port.project(), f.projection);
  await port.execute(command);
  port.sealInvocationCalls();
  await assert.rejects(port.project(), /context_closed/);
  assert.deepEqual(await port.settlementState(), {
    reference: ref(),
    cancellationRequested: false,
  });
  const done = await port.complete(completion);
  assert.deepEqual(done, {
    status: "committed",
    result: { reference: ref(), status: "completed" },
  });
  assert.deepEqual(f.calls.at(-1)!.command, {
    kind: "execution.complete",
    domain: "logical",
    key: ownerCompletionKey("owner", "space", "run"),
    input: { namespace: "space", executionId: "run", completion },
  });
  for (const call of f.calls.slice(1)) {
    assert.deepEqual(call.who, f.localCaller);
  }
  for (const call of f.calls) {
    assert.equal(Object.hasOwn(call.who, "workerId"), false);
  }
  assert.equal(f.terminals.length, 1);
  await assert.rejects(port.complete(completion), /settlement_closed/);
  await port.drainRawCalls();
});

test("actual port captures methods, callers, hooks and reference once", async () => {
  const f = fixture();
  const original = f.boundary.execute;
  let bound = false;
  f.boundary.execute = function (...args) {
    bound = this === f.boundary;
    return original(...args);
  };
  const port = f.create();
  f.options.isCurrent = () => false;
  f.options.onStarted = () => {
    throw new Error("replaced hook");
  };
  f.boundary.execute = () => {
    throw new Error("replaced method");
  };
  (f.controlCaller as Record<string, unknown>).hostControl = "changed";
  (f.localCaller as Record<string, unknown>).hostLocal = "changed";
  // Keep fake response independent of the mutated construction reference.
  const oldReference = structuredClone(f.reference);
  (f.options as { reference: RegisteredLocalActionReference }).reference = {
    ...ref(),
    attemptId: "changed",
  };
  await port.start();
  assert.equal(bound, true);
  assert.equal(f.calls[0].who.hostControl, "private-control");
  await port.project();
  assert.equal(f.calls[1].who.hostLocal, "private-local");
  assert.deepEqual(f.started, [oldReference]);
});

for (
  const change of [
    (f: ReturnType<typeof fixture>) => {
      f.options.controlCaller = { ...f.controlCaller, ownerEpoch: 2 };
    },
    (f: ReturnType<typeof fixture>) => {
      f.options.localCaller = {
        ...f.localCaller,
        principal: {
          ...f.localCaller.principal,
          attemptId: "changed",
        } as OwnerCaller["principal"],
      };
    },
    (f: ReturnType<typeof fixture>) => {
      f.options.localCaller = { ...f.localCaller, workerId: "fake" };
    },
    (f: ReturnType<typeof fixture>) => {
      f.options.localCaller = {
        principal: { kind: "worker", workerId: "fake" },
        ownerEpoch: 1,
      };
    },
  ]
) {
  test("actual port rejects changed/mixed principal before submission", () => {
    const f = fixture();
    change(f);
    assert.throws(f.create);
    assert.equal(f.calls.length, 0);
  });
}

for (
  const result of [
    { status: "duplicate", result: { binding: ref(), attempts: 1 } },
    { status: "committed", result: { binding: ref(), attempts: 2 } },
    {
      status: "committed",
      result: { binding: { ...ref(), sourceEventId: "wrong" }, attempts: 1 },
    },
    {
      status: "committed",
      result: { binding: ref(), attempts: 1, extra: true },
    },
  ]
) {
  test("actual port requires a known fresh exact start and never retries it", async () => {
    let calls = 0;
    const f = fixture({
      execute: () => {
        calls++;
        return Promise.resolve(result as OwnerCommandOutcome);
      },
    });
    const port = f.create(), first = port.start();
    await assert.rejects(first, /indeterminate/);
    assert.equal(port.start(), first);
    await assert.rejects(port.start());
    assert.equal(calls, 1);
    assert.equal(f.started.length, 0);
  });
}

test("actual port rejects calls before start and disallowed commands without owner submission", async () => {
  const f = fixture(), port = f.create();
  await assert.rejects(port.project(), /context_closed/);
  await assert.rejects(port.settlementState(), /settlement_closed/);
  await port.start();
  for (
    const bad of [
      { ...command, kind: "execution.complete" },
      { ...command, domain: "occurrence" as const },
      { ...command, key: "run/" },
      { ...command, key: "other/write" },
      { ...command, workerId: "fake" },
    ]
  ) await assert.rejects(port.execute(bad));
  assert.equal(f.calls.length, 1);
  await assert.rejects(port.complete(completion), /completion_refused/);
});

test("private lifetime failures are irreversible, including thrown and nonliteral checks", async () => {
  for (const value of [false, 1, "true", new Error("broken private check")]) {
    const f = fixture();
    let fail = false;
    f.options.isCurrent = () => {
      if (!fail) return true;
      fail = false;
      if (value instanceof Error) throw value;
      return value as boolean;
    };
    const port = f.create();
    await port.start();
    fail = true;
    await assert.rejects(port.project(), /authority_lost/);
    await assert.rejects(port.settlementState(), /authority_lost/);
    assert.equal(f.calls.length, 1);
  }
});

test("raw committed start is recorded before a raced lifetime loss", async () => {
  const raw = gate<OwnerCommandOutcome>(),
    f = fixture({ execute: () => raw.promise }),
    port = f.create();
  const pending = port.start();
  await tick();
  f.state.current = false;
  raw.resolve({ status: "committed", result: { binding: ref(), attempts: 1 } });
  await assert.rejects(pending, /authority_lost/);
  assert.deepEqual(f.started, [ref()]);
  await port.drainRawCalls();
});

test("sealed/revoked raw calls stay charged until their original promise settles", async () => {
  const raw = gate<OwnerJson>(),
    f = fixture({ project: () => raw.promise }),
    port = f.create();
  await port.start();
  const running = port.project();
  port.sealInvocationCalls();
  f.state.current = false;
  let drained = false;
  const drain = port.drainRawCalls().then(() => {
    drained = true;
  });
  await tick();
  assert.equal(drained, false);
  raw.resolve(f.projection);
  await assert.rejects(running, /authority_lost/);
  await drain;
  assert.equal(drained, true);
});

test("raw admission is bounded synchronously and releases only on raw settlement", async () => {
  const raw = gate<OwnerJson>(), f = fixture({ project: () => raw.promise });
  f.options.maxPendingCalls = 1;
  const port = f.create();
  await port.start();
  const running = port.project();
  await assert.rejects(port.project(), /admission_refused/);
  raw.resolve(f.projection);
  await running;
  await port.project();
});

test("known ctx rejection preserves independent settlement, unknown outcome irreversibly quarantines", async () => {
  for (const sync of [false, true]) {
    let unknown = false;
    const f = fixture({
      project: (_who, kind) => {
        if (kind === "execution.local-settlement-state") {
          return Promise.resolve({
            reference: ref(),
            cancellationRequested: true,
          });
        }
        const error = Object.assign(
          new Error("denied"),
          unknown
            ? { code: "owner_commit_unknown" }
            : { code: "ActionOwnershipLost" },
        );
        if (sync) throw error;
        return Promise.reject(error);
      },
    });
    const port = f.create();
    await port.start();
    await assert.rejects(port.project(), /denied/);
    assert.equal((await port.settlementState()).cancellationRequested, true);
    unknown = true;
    await assert.rejects(port.project(), /indeterminate/);
    await assert.rejects(port.settlementState(), /indeterminate/);
  }
});

test("actual adapter never turns thrown cancellation or rollback-looking errors into a noncommit witness", async () => {
  for (
    const error of [
      new Error("ROLLBACK completed"),
      Object.assign(new Error("cancelled"), { code: "ActionOwnershipLost" }),
      Object.assign(new Error("unknown"), { code: "owner_commit_unknown" }),
    ]
  ) {
    let submissions = 0;
    const f = fixture({
        executeInput: () => {
          submissions++;
          return Promise.reject(error);
        },
      }),
      port = f.create();
    await port.start();
    port.sealInvocationCalls();
    await port.settlementState();
    await assert.rejects(port.complete(completion), /indeterminate/);
    await assert.rejects(
      port.complete({ status: "cancelled", code: "action_cancelled" }),
    );
    assert.equal(submissions, 1);
    assert.equal(f.terminals.length, 0);
  }
});

test("known terminal fact survives lifetime revocation while raw reply is pending", async () => {
  const raw = gate<OwnerCommandOutcome>(),
    f = fixture({ executeInput: () => raw.promise }),
    port = f.create();
  await port.start();
  port.sealInvocationCalls();
  const pending = port.complete(completion);
  f.state.current = false;
  raw.resolve({
    status: "committed",
    result: { reference: ref(), status: "completed" },
  });
  await assert.rejects(pending, /authority_lost/);
  assert.deepEqual(f.terminals, [{ reference: ref(), status: "completed" }]);
  await port.drainRawCalls();
});

test("malformed terminal and settlement replies quarantine without trusted facts", async () => {
  const f = fixture({
    executeInput: () =>
      Promise.resolve({
        status: "committed",
        result: {
          reference: { ...ref(), attemptId: "other" },
          status: "completed",
        },
      }),
  });
  const port = f.create();
  await port.start();
  port.sealInvocationCalls();
  await assert.rejects(port.complete(completion), /indeterminate/);
  assert.equal(f.terminals.length, 0);
  const g = fixture({
      project: () =>
        Promise.resolve({ reference: ref(), cancellationRequested: "true" }),
    }),
    other = g.create();
  await other.start();
  await assert.rejects(other.settlementState(), /indeterminate/);
});

test("faulty asynchronous private hooks cannot report early raw quiescence", async () => {
  const raw = gate<void>(), f = fixture();
  f.options.onStarted = () => raw.promise;
  const port = f.create();
  await assert.rejects(port.start(), /indeterminate/);
  let drained = false;
  const pending = port.drainRawCalls().then(() => {
    drained = true;
  });
  await tick();
  assert.equal(drained, false);
  raw.reject(new Error("late hook failure"));
  await pending;
});

test("requested start is synchronously charged and snapshots its original signal", async () => {
  const raw = gate<OwnerCommandOutcome>();
  let seen: AbortSignal | undefined;
  const f = fixture({
    execute(_who, _command, options) {
      seen = options?.signal;
      return raw.promise;
    },
  });
  const port = f.create(),
    original = new AbortController(),
    replacement = new AbortController();
  const options = { signal: original.signal };
  const start = port.start(options);
  options.signal = replacement.signal;
  let drained = false;
  const drain = port.drainRawCalls().then(() => {
    drained = true;
  });
  await tick();
  assert.equal(drained, false);
  replacement.abort();
  assert.equal(seen?.aborted, false);
  original.abort();
  assert.equal(seen?.aborted, true);
  raw.resolve({ status: "committed", result: { binding: ref(), attempts: 1 } });
  await start;
  await drain;
});

import { createOwnerCollectionCommand } from "../owner/collections.ts";
import { createPluginRegistry } from "../plugins/registry.ts";
import type { OwnerCommandContext } from "../owner/boundary.ts";
import type { SqlSession } from "../events/session.ts";
import type { DeliveryExecutor } from "../execution/types.ts";
const attempt = {
  placement: "owner-local" as const,
  ownerId: "owner",
  epoch: 1,
  holderId: "holder",
  attemptId: "attempt",
  namespace: "space",
  sourceEventId: "source",
  deliveryId: "delivery",
  kind: "action" as const,
  actionId: "work",
  actionRunId: "run",
};
const query = () => {
  throw new Error("unexpected SQL");
};
const tx = { query };
const session = { query, transaction: query } as unknown as SqlSession;
const executor = {
  scheduleDelivery() {},
  dispatchDelivery() {},
  dispatchRecoverable() {},
} as unknown as DeliveryExecutor;
const collectionNow = "2026-10-17T00:00:00Z";
const collectionContext: OwnerCommandContext = {
  tx,
  caller: {
    principal: {
      kind: "owner-local",
      ownerId: "owner",
      epoch: 1,
      holderId: "holder",
      deliveryId: "delivery",
      attemptId: "attempt",
    },
    ownerEpoch: 1,
  },
  command: { kind: "collections", domain: "logical", key: "run/write" },
  commandTime: collectionNow,
  signal: new AbortController().signal,
  ownerCommit: {
    transaction: tx,
    ownerId: "owner",
    epoch: 1,
    holderId: "holder",
    commandTime: collectionNow,
  },
  afterCommit() {},
};
for (const variant of ["attempt", "lease"]) {
  test(`Collection authority preserves forbidden undefined ${variant} field presence`, async () => {
    const command = createOwnerCollectionCommand({
      session,
      schema: "public",
      registry: createPluginRegistry({ plugins: [] }),
      collections: {},
      executor,
      scope: () => ({
        namespace: "space",
        attempt: variant === "attempt"
          ? { ...attempt, workerId: undefined }
          : attempt,
        identity: {
          deliveryLease: {
            deliveryId: "delivery",
            owner: "attempt",
            ...(variant === "lease" ? { extra: undefined } : {}),
          },
        },
      }),
    });
    await assert.rejects(
      async () => await command({ operations: [] }, collectionContext),
      /authority|match|Invalid|JSON/,
      variant,
    );
  });
}

test("completion validation uses the submitted snapshot after an awaited reply", async () => {
  const raw = gate<OwnerCommandOutcome>();
  let observed: OwnerInputCommand | undefined;
  const f = fixture({
    executeInput(_who, command) {
      observed = command;
      return raw.promise;
    },
  });
  const port = f.create();
  await port.start();
  port.sealInvocationCalls();
  const mutable = {
    status: "completed" as const,
    output: { value: "original" },
  };
  const done = port.complete(mutable);
  mutable.output.value = "changed";
  Object.assign(mutable, { status: "failed" });
  raw.resolve({
    status: "committed",
    result: { reference: ref(), status: "completed" },
  });
  const result = await done;
  assert.equal(result.status, "committed");
  assert.deepEqual((observed!.input as { completion: unknown }).completion, {
    status: "completed",
    output: { value: "original" },
  });
  assert.deepEqual(f.terminals, [{ reference: ref(), status: "completed" }]);
});

test("error accessors cannot turn an uncertain raw outcome into safe settlement", async () => {
  let invoked = false;
  const error = Object.defineProperty(new Error("malformed error"), "code", {
    get() {
      invoked = true;
      throw new Error("reader broke");
    },
  });
  const f = fixture({ project: () => Promise.reject(error) }),
    port = f.create();
  await port.start();
  await assert.rejects(port.project(), /indeterminate/);
  await assert.rejects(port.settlementState(), /indeterminate/);
  assert.equal(invoked, false);
});

import { defineAction } from "../actions/define.ts";
import { defineCollection } from "../collections/definition.ts";
import { createRegisteredLocalActionExecution } from "../execution/registered-local.ts";

test("unfrozen local driver keeps construction/projection/capability/receipt references detached", async () => {
  const submitted: OwnerCommand[] = [];
  const stableProjection = fixture().projection;
  const f = fixture({
    execute(_who, command) {
      submitted.push(structuredClone(command));
      return Promise.resolve({
        status: "committed",
        result: command.kind === "owner.local-start"
          ? { binding: ref(), attempts: 1 }
          : null,
      });
    },
    project(_who, kind) {
      return Promise.resolve(
        kind === "execution.input"
          ? stableProjection
          : { reference: ref(), cancellationRequested: false },
      );
    },
    executeInput() {
      return Promise.resolve({
        status: "committed",
        result: { reference: ref(), status: "completed" },
      });
    },
  });
  const port = f.create();
  const notes = defineCollection({
    name: "note",
    schema: {
      type: "object",
      properties: { title: { type: "string" } },
    } as const,
  });
  const action = defineAction({
    id: "work",
    async execute(_input, ctx) {
      await ctx.transaction(async ({ collections }) => {
        await collections.notes.create({ title: "original" });
      }, { operationKey: "write" });
      return "done";
    },
  });
  const registry = createPluginRegistry({
    actions: { work: action },
    collections: { notes },
  });
  const driver = createRegisteredLocalActionExecution({
    registry,
    reference: f.reference,
    owner: port,
    isCurrent: () => true,
    onIndeterminate() {},
    createCapabilities(context) {
      Object.assign(context.reference, {
        attemptId: "changed-capability",
        sourceEventId: "changed-capability",
      });
      Object.assign(context.invocation.invocation, {
        actionRunId: "changed-capability",
        operationKey: "changed-capability",
      });
      Object.assign(stableProjection.reference, {
        sourceEventId: "changed-projection",
      });
      return { resources: {}, adapters: {} };
    },
  });
  Object.assign(f.reference, {
    attemptId: "changed-construction",
    sourceEventId: "changed-construction",
  });
  const result = await driver.run();
  await driver.quiescent;
  assert.deepEqual(submitted[0].intent, ref());
  assert.equal(submitted[1].key, "run/write");
  assert.deepEqual(result.receipt.reference, ref());
  Object.assign(result.receipt.reference, { attemptId: "changed-result" });
  assert.deepEqual(f.terminals, [{ reference: ref(), status: "completed" }]);
  assert.equal(driver.run(), driver.run());
  assert.equal(submitted.length, 2);
});

for (const phase of ["start", "terminal"] as const) {
  test(`local Action ${phase} hook retains occupancy before reentrant raw drain`, async () => {
    const f = fixture(), held = gate<void>();
    let drained = false;
    let drain: Promise<void> | undefined;
    const port = createOwnerLocalActionPort({
      ...f.options,
      [phase === "start" ? "onStarted" : "onTerminal"]() {
        drain = port.drainRawCalls().then(() => {
          drained = true;
        });
        return held.promise;
      },
    });
    if (phase === "terminal") {
      await port.start();
      await port.project();
      port.sealInvocationCalls();
    }
    await assert.rejects(
      phase === "start"
        ? port.start()
        : port.complete({ status: "completed", output: null }),
      /indeterminate/,
    );
    await tick();
    assert.equal(
      drained,
      false,
      "a receipt hook cannot report drain before its returned work settles",
    );
    held.resolve();
    await drain;
    assert.equal(drained, true);
  });
}

const effectRef = () => ({
  namespace: "space",
  actionRunId: "run",
  step: "send",
});
function effectCommand(operation: OwnerEffectOperation): OwnerCommand {
  return {
    kind: `effect.${operation}`,
    domain: "logical",
    key: ownerEffectKey("owner", effectRef(), operation),
    intent: {
      ...effectRef(),
      ...(operation === "confirm"
        ? { outcome: { sent: true } }
        : operation === "notStarted"
        ? { evidence: { source: "fixture", reference: "no-start" } }
        : {}),
    },
  };
}
function effectFixture() {
  const f = fixture();
  const execute = f.boundary.execute, project = f.boundary.project;
  f.boundary.execute = (who, command, options) => {
    if (command.kind === "owner.local-start") {
      return execute(who, command, options);
    }
    f.calls.push({ who, command, signal: options?.signal });
    return Promise.resolve({
      status: "committed",
      result: {
        ...effectRef(),
        status: command.kind === "effect.begin"
          ? "begun"
          : command.kind === "effect.confirm"
          ? "confirmed"
          : "not_started",
        ...(command.kind === "effect.confirm"
          ? { outcome: { sent: true } }
          : {}),
      },
    });
  };
  f.boundary.project = (who, kind, input, options) => {
    if (kind !== "effect.state") return project(who, kind, input, options);
    f.calls.push({ who, command: { kind, input }, signal: options?.signal });
    return Promise.resolve({
      ...effectRef(),
      status: "confirmed",
      outcome: { sent: true },
    });
  };
  return f;
}

test("local effect routes use the exact local caller and preserve separate settlement", async () => {
  const f = effectFixture(), port = f.create();
  assert.ok(port.effects);
  const client = createOwnerEffectClient({
    ownerId: "owner",
    ...effectRef(),
    port: port.effects,
  });
  await assert.rejects(client.begin("send"), /closed/);
  assert.equal(f.calls.length, 0);
  await port.start();
  assert.deepEqual(await client.begin("send"), { status: "proceed" });
  await client.confirm("send", { sent: true });
  await client.notStarted("send", { source: "fixture", reference: "no-start" });
  assert.deepEqual(await client.inspect("send"), {
    status: "replay",
    outcome: { sent: true },
  });
  for (const call of f.calls.slice(1)) {
    assert.deepEqual(call.who, f.localCaller);
  }
  port.sealInvocationCalls();
  await assert.rejects(client.begin("send"), /closed/);
  await client.confirm("send", { sent: true });
  await port.complete(completion);
  await assert.rejects(client.confirm("send", { sent: true }), /closed/);
});

test("local effects refuse foreign references, keys and routes before owner submission", async () => {
  const f = effectFixture(), port = f.create();
  await port.start();
  const original = effectCommand("begin");
  for (
    const value of [
      { ...original, kind: "collections" },
      { ...original, domain: "occurrence" },
      { ...original, key: "other" },
      { ...original, intent: { ...effectRef(), actionRunId: "other" } },
      { ...original, intent: { ...effectRef(), namespace: "other" } },
      { ...original, intent: { ...effectRef(), workerId: "forged" } },
    ]
  ) {
    await assert.rejects(async () =>
      await port.effects!.execute(value as OwnerCommand)
    );
  }
  await assert.rejects(async () => await port.effects!.settle(original));
  await assert.rejects(port.effects!.project("execution.input", effectRef()));
  let getters = 0;
  const accessor = Object.defineProperty(effectCommand("confirm"), "kind", {
    enumerable: true,
    get() {
      getters++;
      return "effect.confirm";
    },
  });
  await assert.rejects(async () => await port.effects!.settle(accessor));
  assert.equal(getters, 0);
  assert.equal(f.calls.length, 1);
});

test("held local effect begin shares raw capacity and cannot expose proceed after sealing", async () => {
  const raw = gate<OwnerCommandOutcome>(), f = effectFixture();
  const execute = f.boundary.execute;
  f.boundary.execute = (who, command, options) =>
    command.kind === "effect.begin"
      ? raw.promise
      : execute(who, command, options);
  f.options.maxPendingCalls = 1;
  const port = f.create();
  await port.start();
  let exposed = false;
  const pending = port.effects!.execute(effectCommand("begin")).then(
    (value) => {
      exposed = true;
      return value;
    },
  );
  void pending.catch(() => undefined);
  await assert.rejects(port.project(), /admission_refused/);
  port.sealInvocationCalls();
  let drained = false;
  const drain = port.drainRawCalls().then(() => {
    drained = true;
  });
  await tick();
  assert.equal(drained, false);
  assert.equal(exposed, false);
  await assert.rejects(port.complete(completion), /completion_refused/);
  raw.resolve({
    status: "committed",
    result: { ...effectRef(), status: "begun" },
  });
  await assert.rejects(pending, /closed/);
  await drain;
  assert.equal(exposed, false);
  assert.equal(drained, true);
});

for (const operation of ["begin", "confirm", "notStarted"] as const) {
  test(`local effect ${operation} unknown result quarantines without a retry`, async () => {
    const f = effectFixture();
    const execute = f.boundary.execute;
    let submissions = 0;
    f.boundary.execute = (who, command, options) => {
      if (command.kind === `effect.${operation}`) {
        submissions++;
        return Promise.reject(
          Object.assign(new Error("lost effect COMMIT reply"), {
            outcome: "unknown",
          }),
        );
      }
      return execute(who, command, options);
    };
    const port = f.create();
    await port.start();
    const send = () =>
      operation === "begin"
        ? port.effects!.execute(effectCommand(operation))
        : port.effects!.settle(effectCommand(operation));
    await assert.rejects(send(), /indeterminate/);
    await assert.rejects(send(), /indeterminate/);
    await assert.rejects(port.settlementState(), /indeterminate/);
    await port.drainRawCalls();
    assert.equal(submissions, 1);
  });
}

for (const kind of ["begin", "confirm", "state"] as const) {
  test(`malformed local effect ${kind} reply quarantines its exact attempt`, async () => {
    const f = effectFixture(), execute = f.boundary.execute;
    const malformed = {
      ...effectRef(),
      actionRunId: "foreign",
      status: "begun",
    };
    f.boundary.execute = (who, command, options) =>
      command.kind.startsWith("effect.")
        ? Promise.resolve({ status: "committed", result: malformed })
        : execute(who, command, options);
    f.boundary.project = () => Promise.resolve(malformed);
    const port = f.create();
    await port.start();
    await assert.rejects(
      kind === "state"
        ? port.effects!.project("effect.state", effectRef())
        : kind === "begin"
        ? port.effects!.execute(effectCommand("begin"))
        : port.effects!.settle(effectCommand("confirm")),
      /indeterminate/,
    );
    await assert.rejects(port.settlementState(), /indeterminate/);
  });
}

test("local effect settlement cannot start while terminal completion is pending", async () => {
  const raw = gate<OwnerCommandOutcome>(), f = effectFixture();
  f.boundary.executeInput = () => raw.promise;
  const port = f.create();
  await port.start();
  port.sealInvocationCalls();
  const pending = port.complete(completion);
  await assert.rejects(
    port.effects!.settle(effectCommand("confirm")),
    /closed/,
  );
  await assert.rejects(
    port.effects!.project("effect.state", effectRef()),
    /closed/,
  );
  raw.resolve({
    status: "committed",
    result: { reference: ref(), status: "completed" },
  });
  await pending;
});

test("local action Collection read retains raw occupancy and suppresses revoked reply", async () => {
  const response = gate<OwnerJson>();
  const f = fixture();
  const original = f.boundary.project;
  let received: unknown;
  f.boundary.project = (caller, kind, input, options) => {
    if (kind !== "collections.read") {
      return original(caller, kind, input, options);
    }
    received = input;
    return response.promise;
  };
  const port = f.create();
  await port.start();
  await port.project();
  const request = {
    collectionAlias: "notes",
    operation: "get" as const,
    id: "a",
  };
  const pending = port.readCollection!(request, {}).then(
    () => "disclosed",
    () => "refused",
  );
  request.id = "changed";
  assert.deepEqual(received, {
    collectionAlias: "notes",
    operation: "get",
    id: "a",
  });
  port.sealInvocationCalls();
  let drained = false;
  const drain = port.drainRawCalls().then(() => {
    drained = true;
  });
  await tick();
  assert.equal(drained, false);
  f.state.current = false;
  response.resolve(null);
  assert.equal(await pending, "refused");
  await drain;
  assert.equal(drained, true);
  await assert.rejects(port.readCollection!(request, {}));
});
