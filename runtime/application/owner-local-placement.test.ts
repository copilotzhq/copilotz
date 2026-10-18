import { defineAction } from "../actions/define.ts";
import { createPluginRegistry } from "../plugins/registry.ts";
import { createRegisteredLocalActionExecution } from "../execution/registered-local.ts";
import { createOwnerLocalActionPort } from "../owner/local-action-port.ts";
import { ownerLocalActionStartKey } from "../owner/execution.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createOwnerLocalPlacementController,
  type OwnerLocalPlacementEntry,
} from "./owner-local-placement.ts";
import type {
  OwnerCaller,
  OwnerCommand,
  OwnerCommandBoundary,
  OwnerCommandContext,
  OwnerCommandOutcome,
} from "../owner/boundary.ts";
import type { SqlExecutor } from "../events/session.ts";
import type { OwnerLocalActionAssignmentBinding } from "../owner/placement-binding.ts";

const ref = (): OwnerLocalActionAssignmentBinding => ({
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
const tx = () =>
  ({
    query: () => Promise.reject(new Error("No SQL in pure test.")),
  }) as SqlExecutor;
const time = "2026-10-17T00:00:00.000Z";
const key = "trusted-owner-start-key";
function command(reference = ref()): OwnerCommand {
  return {
    kind: "owner.local-start",
    domain: "incarnation",
    key,
    intent: reference,
  };
}
function committed(): OwnerCommandOutcome {
  return { status: "committed", result: { binding: ref(), attempts: 1 } };
}
function context(transaction: SqlExecutor = tx()): OwnerCommandContext {
  return {
    tx: transaction,
    caller: {
      principal: { kind: "worker", workerId: "real-worker" },
      ownerEpoch: 1,
    },
    command: {
      kind: "collections",
      domain: "logical",
      key: "unrelated-command",
    },
    commandTime: time,
    signal: new AbortController().signal,
    ownerCommit: {
      transaction,
      ownerId: "owner",
      epoch: 1,
      holderId: "holder",
      commandTime: time,
    },
    afterCommit() {},
  };
}
function fixture() {
  let current: unknown = true;
  let capacity = 1;
  let reserves = 0;
  let releases = 0;
  let starts = 0;
  let revokes = 0;
  const raw = gate<OwnerCommandOutcome>();
  const drained = gate<void>();
  const transaction = tx();
  const contexts = new WeakSet<object>();
  const control: OwnerCaller = {
    principal: {
      kind: "owner-control",
      ownerId: "owner",
      epoch: 1,
      holderId: "holder",
    },
    ownerEpoch: 1,
    privateHostControl: "real-host-control-witness",
  };
  let currentHook: (() => void) | undefined;
  let beforeStart: (() => void) | undefined;
  let afterAuthorize: (() => void) | undefined;
  let authorize = true;
  let beforeReserve: (() => void) | undefined;
  let releaseResult: unknown;
  const boundary: { execute: OwnerCommandBoundary["execute"] } = {
    execute(caller, submitted) {
      starts++;
      beforeStart?.();
      if (authorize) {
        assert.equal(
          controller.authorizeStart(
            transaction,
            caller,
            submitted.intent as OwnerLocalActionAssignmentBinding,
            time,
          ),
          true,
        );
      }
      afterAuthorize?.();
      return raw.promise;
    },
  };
  const shared = {
    reserve(_reference: OwnerLocalActionAssignmentBinding) {
      reserves++;
      beforeReserve?.();
      if (!capacity) return undefined;
      capacity--;
      return {
        release() {
          releases++;
          capacity++;
          return releaseResult as void;
        },
      };
    },
  };
  const options = {
    controlCaller: control,
    boundary,
    capacity: shared,
    maxEntries: 10,
    isCurrent() {
      currentHook?.();
      if (current instanceof Error) throw current;
      return current as boolean;
    },
  };
  const controller = createOwnerLocalPlacementController(options);
  const driver = {
    quiescent: drained.promise,
    revoke() {
      revokes++;
    },
  };
  const reserve = () => {
    const entry = controller.reserve(ref(), key);
    entry.attachDriver(driver);
    return entry;
  };
  const authenticate = (ctx = context()) => {
    contexts.add(ctx);
    return ctx;
  };
  return {
    controller,
    options,
    boundary,
    shared,
    control,
    driver,
    reserve,
    raw,
    drained,
    transaction,
    authenticate,
    start(entry: OwnerLocalPlacementEntry) {
      return entry.executeStart(entry.controlCaller, command());
    },
    onCurrent(callback: () => void) {
      currentHook = callback;
    },
    setCurrent(value: unknown) {
      current = value;
    },
    setAuthorize(value: boolean) {
      authorize = value;
    },
    beforeStart(callback: () => void) {
      beforeStart = callback;
    },
    afterAuthorize(callback: () => void) {
      afterAuthorize = callback;
    },
    beforeReserve(callback: () => void) {
      beforeReserve = callback;
    },
    setReleaseResult(value: unknown) {
      releaseResult = value;
    },
    stats: () => ({ capacity, reserves, releases, starts, revokes }),
  };
}
async function started(
  f: ReturnType<typeof fixture>,
  entry: OwnerLocalPlacementEntry,
) {
  const pending = f.start(entry);
  f.raw.resolve(committed());
  await pending;
  entry.onStarted(ref());
}

test("local placement reserves shared capacity before factory/start and denies duplicate selection", () => {
  const f = fixture();
  const entry = f.controller.reserve(ref(), key);
  assert.equal(f.stats().capacity, 0);
  assert.equal(f.stats().starts, 0);
  assert.throws(() => f.controller.reserve(ref(), key));
  assert.equal(f.stats().reserves, 1);
  assert.equal(f.controller.resolveCurrentLocal(entry.localCaller), undefined);
  assert.equal(
    f.controller.authorizeStart(
      f.transaction,
      entry.controlCaller,
      ref(),
      time,
    ),
    false,
  );
});

test("local placement shares worker occupancy and never allocates a second independent quota", () => {
  const f = fixture();
  const workerSlot = f.shared.reserve(ref())!;
  assert.throws(() => f.controller.reserve(ref(), key), /capacity/);
  assert.equal(f.stats().starts, 0);
  workerSlot.release();
  f.reserve();
  assert.equal(f.stats().capacity, 0);
});

test("local placement publishes start one-shot before same-stack reentrant calls", async () => {
  const f = fixture();
  const entry = f.reserve();
  let reentrant: Promise<OwnerCommandOutcome> | undefined;
  f.beforeStart(() => {
    reentrant = f.start(entry);
  });
  const pending = f.start(entry);
  assert.equal(reentrant, pending);
  assert.equal(f.stats().starts, 1);
  f.raw.resolve(committed());
  await pending;
  assert.equal(f.start(entry), pending);
  assert.equal(f.stats().starts, 1);
});

test("local placement pending start authorization never opens local context", async () => {
  const f = fixture();
  const entry = f.reserve();
  f.afterAuthorize(() => {
    assert.equal(
      f.controller.resolveCurrentLocal(entry.localCaller),
      undefined,
    );
    assert.equal(f.stats().capacity, 0);
  });
  const pending = f.start(entry);
  f.raw.resolve(committed());
  await pending;
});

test("local placement held committed reply grants neither local context nor release", async () => {
  const f = fixture();
  const entry = f.reserve();
  const pending = f.start(entry);
  // Exact durable post-commit facts are supplied by the future host. The raw
  // reply is deliberately held; this test proves only controller consumption.
  const later = f.authenticate(context(tx()));
  assert.notEqual(later.tx, f.transaction);

  assert.equal(f.controller.resolveCurrentLocal(entry.localCaller), undefined);
  assert.equal(f.stats().releases, 0);
  f.raw.resolve(committed());
  await pending;

  assert.equal(f.controller.resolveCurrentLocal(entry.localCaller), undefined);
  entry.onStarted(ref());

  assert.deepEqual(f.controller.resolveCurrentLocal(entry.localCaller), ref());
  assert.equal(f.stats().releases, 0);
});

test("local placement authorizes only exact pending start caller, transaction and command time", async () => {
  const f = fixture();
  const entry = f.reserve();
  const pending = f.start(entry);
  assert.equal(
    f.controller.authorizeStart(
      f.transaction,
      entry.controlCaller,
      ref(),
      time,
    ),
    true,
  );
  assert.equal(
    f.controller.authorizeStart(tx(), entry.controlCaller, ref(), time),
    false,
  );
  assert.equal(
    f.controller.authorizeStart(
      f.transaction,
      entry.controlCaller,
      ref(),
      "later",
    ),
    false,
  );
  assert.equal(
    f.controller.authorizeStart(f.transaction, f.control, ref(), time),
    false,
  );
  assert.equal(
    f.controller.authorizeStart(f.transaction, entry.localCaller, ref(), time),
    false,
  );
  assert.equal(
    f.controller.authorizeStart(f.transaction, entry.controlCaller, {
      ...ref(),
      sourceEventId: "other",
    }, time),
    false,
  );
  f.raw.resolve(committed());
  await pending;
  assert.equal(
    f.controller.authorizeStart(
      f.transaction,
      entry.controlCaller,
      ref(),
      time,
    ),
    false,
  );
});

test("local placement rejects exact-looking start without actual authorization provenance", async () => {
  const f = fixture();
  f.setAuthorize(false);
  const entry = f.reserve();
  const pending = f.start(entry);
  f.raw.resolve(committed());
  await assert.rejects(pending, /authorized fresh/);

  assert.throws(() => entry.onStarted(ref()));
  f.drained.resolve();
  await tick();
  assert.equal(f.stats().releases, 0);
});

for (const outcome of ["duplicate", "malformed", "unknown", "rejection"]) {
  test(`local placement ${outcome} start stays charged and never opens`, async () => {
    const f = fixture();
    const entry = f.reserve();
    const pending = f.start(entry);
    if (outcome === "rejection" || outcome === "unknown") {
      f.raw.reject(Object.assign(new Error(outcome), { outcome }));
    } else if (outcome === "duplicate") {
      f.raw.resolve({ ...committed(), status: "duplicate" });
    } else {f.raw.resolve({
        status: "committed",
        result: { binding: ref(), attempts: 2 },
      });}
    await assert.rejects(pending);
    f.drained.resolve();
    await tick();
    assert.equal(f.stats().releases, 0);
    assert.equal(
      f.controller.resolveCurrentLocal(entry.localCaller),
      undefined,
    );

    assert.equal(f.start(entry), pending);
    assert.equal(f.stats().starts, 1);
  });
}

test("local placement known terminal waits for actual quiescence and releases exactly once", async () => {
  const f = fixture();
  const entry = f.reserve();
  await started(f, entry);
  entry.onTerminal({ reference: ref(), status: "completed" });
  assert.equal(entry.isCurrent(), true); // The adapter still checks its lifetime after this hook.
  assert.equal(f.stats().releases, 0);
  assert.equal(f.controller.resolveCurrentLocal(entry.localCaller), undefined);
  f.drained.resolve();
  await tick();
  assert.equal(f.stats().releases, 1);
  entry.onTerminal({ reference: ref(), status: "completed" });
  f.controller.stop();
  await tick();
  assert.equal(f.stats().releases, 1);
  assert.throws(() => f.controller.reserve(ref(), key));
});

test("local placement drained or revoked work without known terminal stays charged", async () => {
  const f = fixture();
  const entry = f.reserve();
  await started(f, entry);
  entry.revoke();
  f.drained.resolve();
  await tick();
  assert.equal(f.stats().releases, 0);
  assert.equal(f.controller.resolveCurrentLocal(entry.localCaller), undefined);
});

test("local placement records known raw terminal after revocation without reviving authority", async () => {
  const f = fixture();
  const entry = f.reserve();
  const pending = f.start(entry);
  entry.revoke();
  f.raw.resolve(committed());
  await pending;
  entry.onStarted(ref());
  assert.equal(f.controller.resolveCurrentLocal(entry.localCaller), undefined);
  entry.onTerminal({ reference: ref(), status: "cancelled" });
  assert.equal(f.stats().releases, 0);
  f.drained.resolve();
  await tick();
  assert.equal(f.stats().releases, 1);
  assert.equal(entry.isCurrent(), false);
});

for (const loss of [false, 1, new Error("private check threw")]) {
  test(`local placement latches private-current loss ${String(loss)}`, async () => {
    const f = fixture();
    const entry = f.reserve();
    await started(f, entry);
    f.setCurrent(loss);
    assert.equal(entry.isCurrent(), false);
    f.setCurrent(true);
    assert.equal(entry.isCurrent(), false);
    assert.equal(
      f.controller.resolveCurrentLocal(entry.localCaller),
      undefined,
    );
    assert.throws(() =>
      f.controller.reserve({ ...ref(), deliveryId: "next" }, key)
    );
    assert.equal(f.stats().releases, 0);
  });
}

test("local placement captures callbacks and detaches all public authority snapshots", async () => {
  const f = fixture();
  const input = ref();
  const entry = f.controller.reserve(input, key);
  Object.assign(input, { sourceEventId: "changed" });
  Object.assign(entry.reference, { attemptId: "changed" });
  Object.assign(entry.controlCaller, { localPlacementStart: "changed" });
  Object.assign(entry.localCaller.principal, { deliveryId: "changed" });
  Object.assign(f.control, { privateHostControl: "changed" });
  f.boundary.execute = () => Promise.reject(new Error("replaced boundary"));
  f.options.isCurrent = () => false;
  f.shared.reserve = () => {
    throw new Error("replaced allocator");
  };
  entry.attachDriver(f.driver);
  f.driver.revoke = () => {
    throw new Error("replaced revoke");
  };
  await started(f, entry);
  const resolved = f.controller.resolveCurrentLocal(entry.localCaller)!;
  Object.assign(resolved, { sourceEventId: "changed" });
  assert.deepEqual(f.controller.resolveCurrentLocal(entry.localCaller), ref());

  // Changing outward methods must not change private stop/revocation behavior.
  Object.assign(entry, { revoke: () => {} });
  f.controller.stop();
  assert.equal(entry.isCurrent(), false);
  assert.equal(f.stats().revokes, 1);
});

test("local placement exact local witness is required after start", async () => {
  const f = fixture();
  const entry = f.reserve();
  await started(f, entry);
  const caller = { ...entry.localCaller };
  delete caller.localPlacementAttempt;
  assert.equal(f.controller.resolveCurrentLocal(caller), undefined);
  assert.equal(
    f.controller.resolveCurrentLocal(entry.controlCaller),
    undefined,
  );
  caller.localPlacementAttempt = "invented";
  assert.equal(f.controller.resolveCurrentLocal(caller), undefined);
});

test("local placement rejects early/foreign terminal and retains occupancy", async () => {
  const f = fixture();
  const entry = f.reserve();
  assert.throws(() =>
    entry.onTerminal({ reference: ref(), status: "completed" })
  );
  f.drained.resolve();
  await tick();
  assert.equal(f.stats().releases, 0);
});

test("local placement raw start cannot be admitted without attached driver lifetime", async () => {
  const f = fixture();
  const entry = f.controller.reserve(ref(), key);
  await assert.rejects(f.start(entry), /lifetime/);
  assert.equal(f.stats().starts, 0);
  assert.equal(f.stats().releases, 0);
  assert.throws(() => entry.attachDriver(f.driver));
});

test("local placement captures start signal without executing accessors", async () => {
  const f = fixture();
  const entry = f.reserve();
  let reads = 0;
  await assert.rejects(entry.executeStart(entry.controlCaller, command(), {
    get signal() {
      reads++;
      return new AbortController().signal;
    },
  }));
  assert.equal(reads, 0);
  assert.equal(f.stats().starts, 0);
  const pending = f.start(entry);
  f.raw.resolve(committed());
  await pending;
});

test("local placement allocation reentrancy cannot select the same delivery twice", () => {
  const f = fixture();
  f.beforeReserve(() => {
    assert.throws(() => f.controller.reserve(ref(), key));
  });
  f.reserve();
  assert.equal(f.stats().reserves, 1);
  assert.equal(f.stats().capacity, 0);
});

test("local placement allocator throw cannot masquerade as a no-allocation result", () => {
  const f = fixture();
  f.beforeReserve(() => {
    throw new Error("Shared capacity unavailable.");
  });
  assert.throws(() => f.controller.reserve(ref(), key));
  f.beforeReserve(() => {});
  assert.throws(() => f.controller.reserve(ref(), key));
  assert.equal(f.stats().reserves, 1);
});

test("local placement stop during reservation retains capacity and never starts", async () => {
  const f = fixture();
  f.beforeReserve(() => f.controller.stop());
  const entry = f.controller.reserve(ref(), key);
  assert.equal(entry.isCurrent(), false);
  assert.throws(() => entry.attachDriver(f.driver));
  await assert.rejects(f.start(entry));
  assert.equal(f.stats().capacity, 0);
  assert.equal(f.stats().releases, 0);
});

test("local placement malformed hook data irreversibly closes private authority", async () => {
  const f = fixture();
  const entry = f.reserve();
  await started(f, entry);
  let getters = 0;
  assert.throws(() =>
    entry.onTerminal({
      get reference() {
        getters++;
        return ref();
      },
      status: "completed",
    })
  );
  assert.equal(getters, 0);
  assert.equal(entry.isCurrent(), false);
  assert.equal(f.controller.resolveCurrentLocal(entry.localCaller), undefined);
  entry.onTerminal({ reference: ref(), status: "completed" });
  f.drained.resolve();
  await tick();
  assert.equal(f.stats().releases, 0);
});

test("local placement quiescence without terminal closes authority and retains capacity", async () => {
  const f = fixture();
  const entry = f.reserve();
  await started(f, entry);
  f.drained.resolve();
  await tick();
  assert.equal(entry.isCurrent(), false);
  assert.equal(f.controller.resolveCurrentLocal(entry.localCaller), undefined);

  assert.equal(f.stats().releases, 0);
});

test("local placement invalid release result is attempted once and stops new admission", async () => {
  const f = fixture();
  const entry = f.reserve();
  await started(f, entry);
  f.setReleaseResult(Promise.resolve());
  entry.onTerminal({ reference: ref(), status: "completed" });
  f.drained.resolve();
  await tick();
  assert.equal(f.stats().releases, 1);
  entry.onTerminal({ reference: ref(), status: "completed" });
  assert.equal(f.stats().releases, 1);
  assert.throws(() =>
    f.controller.reserve({ ...ref(), deliveryId: "next" }, key)
  );
});

function neutralFixture(
  options: {
    unknownCompletion?: boolean;
    heldFactory?: ReturnType<
      typeof gate<
        { resources: Record<string, never>; adapters: Record<string, never> }
      >
    >;
  } = {},
) {
  let releases = 0;
  let starts = 0;
  let invoked = 0;
  let completions = 0;
  const transaction = tx();
  const boundary: Pick<
    OwnerCommandBoundary,
    "execute" | "executeInput" | "project"
  > = {
    execute(caller, cmd) {
      starts++;
      assert.equal(
        controller.authorizeStart(
          transaction,
          caller,
          cmd.intent as OwnerLocalActionAssignmentBinding,
          time,
        ),
        true,
      );
      return Promise.resolve(committed());
    },
    executeInput(_caller, cmd) {
      completions++;
      if (options.unknownCompletion) {
        return Promise.reject(new Error("reply lost"));
      }
      return Promise.resolve({
        status: "committed",
        result: {
          reference: ref(),
          status: (cmd.input as {
            completion: { status: "completed" | "failed" | "cancelled" };
          }).completion.status,
        },
      });
    },
    project(_caller, kind) {
      if (kind === "execution.local-settlement-state") {
        return Promise.resolve({
          reference: ref(),
          cancellationRequested: false,
        });
      }
      return Promise.resolve({
        reference: ref(),
        actionId: "work",
        input: { ordinary: true },
        namespace: "space",
        databaseSchema: "public",
        ownerId: "owner",
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
      });
    },
  };
  const controller = createOwnerLocalPlacementController({
    controlCaller: {
      principal: {
        kind: "owner-control",
        ownerId: "owner",
        epoch: 1,
        holderId: "holder",
      },
      ownerEpoch: 1,
      privateHostControl: "host",
    },
    boundary,
    isCurrent: () => true,
    maxEntries: 1,
    capacity: {
      reserve() {
        return {
          release() {
            releases++;
          },
        };
      },
    },
  });
  const entry = controller.reserve(ref(), ownerLocalActionStartKey(ref()));
  const port = createOwnerLocalActionPort({
    reference: entry.reference,
    controlCaller: entry.controlCaller,
    localCaller: entry.localCaller,
    boundary: {
      execute: entry.executeStart,
      executeInput: boundary.executeInput,
      project: boundary.project,
    },
    isCurrent: entry.isCurrent,
    onStarted: entry.onStarted,
    onTerminal: entry.onTerminal,
  });
  const execution = createRegisteredLocalActionExecution({
    registry: createPluginRegistry({
      actions: {
        work: defineAction({
          id: "work",
          execute(input: unknown) {
            invoked++;
            return input;
          },
        }),
      },
    }),
    reference: entry.reference,
    owner: port,
    isCurrent: entry.isCurrent,
    createCapabilities() {
      return options.heldFactory?.promise ?? { resources: {}, adapters: {} };
    },
    onIndeterminate: () => entry.revoke(),
  });
  entry.attachDriver(execution);
  return {
    controller,
    entry,
    execution,
    stats: () => ({ starts, invoked, completions, releases }),
  };
}

test("local placement actual neutral driver and bound port return success before releasing the quiescent terminal", async () => {
  const f = neutralFixture();
  const result = await f.execution.run();
  assert.equal(result.status, "executed");
  await f.execution.quiescent;
  await tick();
  assert.deepEqual(f.stats(), {
    starts: 1,
    invoked: 1,
    completions: 1,
    releases: 1,
  });
  assert.equal(f.entry.isCurrent(), false);
  assert.throws(() =>
    f.controller.reserve({ ...ref(), deliveryId: "next" }, key)
  );
});

test("local placement actual driver unknown completion drains without a fabricated terminal or release", async () => {
  const f = neutralFixture({ unknownCompletion: true });
  await assert.rejects(f.execution.run());
  await f.execution.quiescent;
  await tick();
  assert.deepEqual(f.stats(), {
    starts: 1,
    invoked: 1,
    completions: 1,
    releases: 0,
  });
  assert.equal(f.entry.isCurrent(), false);
});

test("local placement actual driver retains a revoked noncooperative factory until it really ends", async () => {
  const heldFactory = gate<
    { resources: Record<string, never>; adapters: Record<string, never> }
  >();
  const f = neutralFixture({ heldFactory });
  const pending = f.execution.run();
  const rejected = assert.rejects(pending);
  await tick();
  f.entry.revoke();
  let drained = false;
  f.execution.quiescent.then(() => {
    drained = true;
  });
  await tick();
  assert.equal(drained, false);
  assert.equal(f.stats().releases, 0);
  heldFactory.resolve({ resources: {}, adapters: {} });
  await rejected;
  await f.execution.quiescent;
  assert.deepEqual(f.stats(), {
    starts: 1,
    invoked: 0,
    completions: 0,
    releases: 0,
  });
});

test("local placement captures returned capacity release identity before mutation", async () => {
  const f = fixture();
  // The captured allocator invokes this method with its original object, so a
  // new controller is needed to inspect the independently returned reservation.
  let releases = 0;
  const reservation = {
    release() {
      releases++;
    },
  };
  const transaction = tx();
  const controller = createOwnerLocalPlacementController({
    controlCaller: f.control,
    maxEntries: 1,
    isCurrent: () => true,
    capacity: { reserve: () => reservation },
    boundary: {
      execute(caller, cmd) {
        assert.equal(
          controller.authorizeStart(
            transaction,
            caller,
            cmd.intent as OwnerLocalActionAssignmentBinding,
            time,
          ),
          true,
        );
        return Promise.resolve(committed());
      },
    },
  });
  const entry = controller.reserve(ref(), key);
  reservation.release = () => {
    throw new Error("replacement");
  };
  entry.attachDriver(f.driver);
  await entry.executeStart(entry.controlCaller, command());
  entry.onStarted(ref());
  entry.onTerminal({ reference: ref(), status: "completed" });
  f.drained.resolve();
  await tick();
  assert.equal(releases, 1);
});

test("local placement rejects async capacity with no unhandled rejection or retry", async () => {
  const f = fixture();
  const controller = createOwnerLocalPlacementController({
    ...f.options,
    capacity: {
      reserve: (() =>
        Promise.reject(
          new Error("async allocator"),
        )) as unknown as typeof f.options.capacity.reserve,
    },
  });
  assert.throws(() => controller.reserve(ref(), key), /Synchronous/);
  assert.throws(() => controller.reserve(ref(), key), /selection/);
  await tick();
});

test("local placement exact command refusal does not invoke the raw start", async () => {
  const f = fixture();
  const entry = f.reserve();
  for (
    const change of [
      (value: OwnerCommand) => {
        Object.assign(value, { kind: "execution.complete" });
      },
      (value: OwnerCommand) => {
        Object.assign(value, { domain: "logical" });
      },
      (value: OwnerCommand) => {
        Object.assign(value, { key: "other" });
      },
      (value: OwnerCommand) => {
        Object.assign(value.intent!, { sourceEventId: "other" });
      },
    ]
  ) {
    const value = command();
    change(value);
    await assert.rejects(entry.executeStart(entry.controlCaller, value));
  }
  await assert.rejects(entry.executeStart(f.control, command()));
  assert.equal(f.stats().starts, 0);
  await started(f, entry);
  assert.equal(f.stats().starts, 1);
});

test("local placement raw start rejection preserves charged capacity", async () => {
  const f = fixture();
  const entry = f.reserve();
  const pending = f.start(entry);

  f.raw.reject(new Error("start rejected"));
  await assert.rejects(pending);

  assert.equal(f.stats().releases, 0);
});

test("local placement rechecks revocation after the owner current callback", async () => {
  const f = fixture();
  const entry = f.reserve();
  await started(f, entry);
  f.onCurrent(() => entry.revoke(new Error("revoked during current check")));
  assert.equal(f.controller.resolveCurrentLocal(entry.localCaller), undefined);
  assert.equal(f.stats().revokes, 1);
});

test("captured local Action lifetime uses invocation signal without retiring settlement", async () => {
  const f = fixture(), invocation = new AbortController();
  Object.assign(f.driver, { invocationSignal: invocation.signal });
  const entry = f.reserve();
  assert.equal(
    f.controller.captureCurrentLifetime(entry.localCaller),
    undefined,
  );
  await started(f, entry);
  const caller = entry.localCaller,
    lifetime = f.controller.captureCurrentLifetime(caller)!;
  assert.ok(lifetime);
  Object.assign(caller, { localPlacementAttempt: "changed" });
  assert.equal(lifetime.isCurrent(), true);
  assert.equal(lifetime.matches(caller), false);
  assert.equal(lifetime.matches(entry.localCaller), true);
  invocation.abort();
  assert.equal(lifetime.signal.aborted, true);
  assert.equal(lifetime.isCurrent(), false);
  assert.equal(lifetime.matches(entry.localCaller), false);
  assert.equal(entry.isCurrent(), true);
  assert.deepEqual(f.controller.resolveCurrentLocal(entry.localCaller), ref());
  assert.equal(f.stats().releases, 0);
  f.controller.stop();
  f.drained.resolve();
  await tick();
});
test("local Action signal getter cannot attach a driver after revoking the entry", () => {
  const f = fixture(), entry = f.controller.reserve(ref(), key);
  assert.throws(() =>
    entry.attachDriver({
      ...f.driver,
      get invocationSignal() {
        entry.revoke();
        return new AbortController().signal;
      },
    })
  );
  assert.equal(
    f.controller.captureCurrentLifetime(entry.localCaller),
    undefined,
  );
  assert.equal(f.stats().releases, 0);
});
test("current callback cannot end an Action invocation and preserve captured read authority", async () => {
  const f = fixture(), invocation = new AbortController();
  Object.assign(f.driver, { invocationSignal: invocation.signal });
  const entry = f.reserve();
  await started(f, entry);
  const lifetime = f.controller.captureCurrentLifetime(entry.localCaller)!;
  f.onCurrent(() =>
    entry.onTerminal({ reference: ref(), status: "completed" })
  );
  assert.equal(lifetime.isCurrent(), false);
  assert.equal(lifetime.matches(entry.localCaller), false);
  assert.equal(
    f.controller.captureCurrentLifetime(entry.localCaller),
    undefined,
  );
  assert.equal(entry.isCurrent(), true);
  assert.equal(f.stats().releases, 0);
  f.controller.stop();
  f.drained.resolve();
  await tick();
});
