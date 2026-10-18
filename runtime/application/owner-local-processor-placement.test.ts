import { createOwnerLocalProcessorPort } from "../owner/local-processor-port.ts";
import { ownerLocalProcessorStartKey } from "../owner/processor.ts";
import { createRegisteredLocalProcessorExecution } from "../execution/registered-local-processor.ts";
import { defineProcessor } from "../plugins/processor.ts";
import { createPluginRegistry } from "../plugins/registry.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createOwnerLocalProcessorPlacementController,
  type OwnerLocalProcessorPlacementEntry,
} from "./owner-local-processor-placement.ts";
import type { OwnerLocalProcessorAssignmentBinding } from "../owner/placement-binding.ts";
import type {
  OwnerLocalProcessorAttemptReceipt,
  OwnerLocalProcessorStartFacts,
  OwnerLocalProcessorStartReceipt,
} from "../owner/processor.ts";
import type {
  OwnerCaller,
  OwnerCommand,
  OwnerCommandContext,
  OwnerCommandOutcome,
} from "../owner/boundary.ts";
import type { SqlExecutor } from "../events/session.ts";
const time = "2026-10-17T00:00:00.000Z",
  due = "2026-10-17 00:00:01.123456+00",
  key = "private-start-key";
const ref = (
  attemptId = "attempt-1",
): OwnerLocalProcessorAssignmentBinding => ({
  placement: "owner-local",
  kind: "processor",
  ownerId: "owner",
  epoch: 1,
  holderId: "holder",
  attemptId,
  namespace: "space",
  sourceEventId: "event",
  deliveryId: "delivery",
  processorId: "observe",
  consumerId: "processor:observe",
});
function gate<T = void>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const tick = () => new Promise<void>((done) => setTimeout(done, 0));
const tx = (): SqlExecutor => ({
  query() {
    throw new Error("Pure fixture cannot access SQL");
  },
});
const command = (
  reference: OwnerLocalProcessorAssignmentBinding,
): OwnerCommand => ({
  kind: "owner.local-processor-start",
  domain: "incarnation",
  key,
  intent: reference,
});
function fixture(maxEntries = 8) {
  const control: OwnerCaller = {
    principal: {
      kind: "owner-control",
      ownerId: "owner",
      epoch: 1,
      holderId: "holder",
    },
    ownerEpoch: 1,
    privateControl: "host",
  };
  const transaction = tx(),
    contexts = new WeakSet<object>(),
    drains = new Map<string, ReturnType<typeof gate<void>>>();
  const state: {
    owner: boolean;
    slots: number;
    reserves: number;
    releases: number;
    starts: number;
    revokes: number;
    facts: OwnerLocalProcessorStartFacts;
    ownerHook?: () => boolean;
    reserveHook?: () => void;
    releaseHook?: () => unknown;
    releaseGetter: boolean;
    releaseReads: number;
    retiredHook?: (
      tx: SqlExecutor,
      ref: OwnerLocalProcessorAssignmentBinding,
      time: string,
    ) => boolean | Promise<boolean>;
    heldStart?: ReturnType<typeof gate<OwnerCommandOutcome>>;
    proofs: unknown[];
    outcome?: OwnerCommandOutcome;
  } = {
    owner: true,
    slots: 1,
    reserves: 0,
    releases: 0,
    starts: 0,
    revokes: 0,
    facts: {
      status: "pending",
      attempts: 0,
      maxAttempts: 3,
      availableAt: time,
    },
    proofs: [],
    releaseGetter: false,
    releaseReads: 0,
  };
  const options = {
    controlCaller: control,
    maxEntries,
    isCurrent: () => state.owner && (state.ownerHook?.() ?? true),
    capacity: {
      reserve() {
        if (state.slots === 0) return undefined;
        state.slots--;
        state.reserves++;
        state.reserveHook?.();
        const release = () => {
          state.releases++;
          state.slots++;
          return state.releaseHook?.() as void;
        };
        const allocation = { release };
        if (state.releaseGetter) {
          Object.defineProperty(allocation, "release", {
            get() {
              state.releaseReads++;
              return release;
            },
          });
        }
        return allocation;
      },
    },
    predecessorRetired(
      transaction: SqlExecutor,
      reference: OwnerLocalProcessorAssignmentBinding,
      time: string,
    ) {
      state.proofs.push({
        transaction,
        reference: structuredClone(reference),
        time,
      });
      return state.retiredHook?.(transaction, reference, time) ?? true;
    },
    boundary: {
      async execute(
        caller: OwnerCaller,
        command: OwnerCommand,
      ): Promise<OwnerCommandOutcome> {
        state.starts++;
        const reference = command
          .intent as OwnerLocalProcessorAssignmentBinding;
        const grant = await controller.authorizeStart(
          transaction,
          caller,
          reference,
          state.facts,
          time,
        );
        if (!grant) throw new Error("Start authorization refused");
        return state.heldStart
          ? await state.heldStart.promise
          : state.outcome ??
            {
              status: "committed",
              result: { binding: reference, attempts: grant.attemptOrdinal },
            };
      },
    },
  };
  const controller: ReturnType<
    typeof createOwnerLocalProcessorPlacementController
  > = createOwnerLocalProcessorPlacementController(options);
  const entry = (reference = ref(), invocationSignal?: AbortSignal) => {
    const e = controller.reserve(reference, key), drain = gate();
    drains.set(reference.attemptId, drain);
    e.attachDriver({
      invocationSignal,
      quiescent: drain.promise,
      revoke() {
        state.revokes++;
      },
    });
    return e;
  };
  const start = async (e: OwnerLocalProcessorPlacementEntry) => {
    const result = await e.executeStart(e.controlCaller, command(e.reference));
    e.onStarted(result.result as OwnerLocalProcessorStartReceipt);
    return result;
  };
  const end = (
    e: OwnerLocalProcessorPlacementEntry,
    status: OwnerLocalProcessorAttemptReceipt["status"] = "retry_wait",
  ) => {
    const receipt: OwnerLocalProcessorAttemptReceipt = {
      reference: e.reference,
      attempts: e.attemptOrdinal,
      ...(status === "retry_wait" ? { status, availableAt: due } : { status }),
    };
    e.onEnded(receipt);
    return receipt;
  };
  const drained = async (e: OwnerLocalProcessorPlacementEntry) => {
    drains.get(e.reference.attemptId)!.resolve();
    await tick();
  };
  const context = () => {
    const transaction = tx();
    const c: OwnerCommandContext = {
      tx: transaction,
      caller: control,
      command: { kind: "alarm", domain: "incarnation", key: "scan" },
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
    contexts.add(c);
    return c;
  };
  const retryFacts = (receipt: OwnerLocalProcessorAttemptReceipt) => {
    if (receipt.status !== "retry_wait") throw new Error("retry required");
    state.facts = {
      status: "retry_wait",
      attempts: receipt.attempts,
      maxAttempts: 3,
      availableAt: receipt.availableAt,
    };
  };
  return {
    controller,
    options,
    state,
    entry,
    start,
    end,
    drained,
    context,
    retryFacts,
    transaction,
    drains,
  };
}

test("Processor reservation grants neither a start nor NULL-lease ownership", async () => {
  const f = fixture(), e = f.entry();
  assert.equal(
    await f.controller.authorizeStart(
      f.transaction,
      e.controlCaller,
      e.reference,
      f.state.facts,
      time,
    ),
    undefined,
  );

  assert.equal(f.controller.resolveCurrent(e.localCaller), undefined);
  assert.equal(
    f.controller.isCurrent(e.controlCaller, e.reference, 1, "start"),
    false,
  );
  assert.equal(f.state.starts, 0);
  assert.equal(f.state.proofs.length, 0);
});

test("Processor retry requires known end, irrevocable drain and released capacity", async () => {
  const f = fixture(), first = f.entry();
  await f.start(first);
  const receipt = f.end(first);
  assert.throws(() => f.entry(ref("attempt-2")), /eligible generation/);
  assert.equal(f.state.releases, 0);
  assert.equal(f.controller.resolveCurrent(first.localCaller), undefined);
  await f.drained(first);
  const wake = await first.released;
  assert.deepEqual(wake, receipt);
  assert.equal(first.isCurrent(), false);
  assert.equal(f.state.releases, 1);
  (wake.reference as { attemptId: string }).attemptId = "changed-copy";
  f.retryFacts(receipt);
  const second = f.entry(ref("attempt-2"));
  assert.equal(second.attemptOrdinal, 2);
  await f.start(second);
  assert.deepEqual(f.state.proofs, [{
    transaction: f.transaction,
    reference: ref(),
    time,
  }]);
  assert.deepEqual(f.controller.resolveCurrent(second.localCaller), {
    reference: ref("attempt-2"),
    attemptOrdinal: 2,
  });
  first.onEnded(receipt);
  assert.equal(second.isCurrent(), true);
  assert.equal(f.state.releases, 1);
  assert.equal(f.controller.resolveCurrent(first.localCaller), undefined);
  f.end(second, "succeeded");
  await f.drained(second);
  assert.equal((await second.released).status, "succeeded");
  assert.throws(() => f.entry(ref("attempt-3")), /eligible generation/);
  assert.equal(f.state.releases, 2);
});

test("Processor held start reply grants no active context before known acknowledgement", async () => {
  const f = fixture(), e = f.entry();
  f.state.heldStart = gate();
  const running = f.start(e);
  await tick();

  assert.equal(f.controller.resolveCurrent(e.localCaller), undefined);
  f.state.heldStart.resolve({
    status: "committed",
    result: { binding: e.reference, attempts: 1 },
  });
  await running;

  f.end(e, "succeeded");
  await f.drained(e);
});

test("Processor current rechecks entry revocation caused by the owner callback", async () => {
  for (const phase of ["current", "resolve", "start"]) {
    const f = fixture(), e = f.entry();
    if (phase !== "start") await f.start(e);
    f.state.ownerHook = () => {
      e.revoke();
      return true;
    };
    if (phase === "current") assert.equal(e.isCurrent(), false);
    if (phase === "resolve") {
      assert.equal(f.controller.resolveCurrent(e.localCaller), undefined);
    }
    if (phase === "start") await assert.rejects(f.start(e), /lifetime closed/);
    f.state.ownerHook = undefined;
    assert.equal(e.isCurrent(), false);
  }
});

test("Processor owner loss during capacity reservation cannot open the charged entry", () => {
  const f = fixture();
  f.state.reserveHook = () => f.controller.stop();
  const e = f.entry;
  assert.throws(() => e(), /attachment refused/);
  assert.equal(f.state.reserves, 1);
  assert.equal(f.state.releases, 0);
  assert.equal(f.state.starts, 0);
});

test("Processor retirement proof is exact and is rechecked after an await", async () => {
  for (const mode of ["false", "throw", "revoke", "stop"]) {
    const f = fixture(), first = f.entry();
    await f.start(first);
    const receipt = f.end(first);
    await f.drained(first);
    f.retryFacts(receipt);
    const held = gate<boolean>(), second = f.entry(ref("attempt-2"));
    f.state.retiredHook = (txValue, previous, timeValue) => {
      assert.equal(txValue, f.transaction);
      assert.deepEqual(previous, ref());
      assert.equal(timeValue, time);
      if (mode === "false") return false;
      if (mode === "throw") throw new Error("proof failed");
      return held.promise;
    };
    const rejected = assert.rejects(f.start(second), /authorization refused/);
    await tick();
    if (mode === "revoke") second.revoke();
    if (mode === "stop") f.controller.stop();
    held.resolve(true);
    await rejected;
    assert.equal(f.controller.resolveCurrent(second.localCaller), undefined);
    assert.equal(f.state.releases, 1);
  }
});

test("Processor due time must match the private ended receipt without millisecond rounding", async () => {
  const f = fixture(), first = f.entry();
  await f.start(first);
  const receipt = f.end(first);
  await f.drained(first);
  f.retryFacts(receipt);
  f.state.facts = {
    ...f.state.facts,
    availableAt: "2026-10-17 00:00:01.123457+00",
  };
  const second = f.entry(ref("attempt-2"));
  await assert.rejects(f.start(second), /authorization refused/);
  assert.equal(f.state.proofs.length, 0);
  assert.equal(f.state.releases, 1);
});

test("Processor generations preserve all binding coordinates and retain global attempt tombstones", async () => {
  const f = fixture(), first = f.entry();
  await f.start(first);
  const receipt = f.end(first);
  await f.drained(first);
  f.retryFacts(receipt);
  for (
    const changed of [
      { namespace: "other" },
      { sourceEventId: "other" },
      { processorId: "other", consumerId: "processor:other" },
      { epoch: 2 },
      { holderId: "other" },
      { ownerId: "other" },
    ]
  ) {
    assert.throws(
      () => f.entry({ ...ref("attempt-2"), ...changed }),
      /eligible generation/,
    );
  }
  assert.throws(
    () => f.entry({ ...ref(), deliveryId: "other" }),
    /eligible generation/,
  );
  assert.equal(f.state.reserves, 1);
});

test("Processor bounded history never evicts completed or uncertain generations", async () => {
  const f = fixture(1), first = f.entry();
  await f.start(first);
  f.end(first, "succeeded");
  await f.drained(first);
  assert.throws(
    () => f.entry({ ...ref("new"), deliveryId: "other" }),
    /eligible generation/,
  );
  assert.equal(f.state.reserves, 1);
});

test("Processor release exceptions and asynchronous release never authorize a successor", async () => {
  for (const mode of ["throw", "async"]) {
    const f = fixture(), first = f.entry();
    await f.start(first);
    const receipt = f.end(first);
    let notified = false;
    void first.released.then(() => {
      notified = true;
    });
    f.state.releaseHook = () => {
      if (mode === "throw") throw new Error("release failed");
      return Promise.resolve();
    };
    await f.drained(first);
    assert.equal(notified, false);
    f.retryFacts(receipt);
    assert.throws(() => f.entry(ref("attempt-2")), /eligible generation/);
    assert.equal(f.state.releases, 1);
  }
});

for (const mode of ["quarantine", "stop"] as const) {
  test(`Processor reentrant release ${mode} suppresses its generation wake`, async () => {
    const f = fixture(), first = f.entry();
    await f.start(first);
    const receipt = f.end(first);
    let notified = false;
    void first.released.then(() => {
      notified = true;
    });
    f.state.releaseHook = () =>
      mode === "stop"
        ? f.controller.stop()
        : first.quarantine(new Error("reentrant loss"));
    await f.drained(first);
    assert.equal(notified, false);
    assert.equal(f.state.releases, 1);
    f.retryFacts(receipt);
    assert.throws(() => f.entry(ref("attempt-2")), /eligible generation/);
  });
}

test("Processor captures the capacity release method exactly once", async () => {
  const f = fixture();
  f.state.releaseGetter = true;
  const first = f.entry();
  assert.equal(f.state.releaseReads, 1);
  await f.start(first);
  f.end(first, "succeeded");
  await f.drained(first);
  assert.equal(f.state.releaseReads, 1);
  assert.equal(f.state.releases, 1);
});

test("Processor unknown starts and quiescence without known end retain capacity", async () => {
  for (const mode of ["duplicate", "wrong-ordinal", "drained-only"]) {
    const f = fixture(), e = f.entry();
    if (mode !== "drained-only") {
      f.state.outcome = {
        status: mode === "duplicate" ? "duplicate" : "committed",
        result: {
          binding: e.reference,
          attempts: mode === "wrong-ordinal" ? 2 : 1,
        },
      };
    }
    if (mode === "drained-only") await f.start(e);
    else await assert.rejects(f.start(e), /fresh start required/);
    let released = false;
    void e.released.then(() => {
      released = true;
    });
    await f.drained(e);
    assert.equal(released, false);
    assert.equal(f.state.releases, 0);
    assert.equal(e.isCurrent(), false);
  }
});

test("Processor ended observations cannot precede start or replace conflicting evidence", async () => {
  const f = fixture(), first = f.entry();
  assert.throws(() => f.end(first), /Known start/);
  assert.equal(first.isCurrent(), false);
  const g = fixture(), second = g.entry();
  await g.start(second);
  g.end(second);
  assert.throws(() => g.end(second, "succeeded"), /Conflicting/);
  await g.drained(second);
  assert.equal(g.state.releases, 0);
});

test("Processor driver attachment and malformed start facts remain closed", async () => {
  const f = fixture(), first = f.entry();
  assert.throws(
    () => first.attachDriver({ quiescent: Promise.resolve(), revoke() {} }),
    /attachment refused/,
  );
  f.state.facts = { ...f.state.facts, attempts: 1 };
  await assert.rejects(f.start(first), /authorization refused/);
  assert.equal(f.state.releases, 0);
});

/** Actual neutral driver, bound port and ledger; the boundary is a data-only
 * double. These tests do not claim SQL scheduling or host alarm integration. */
function composed(
  options: {
    failFirst?: boolean;
    unknownCompletion?: boolean;
    heldFactory?: ReturnType<typeof gate<void>>;
  } = {},
) {
  const f = fixture();
  let executions = 0, completions = 0;
  const entered = gate();
  const registry = createPluginRegistry({
    processors: {
      observe: defineProcessor({
        id: "observe",
        on: [{ eventType: "source" }],
        handle() {
          executions++;
          if (options.failFirst && executions === 1) {
            throw new Error("try again");
          }
        },
      }),
    },
  });
  function create(attempt = "attempt-1") {
    const reference = ref(attempt);
    const e = f.controller.reserve(
      reference,
      ownerLocalProcessorStartKey(reference),
    );
    const projection = {
      reference,
      processorId: "observe",
      ownerId: "owner",
      namespace: "space",
      databaseSchema: "public",
      deliveryId: "delivery",
      attempts: e.attemptOrdinal,
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
        createdAt: time,
      },
    };
    const port = createOwnerLocalProcessorPort({
      reference,
      attemptOrdinal: e.attemptOrdinal,
      controlCaller: e.controlCaller,
      localCaller: e.localCaller,
      isCurrent: e.isCurrent,
      onStarted: e.onStarted,
      onEnded: e.onEnded,
      boundary: {
        execute(caller, command, callOptions) {
          if (command.kind === "owner.local-processor-start") {
            return e.executeStart(caller, command, callOptions);
          }
          assert.equal(command.kind, "processor.local-complete");
          completions++;
          if (callOptions && !("signal" in callOptions)) {
            throw new Error("unexpected options");
          }
          const input = command.intent as { completion: { status: string } };
          if (options.unknownCompletion) {
            return Promise.reject(
              Object.assign(new Error("committed reply lost"), {
                indeterminate: true,
              }),
            );
          }
          return Promise.resolve({
            status: "committed" as const,
            result: {
              reference,
              attempts: e.attemptOrdinal,
              ...(input.completion.status === "failed"
                ? { status: "retry_wait", availableAt: due }
                : { status: input.completion.status }),
            },
          });
        },
        project(_caller, name) {
          return Promise.resolve(
            name === "processor.local-input"
              ? structuredClone(projection)
              : { reference, cancellationRequested: false },
          );
        },
      },
    });
    const driver = createRegisteredLocalProcessorExecution({
      registry,
      reference,
      attemptOrdinal: e.attemptOrdinal,
      owner: port,
      isCurrent: e.isCurrent,
      onIndeterminate: e.quarantine,
      async createCapabilities() {
        entered.resolve();
        if (options.heldFactory) await options.heldFactory.promise;
        return { resources: {}, adapters: {} };
      },
    });
    e.attachDriver(driver);
    return { e, driver, port };
  }
  return { f, create, entered, counts: () => ({ executions, completions }) };
}

test("composed actual neutral driver and bound port release exactly one retry generation", async () => {
  const f = composed({ failFirst: true }), first = f.create();
  const outcome = await first.driver.run();
  assert.equal(outcome.receipt.status, "retry_wait");
  await first.driver.quiescent;
  assert.deepEqual(await first.e.released, outcome.receipt);
  assert.equal(first.e.isCurrent(), false);
  assert.equal(f.f.state.releases, 1);
  f.f.retryFacts(outcome.receipt);
  const second = f.create("attempt-2");
  assert.equal(second.e.attemptOrdinal, 2);
  assert.equal((await second.driver.run()).receipt.status, "succeeded");
  await second.driver.quiescent;
  assert.equal((await second.e.released).status, "succeeded");
  assert.deepEqual(f.counts(), { executions: 2, completions: 2 });
  assert.equal(f.f.state.releases, 2);
  assert.throws(() => f.create("attempt-3"), /eligible generation/);
});

test("composed unknown terminal through actual driver and port cannot release a generation", async () => {
  const f = composed({ unknownCompletion: true }), first = f.create();
  let notified = false;
  void first.e.released.then(() => {
    notified = true;
  });
  await assert.rejects(first.driver.run(), /indeterminate/);
  await first.driver.quiescent;
  await tick();
  assert.equal(first.e.isCurrent(), false);
  assert.equal(notified, false);
  assert.equal(f.f.state.releases, 0);
  assert.throws(() => f.create("attempt-2"), /eligible generation/);
});

test("composed revoked noncooperative actual factory retains generation occupancy through raw quiescence", async () => {
  const held = gate(), f = composed({ heldFactory: held }), first = f.create();
  const running = first.driver.run();
  const rejected = assert.rejects(running);
  await f.entered.promise;
  first.e.revoke();
  let quiet = false;
  void first.driver.quiescent.then(() => {
    quiet = true;
  });
  await tick();
  assert.equal(quiet, false);
  assert.equal(f.f.state.releases, 0);
  held.resolve();
  await rejected;
  await first.driver.quiescent;
  assert.equal(f.f.state.releases, 0);
  assert.deepEqual(f.counts(), { executions: 0, completions: 0 });
});

test("captured local Processor lifetime ends invocation without revoking settlement", async () => {
  const f = fixture(),
    invocation = new AbortController(),
    entry = f.entry(ref(), invocation.signal);
  assert.equal(
    f.controller.captureCurrentLifetime(entry.localCaller),
    undefined,
  );
  await f.start(entry);
  const caller = entry.localCaller,
    lifetime = f.controller.captureCurrentLifetime(caller)!;
  assert.ok(lifetime);
  Object.assign(caller, { localProcessorAttempt: "changed" });
  assert.equal(lifetime.isCurrent(), true);
  assert.equal(lifetime.matches(caller), false);
  assert.equal(lifetime.matches(entry.localCaller), true);
  invocation.abort();
  assert.equal(lifetime.signal.aborted, true);
  assert.equal(lifetime.isCurrent(), false);
  assert.equal(entry.isCurrent(), true);
  assert.ok(f.controller.resolveCurrent(entry.localCaller));
  assert.equal(f.state.releases, 0);
  f.controller.stop();
  await f.drained(entry);
});
test("local Processor signal getter cannot attach after entry revocation", () => {
  const f = fixture(), entry = f.controller.reserve(ref(), key);
  assert.throws(() =>
    entry.attachDriver({
      quiescent: Promise.resolve(),
      revoke() {},
      get invocationSignal() {
        entry.revoke();
        return new AbortController().signal;
      },
    })
  );
  assert.equal(f.state.releases, 0);
});
test("current callback cannot end a Processor invocation and preserve captured read authority", async () => {
  const f = fixture(),
    invocation = new AbortController(),
    entry = f.entry(ref(), invocation.signal);
  await f.start(entry);
  const lifetime = f.controller.captureCurrentLifetime(entry.localCaller)!;
  f.state.ownerHook = () => {
    f.end(entry, "succeeded");
    return true;
  };
  assert.equal(lifetime.isCurrent(), false);
  assert.equal(lifetime.matches(entry.localCaller), false);
  assert.equal(
    f.controller.captureCurrentLifetime(entry.localCaller),
    undefined,
  );
  assert.equal(entry.isCurrent(), true);
  assert.equal(f.state.releases, 0);
  f.controller.stop();
  await f.drained(entry);
});
