import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  OwnerCaller,
  OwnerCommand,
  OwnerCommandBoundary,
  OwnerCommandOutcome,
  OwnerJson,
} from "./boundary.ts";
import type { OwnerLocalProcessorAssignmentBinding } from "./placement-binding.ts";
import {
  ownerLocalProcessorCompletionKey,
  type OwnerLocalProcessorProjection,
  ownerLocalProcessorStartKey,
} from "./processor.ts";
import { createOwnerLocalProcessorPort } from "./local-processor-port.ts";

const ref = (): OwnerLocalProcessorAssignmentBinding => ({
  placement: "owner-local",
  kind: "processor",
  ownerId: "owner",
  epoch: 1,
  holderId: "holder",
  attemptId: "attempt",
  namespace: "space",
  sourceEventId: "event",
  deliveryId: "delivery",
  processorId: "observe",
  consumerId: "processor:observe",
});
function gate<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const tick = () => new Promise<void>((done) => setTimeout(done, 0));
type Boundary = {
  -readonly [K in keyof Pick<OwnerCommandBoundary, "execute" | "project">]:
    OwnerCommandBoundary[K];
};
function fixture(overrides: Partial<Boundary> = {}, ordinal = 2) {
  const reference = ref();
  const controlCaller: OwnerCaller = {
    principal: {
      kind: "owner-control",
      ownerId: "owner",
      epoch: 1,
      holderId: "holder",
    },
    ownerEpoch: 1,
    controlWitness: "private",
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
    localWitness: "private",
  };
  const state = { current: true };
  const calls: { who: OwnerCaller; command: unknown }[] = [];
  const starts: unknown[] = [], ends: unknown[] = [];
  const projection: OwnerLocalProcessorProjection = {
    reference,
    processorId: "observe",
    ownerId: "owner",
    namespace: "space",
    databaseSchema: "public",
    deliveryId: "delivery",
    attempts: ordinal,
    maxAttempts: 3,
    operationKey: "delivery:delivery",
    identity: {
      causationId: "event",
      correlationId: "correlation",
      settlementScopeId: "scope",
    },
    event: {
      durable: true,
      id: "event",
      ownerId: "owner",
      position: "1",
      seq: "1",
      schemaVersion: 1,
      type: "source",
      namespace: "space",
      correlationId: "correlation",
      payload: {},
      metadata: {},
      data: {},
      createdAt: "2026-10-17T00:00:00.000Z",
    },
  };
  const boundary: Boundary = {
    execute(who, command) {
      calls.push({ who, command });
      if (command.kind === "owner.local-processor-start") {
        return Promise.resolve({
          status: "committed",
          result: { binding: structuredClone(reference), attempts: ordinal },
        });
      }
      if (command.kind === "processor.local-complete") {
        const completion = (command.intent as {
          completion: { status: string; retryable?: boolean };
        }).completion;
        return Promise.resolve({
          status: "committed",
          result: {
            reference: structuredClone(reference),
            attempts: ordinal,
            ...(completion.status === "failed"
              ? completion.retryable && ordinal < 3
                ? {
                  status: "retry_wait",
                  availableAt: "2026-10-17 00:00:00.123456+00",
                }
                : { status: "dead_letter" }
              : { status: completion.status }),
          },
        });
      }
      return Promise.resolve({ status: "committed", result: null });
    },
    project(who, name, intent) {
      calls.push({ who, command: { name, intent } });
      return Promise.resolve(
        name === "processor.local-input"
          ? structuredClone(projection) as unknown as OwnerJson
          : {
            reference: structuredClone(reference),
            cancellationRequested: false,
          },
      );
    },
    ...overrides,
  };
  const options = {
    boundary,
    reference,
    attemptOrdinal: ordinal,
    controlCaller,
    localCaller,
    isCurrent: () => state.current,
    onStarted: (r: unknown) => {
      starts.push(r);
    },
    onEnded: (r: unknown) => {
      ends.push(r);
    },
  };
  return {
    reference,
    state,
    calls,
    starts,
    ends,
    projection,
    boundary,
    options,
    create: () => createOwnerLocalProcessorPort(options),
  };
}
const command = (): OwnerCommand => ({
  kind: "collections",
  domain: "logical",
  key: "delivery:delivery:write",
  intent: { operations: [] },
});

test("local Processor port binds start, input, Collection calls and ended retry receipt", async () => {
  const f = fixture(), port = f.create();
  const first = port.start();
  assert.equal(port.start(), first);
  await first;
  const value = await port.project();
  assert.equal(value.attempts, 2);
  await port.execute(command());
  port.sealInvocationCalls();
  await port.drainRawCalls();
  assert.equal((await port.settlementState()).cancellationRequested, false);
  const ended = await port.complete({
    status: "failed",
    code: "retry",
    retryable: true,
  });
  assert.equal(ended.status, "committed");
  assert.deepEqual(ended.result, {
    reference: ref(),
    attempts: 2,
    status: "retry_wait",
    availableAt: "2026-10-17 00:00:00.123456+00",
  });
  assert.deepEqual(f.starts, [{ binding: ref(), attempts: 2 }]);
  assert.deepEqual(f.ends, [ended.result]);
  assert.deepEqual(f.calls[0].command, {
    kind: "owner.local-processor-start",
    domain: "incarnation",
    key: ownerLocalProcessorStartKey(ref()),
    intent: ref(),
  });
  assert.deepEqual(f.calls.at(-1)?.command, {
    kind: "processor.local-complete",
    domain: "incarnation",
    key: ownerLocalProcessorCompletionKey(ref()),
    intent: {
      reference: ref(),
      completion: { status: "failed", code: "retry", retryable: true },
    },
  });
  assert.equal(f.calls[0].who.controlWitness, "private");
  assert.equal(f.calls[1].who.localWitness, "private");
  await assert.rejects(port.project(), /closed/);
  await assert.rejects(port.complete({ status: "succeeded" }), /closed/);
});

test("local Processor start refuses duplicate, wrong ordinal and substituted binding", async () => {
  for (
    const result of [
      { status: "duplicate", result: { binding: ref(), attempts: 2 } },
      { status: "committed", result: { binding: ref(), attempts: 1 } },
      {
        status: "committed",
        result: { binding: { ...ref(), attemptId: "other" }, attempts: 2 },
      },
    ]
  ) {
    const f = fixture({
      execute: () => Promise.resolve(result as OwnerCommandOutcome),
    });
    const port = f.create();
    await assert.rejects(port.start(), /indeterminate/);
    assert.equal(f.starts.length, 0);
    await assert.rejects(port.project(), /indeterminate/);
  }
});

test("local Processor port rejects non-Collection and wrong delivery commands before dispatch", async () => {
  const f = fixture(), port = f.create();
  await port.start();
  for (
    const changed of [
      { kind: "processor.local-complete" },
      { domain: "incarnation" },
      { key: "delivery:delivery-other:write" },
      { key: "delivery:delivery:" },
      { key: "other/write" },
    ]
  ) {
    await assert.rejects(
      port.execute({ ...command(), ...changed } as OwnerCommand),
      /command_refused/,
    );
  }
  assert.equal(f.calls.length, 1);
});

test("local Processor admission is bounded and reserves before reentrant drain", async () => {
  const held = gate<OwnerJson>(),
    f = fixture();
  const port = createOwnerLocalProcessorPort({
    ...f.options,
    maxPendingCalls: 1,
    boundary: {
      ...f.boundary,
      project() {
        return held.promise;
      },
    },
  });
  await port.start();
  const pending = port.project();
  await assert.rejects(port.execute(command()), /admission_refused/);
  port.sealInvocationCalls();
  let drained = false;
  const drain = port.drainRawCalls().then(() => {
    drained = true;
  });
  await tick();
  assert.equal(drained, false);
  held.resolve(f.projection as unknown as OwnerJson);
  await assert.rejects(pending, /closed/);
  await drain;
  assert.equal(drained, true);
});

test("local Processor start publishes one-shot promise and occupancy before raw reentrancy", async () => {
  const f = fixture(), held = gate<OwnerCommandOutcome>();
  let nested: ReturnType<typeof port.start> | undefined;
  let drained = false;
  let drain: Promise<void> | undefined;
  f.boundary.execute = () => {
    nested = port.start();
    drain = port.drainRawCalls().then(() => {
      drained = true;
    });
    return held.promise;
  };
  const port = f.create();
  const first = port.start();
  assert.equal(nested, first);
  await tick();
  assert.equal(drained, false);
  held.resolve({
    status: "committed",
    result: { binding: ref(), attempts: 2 },
  });
  await first;
  await drain;
  assert.equal(drained, true);
});

test("known local Processor receipts reach detached hooks before raced revocation", async () => {
  for (const phase of ["start", "end"] as const) {
    const f = fixture(),
      held = gate<OwnerCommandOutcome>(),
      original = f.boundary.execute;
    f.boundary.execute = (who, command, options) =>
      command.kind ===
          (phase === "start"
            ? "owner.local-processor-start"
            : "processor.local-complete")
        ? held.promise
        : original(who, command, options);
    const port = f.create();
    if (phase === "end") {
      await port.start();
      await port.project();
      port.sealInvocationCalls();
    }
    const running = phase === "start"
      ? port.start()
      : port.complete({ status: "succeeded" });
    f.state.current = false;
    held.resolve({
      status: "committed",
      result: phase === "start"
        ? { binding: ref(), attempts: 2 }
        : { reference: ref(), attempts: 2, status: "succeeded" },
    });
    await assert.rejects(running, /authority_lost|indeterminate/);
    assert.equal(phase === "start" ? f.starts.length : f.ends.length, 1);
    await port.drainRawCalls();
  }
});

test("local Processor malformed projections and retry receipts quarantine the port", async () => {
  for (
    const malformed of [
      "projection",
      "ordinal",
      "date",
      "array-status",
      "extra-time",
      "exhausted",
    ]
  ) {
    const f = fixture({}, malformed === "exhausted" ? 3 : 2),
      execute = f.boundary.execute,
      project = f.boundary.project;
    if (malformed === "projection") {
      f.boundary.project = () =>
        Promise.resolve(
          {
            ...f.projection,
            event: { ...f.projection.event, metadata: [] },
          } as unknown as OwnerJson,
        );
    } else {f.boundary.execute = (who, command, options) =>
        command.kind !== "processor.local-complete"
          ? execute(who, command, options)
          : Promise.resolve({
            status: "committed",
            result: {
              reference: ref(),
              attempts: malformed === "ordinal" ? 1 : f.options.attemptOrdinal,
              status: malformed === "array-status"
                ? ["retry_wait"]
                : malformed === "extra-time"
                ? "succeeded"
                : "retry_wait",
              availableAt: malformed === "date"
                ? "2026-02-30T00:00:00Z"
                : "2026-10-17 00:00:00.123456+00",
            },
          });}
    const port = f.create();
    await port.start();
    if (malformed === "projection") {
      await assert.rejects(port.project(), /indeterminate/);
    } else {
      await port.project();
      port.sealInvocationCalls();
      await assert.rejects(
        port.complete(
          malformed === "extra-time"
            ? { status: "succeeded" }
            : { status: "failed", code: "retry", retryable: true },
        ),
        /indeterminate/,
      );
    }
    assert.equal(f.ends.length, 0);
    await assert.rejects(port.settlementState(), /indeterminate/);
    void project;
  }
});

test("local Processor async or throwing hooks cannot fabricate activation or quiescence", async () => {
  for (const phase of ["start", "end"] as const) {
    const f = fixture(), held = gate<void>();
    const options = {
      ...f.options,
      [phase === "start" ? "onStarted" : "onEnded"]: () => held.promise,
    };
    const port = createOwnerLocalProcessorPort(options);
    if (phase === "end") {
      await port.start();
      await port.project();
      port.sealInvocationCalls();
    }
    await assert.rejects(
      phase === "start" ? port.start() : port.complete({ status: "succeeded" }),
      /indeterminate/,
    );
    let drained = false;
    const drain = port.drainRawCalls().then(() => {
      drained = true;
    });
    await tick();
    assert.equal(drained, false);
    held.resolve();
    await drain;
    assert.equal(drained, true);
  }
});

test("local Processor port validates omitted-only limits and exact private principals", () => {
  const f = fixture();
  for (const value of [null, undefined, 0, 129, 1.5]) {
    assert.throws(() =>
      createOwnerLocalProcessorPort({
        ...f.options,
        maxPendingCalls: value as number,
      })
    );
  }
  for (const value of [0, NaN, 1.5]) {
    assert.throws(() =>
      createOwnerLocalProcessorPort({ ...f.options, attemptOrdinal: value })
    );
  }
  assert.throws(() =>
    createOwnerLocalProcessorPort({
      ...f.options,
      localCaller: { ...f.options.localCaller, workerId: "worker" },
    })
  );
  assert.throws(() =>
    createOwnerLocalProcessorPort({
      ...f.options,
      reference: { ...ref(), consumerId: "processor:other" },
    })
  );
});

test("local Processor hooks are charged before their own reentrant drain", async () => {
  const f = fixture(), held = gate<void>();
  let drained = false,
    drain: Promise<void> | undefined;
  const port = createOwnerLocalProcessorPort({
    ...f.options,
    onStarted() {
      drain = port.drainRawCalls().then(() => {
        drained = true;
      });
      return held.promise;
    },
  });
  await assert.rejects(port.start(), /indeterminate/);
  await tick();
  assert.equal(
    drained,
    false,
    "a hook's raw promise must be included in a reentrant drain",
  );
  held.resolve();
  await drain;
  assert.equal(drained, true);
});

test("local Processor private current failure is sticky for throws and nonliteral grants", async () => {
  for (const value of [false, 1, "true", new Error("broken current")]) {
    const f = fixture();
    let fail = false;
    const port = createOwnerLocalProcessorPort({
      ...f.options,
      isCurrent() {
        if (!fail) return true;
        fail = false;
        if (value instanceof Error) throw value;
        return value as boolean;
      },
    });
    await port.start();
    fail = true;
    await assert.rejects(port.project(), /authority_lost/);
    await assert.rejects(port.execute(command()), /authority_lost/);
    await assert.rejects(port.settlementState(), /authority_lost/);
    assert.equal(f.calls.length, 1);
  }
});

test("local Processor port captures options and isolates private hook snapshots", async () => {
  const f = fixture();
  const original = structuredClone(f.reference);
  const options = {
    ...f.options,
    onStarted(receipt) {
      f.starts.push(structuredClone(receipt));
      (receipt.binding as { attemptId: string }).attemptId = "changed";
    },
    onEnded(receipt) {
      f.ends.push(structuredClone(receipt));
      (receipt.reference as { attemptId: string }).attemptId = "changed";
    },
  } satisfies Parameters<typeof createOwnerLocalProcessorPort>[0];
  const port = createOwnerLocalProcessorPort(options);
  options.reference = { ...original, attemptId: "replacement" };
  options.attemptOrdinal = 99;
  options.isCurrent = () => false;
  options.onStarted = () => {
    throw new Error("replaced");
  };
  options.onEnded = () => {
    throw new Error("replaced");
  };
  f.boundary.execute = () => {
    throw new Error("replaced boundary");
  };
  f.boundary.project = () => {
    throw new Error("replaced boundary");
  };
  options.controlCaller = { ...f.options.controlCaller, ownerEpoch: 2 };
  options.localCaller = { ...f.options.localCaller, ownerEpoch: 2 };
  await port.start();
  await port.project();
  port.sealInvocationCalls();
  const result = await port.complete({ status: "succeeded" });
  assert.notEqual(result.status, "not-committed");
  if (result.status === "not-committed") throw new Error("unexpected");
  assert.deepEqual(result.result.reference, original);
  assert.equal(f.starts.length, 1);
  assert.equal(f.ends.length, 1);
});
