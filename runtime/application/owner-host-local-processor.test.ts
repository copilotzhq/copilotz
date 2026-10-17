import assert from "node:assert/strict";
import { test } from "node:test";
import { defineProcessor } from "../plugins/processor.ts";
import { createPluginRegistry } from "../plugins/registry.ts";
import {
  captureOwnerHostLocalProcessors,
  type OwnerHostLocalProcessorOptions,
} from "./owner-host-local-processor.ts";

const registry = createPluginRegistry({
  processors: {
    follow: defineProcessor({
      id: "fixture.follow",
      on: [{ eventType: "note.created" }],
      handle() {},
    }),
  },
});
function configuration(): OwnerHostLocalProcessorOptions {
  return {
    processorIds: ["fixture.follow"],
    policy: {
      grants: () => ({ ctx: true, settlement: true }),
      event() {},
      collections: () => ({}),
    },
    createCapabilities: () => ({ resources: {}, adapters: {} }),
  };
}
test("local Processor configuration snapshots callbacks, IDs and omitted-only bounds", () => {
  const input = {
    ...configuration(),
    processorIds: ["fixture.follow"],
    policy: { ...configuration().policy },
    maxEntries: 1,
    maxPendingCalls: 1,
    childWaitMs: 25,
  };
  const captured = captureOwnerHostLocalProcessors(input, registry),
    original = input.policy.grants;
  input.processorIds[0] = "changed";
  input.policy.grants = () => undefined;
  input.maxEntries = 0;
  input.childWaitMs = 1;
  assert.equal(captured.selects("fixture.follow"), true);
  assert.equal(captured.selects("changed"), false);
  assert.equal(captured.policy.grants, original);
  assert.equal(captured.maxEntries, 1);
  assert.equal(captured.maxPendingCalls, 1);
  assert.equal(captured.childWaitMs, 25);
  for (const childWaitMs of [undefined, null, 0, -1, 1.5, 60001, NaN, "1"]) {
    assert.throws(() =>
      captureOwnerHostLocalProcessors(
        { ...configuration(), childWaitMs } as never,
        registry,
      )
    );
  }
  assert.equal(
    captureOwnerHostLocalProcessors(configuration(), registry).maxEntries,
    4096,
  );
  for (const value of [undefined, null, 0, -1, 1.5, 4097, NaN, "1"]) {
    assert.throws(() =>
      captureOwnerHostLocalProcessors(
        { ...configuration(), maxEntries: value } as never,
        registry,
      )
    );
  }
  for (const value of [undefined, null, 0, -1, 1.5, 129, NaN, "1"]) {
    assert.throws(() =>
      captureOwnerHostLocalProcessors(
        { ...configuration(), maxPendingCalls: value } as never,
        registry,
      )
    );
  }
});
test("local Processor configuration rejects accessors and malformed selections without evaluating them", () => {
  let getters = 0;
  const getter = {
    enumerable: true,
    get() {
      getters++;
      return () => ({});
    },
  };
  const invalid: unknown[] = [null, [], {}, {
    ...configuration(),
    extra: true,
  }];
  for (const field of ["processorIds", "policy", "createCapabilities"]) {
    invalid.push(Object.defineProperty({ ...configuration() }, field, getter));
  }
  for (const field of ["grants", "event", "collections"]) {
    invalid.push({
      ...configuration(),
      policy: Object.defineProperty(
        { ...configuration().policy },
        field,
        getter,
      ),
    });
  }
  for (
    const ids of [
      [],
      ["missing"],
      ["follow"],
      ["fixture.follow", "fixture.follow"],
      new Array(1),
      Object.defineProperty(["fixture.follow"], "0", getter),
      Object.assign(["fixture.follow"], { extra: true }),
    ]
  ) invalid.push({ ...configuration(), processorIds: ids });
  for (const candidate of invalid) {
    assert.throws(() =>
      captureOwnerHostLocalProcessors(candidate as never, registry)
    );
  }
  assert.equal(getters, 0);
});

// This test isolates policy value capture; it performs no SQL or invocation.
// Live authority is covered by the real host fixture separately.
test("local Processor Collection policy captures synchronous returns before microtasks and rejects thenables", async () => {
  const { createOwnerHostLocalProcessors } = await import(
    "./owner-host-local-processor.ts"
  );
  const { createOwnerHostCommandContexts } = await import(
    "./owner-host-local.ts"
  );
  const assignment = {
    placement: "owner-local" as const,
    kind: "processor" as const,
    ownerId: "owner",
    epoch: 1,
    holderId: "holder",
    namespace: "space",
    sourceEventId: "event",
    deliveryId: "delivery",
    processorId: "fixture.follow",
    consumerId: "processor:fixture.follow",
    attemptId: "attempt",
    attemptOrdinal: 1,
    ctxGranted: true,
    settlementGranted: true,
  };
  const conditions = { conditions: { title: "original" } };
  let thenCalled = false;
  let malformed = false;
  const config = configuration();
  const composition = createOwnerHostLocalProcessors({
    configuration: captureOwnerHostLocalProcessors({
      ...config,
      policy: {
        ...config.policy,
        collections: () => {
          if (malformed) {
            return {
              then() {
                thenCalled = true;
              },
            } as never;
          }
          queueMicrotask(() => {
            conditions.conditions.title = "changed";
          });
          return conditions as never;
        },
      },
    }, registry),
    registry,
    schema: "public",
    boundary: {
      executeInput() {
        throw new Error("unexpected child admission");
      },
      execute() {
        throw new Error("unexpected boundary");
      },
      project() {
        throw new Error("unexpected projection");
      },
    },
    controlCaller: {
      principal: {
        kind: "owner-control",
        ownerId: "owner",
        epoch: 1,
        holderId: "holder",
      },
      ownerEpoch: 1,
    },
    maxActive: 1,
    capacity: {
      reserve() {
        throw new Error("unexpected capacity");
      },
    },
    contexts: createOwnerHostCommandContexts({
      ownerId: "owner",
      holderId: "holder",
      epoch: () => 1,
      isCurrent: () => true,
    }),
    isCurrent: () => true,
    assertControl() {},
    onIndeterminate() {},
    requestWake() {},
  });
  const tx = {
    query() {
      throw new Error("unexpected SQL");
    },
  };
  assert.deepEqual(
    await composition.collections(tx, assignment, {} as never, "time"),
    { conditions: { title: "original" } },
  );
  assert.equal(conditions.conditions.title, "changed");
  malformed = true;
  await assert.rejects(
    composition.collections(tx, assignment, {} as never, "time"),
  );
  assert.equal(thenCalled, false);
});
