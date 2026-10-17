import assert from "node:assert/strict";
import { test } from "node:test";
import { defineAction } from "../actions/define.ts";
import { createPluginRegistry } from "../plugins/registry.ts";
import type {
  OwnerCaller,
  OwnerCommandOutcome,
  OwnerInputCommand,
  OwnerJson,
} from "./boundary.ts";
import type { OwnerLocalAssignmentBinding } from "./placement-binding.ts";
import { createLocalPortCalls } from "./local-port-calls.ts";
import { createLocalChildActionCall } from "./local-child-action-port.ts";

function gate<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => resolve = done);
  return { promise, resolve };
}
const tick = () => new Promise<void>((done) => setTimeout(done, 0));
const code = (expected: string) => (error: unknown) =>
  !!error && typeof error === "object" &&
  (error as { code?: unknown }).code === expected;
function admitted(command: OwnerInputCommand): OwnerCommandOutcome {
  const input = command.input as Record<string, OwnerJson>;
  const parent = input.parent as Record<string, OwnerJson>;
  return {
    status: "committed",
    result: {
      namespace: "space",
      actionId: "fixture.child",
      executionId:
        `${parent.operationKey}/action:fixture.child:${input.operationKey}`,
      eventId: "child-event",
      deliveryId: "child-delivery",
    },
  };
}
function fixture(kind: "action" | "processor", hooks: {
  waitMs?: number;
  admit?(command: OwnerInputCommand): Promise<OwnerCommandOutcome>;
  project?(state: { current: boolean; open: boolean }): Promise<OwnerJson>;
} = {}) {
  const common = {
    placement: "owner-local" as const,
    ownerId: "owner",
    epoch: 1,
    holderId: "holder",
    attemptId: "attempt",
    namespace: "space",
    sourceEventId: "source",
    deliveryId: "delivery",
  };
  const reference: OwnerLocalAssignmentBinding = kind === "action"
    ? { ...common, kind, actionId: "parent", actionRunId: "parent-run" }
    : {
      ...common,
      kind,
      processorId: "parent",
      consumerId: "processor:parent",
    };
  const caller: OwnerCaller = {
    principal: {
      kind: "owner-local",
      ownerId: "owner",
      epoch: 1,
      holderId: "holder",
      deliveryId: "delivery",
      attemptId: "attempt",
    },
    ownerEpoch: 1,
    privateWitness: "actual-host-witness",
  };
  const state = { current: true, open: true }, loss = new AbortController();
  const quarantined: unknown[] = [],
    commands: OwnerInputCommand[] = [],
    callers: OwnerCaller[] = [];
  let projections = 0;
  const current = () => {
    if (!state.current) throw new Error("local authority unavailable");
  };
  const invocation = () => {
    current();
    if (!state.open) throw new Error("local invocation closed");
  };
  const calls = createLocalPortCalls({
    current,
    signal: loss.signal,
    maxPendingCalls: 2,
    failure: (name) => Object.assign(new Error(name), { code: name }),
    snapshot: structuredClone,
    quarantine(error) {
      quarantined.push(error);
      state.current = false;
      loss.abort(error);
      return error;
    },
  });
  const boundary = {
    async executeInput(who: OwnerCaller, command: OwnerInputCommand) {
      callers.push(who);
      commands.push(command);
      return await (hooks.admit?.(command) ??
        Promise.resolve(admitted(command)));
    },
    async project(who: OwnerCaller, _kind: string, _input: OwnerJson) {
      callers.push(who);
      projections++;
      return await (hooks.project?.(state) ??
        Promise.resolve({ status: "completed", output: { value: 7 } }));
    },
  };
  const invoke = createLocalChildActionCall({
    reference,
    caller,
    boundary,
    calls,
    invocation,
    maxPendingCalls: 2,
    children: {
      maxWaitMs: hooks.waitMs ?? 1000,
      registry: createPluginRegistry({
        actions: {
          child: defineAction({
            id: "fixture.child",
            execute: () => null,
          }),
        },
      }),
    },
  });
  return {
    invoke,
    state,
    calls,
    commands,
    callers,
    reference,
    caller,
    boundary,
    quarantined,
    projections: () => projections,
  };
}
const request = {
  actionAlias: "child",
  input: { ordinary: true },
  operationKey: "step",
};
for (const kind of ["action", "processor"] as const) {
  test(`local ${kind} child call captures its methods and exact parent without worker credentials`, async () => {
    const f = fixture(kind);
    Object.assign(f.reference, { deliveryId: "mutated" });
    Object.assign(f.caller, { privateWitness: "mutated" });
    f.boundary.executeInput = () =>
      Promise.reject(new Error("replacement must not run"));
    assert.deepEqual(await f.invoke(request, {}), { value: 7 });
    assert.equal(f.commands.length, 1);
    assert.deepEqual(
      (f.commands[0].input as Record<string, OwnerJson>).parent,
      {
        placement: "owner-local",
        deliveryId: "delivery",
        attemptId: "attempt",
        operationKey: kind === "action" ? "parent-run" : "delivery:delivery",
      },
    );
    assert.ok(
      f.callers.every((who) =>
        who.privateWitness === "actual-host-witness" &&
        who.principal.kind === "owner-local" &&
        !Object.hasOwn(who, "assignmentId")
      ),
    );
    assert.equal(f.calls.size, 0);
  });
  test(`local ${kind} child admission timeout retains actual raw occupancy until settlement`, async () => {
    const raw = gate<OwnerCommandOutcome>();
    const f = fixture(kind, { waitMs: 5, admit: () => raw.promise });
    await assert.rejects(
      f.invoke(request, {}),
      code("action_admission_unknown"),
    );
    assert.equal(f.calls.size, 1);
    let drained = false;
    const drain = f.calls.drain().then(() => drained = true);
    await tick();
    assert.equal(drained, false);
    f.state.open = false;
    raw.resolve(admitted(f.commands[0]));
    await drain;
    assert.equal(f.calls.size, 0);
    assert.equal(f.projections(), 0);
  });
  test(`local ${kind} child cancelled result wait keeps its held projection charged`, async () => {
    const entered = gate<void>(), raw = gate<OwnerJson>();
    const f = fixture(kind, {
      project: () => {
        entered.resolve();
        return raw.promise;
      },
    });
    const abort = new AbortController();
    const pending = f.invoke(request, { signal: abort.signal });
    const rejected = assert.rejects(pending, code("action_wait_interrupted"));
    await entered.promise;
    abort.abort(new Error("caller cancelled"));
    await rejected;
    assert.equal(f.calls.size, 1);
    f.state.open = false;
    let drained = false;
    const drain = f.calls.drain().then(() => drained = true);
    await tick();
    assert.equal(drained, false);
    raw.resolve({ status: "completed", output: { private: "late" } });
    await drain;
    assert.equal(f.calls.size, 0);
  });
  test(`local ${kind} child unknown admission quarantines without replay or result access`, async () => {
    const f = fixture(kind, {
      admit: () =>
        Promise.reject(
          Object.assign(new Error("lost COMMIT reply"), {
            code: "owner_commit_unknown",
          }),
        ),
    });
    await assert.rejects(
      f.invoke(request, {}),
      code("action_admission_unknown"),
    );
    assert.equal(f.quarantined.length, 1);
    await assert.rejects(f.invoke(request, {}), /unavailable/);
    assert.equal(f.commands.length, 1);
    assert.equal(f.projections(), 0);
  });
  test(`local ${kind} child revocation during result read prevents exposing its output`, async () => {
    const f = fixture(kind, {
      project: (state) => {
        state.current = false;
        return Promise.resolve({
          status: "completed",
          output: { private: "never expose" },
        });
      },
    });
    await assert.rejects(f.invoke(request, {}), /unavailable/);
    assert.equal(f.projections(), 1);
    assert.equal(f.calls.size, 0);
  });
}
