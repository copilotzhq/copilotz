import { createCollectionConflictError } from "../../../../runtime/collections/errors.ts";
import { assert, assertEquals, assertRejects } from "@std/assert";
import { toolPlanCollection } from "../../collections/tool-plan/index.ts";
import { retryCoreMutation } from "../retry-mutation.ts";

Deno.test("Tool-plan state writes retry structured transient database errors", async () => {
  for (const code of ["40P01", "40001"]) {
    let attempts = 0;
    const value = await retryCoreMutation(() => {
      attempts++;
      if (attempts === 1) {
        return Promise.reject(
          Object.assign(new Error("transaction aborted"), { code }),
        );
      }
      return Promise.resolve("committed");
    });
    assertEquals(value, "committed");
    assertEquals(attempts, 2);
  }
  for (
    const message of [
      "deadlock detected",
      "could not serialize access due to concurrent update",
    ]
  ) {
    let attempts = 0;
    await retryCoreMutation(() => {
      attempts++;
      return attempts === 1
        ? Promise.reject(new Error(message))
        : Promise.resolve();
    });
    assertEquals(attempts, 2);
  }
});

Deno.test("Tool-plan state writes retry exact collection conflicts only", async () => {
  let attempts = 0;
  await retryCoreMutation(() => {
    attempts++;
    return attempts === 1
      ? Promise.reject(createCollectionConflictError())
      : Promise.resolve();
  });
  assertEquals(attempts, 2);

  attempts = 0;
  const semantic = new TypeError("Tool-plan stage cursor is invalid.");
  await assertRejects(
    () =>
      retryCoreMutation(() => {
        attempts++;
        return Promise.reject(semantic);
      }),
    TypeError,
    "Tool-plan stage cursor is invalid.",
  );
  assertEquals(attempts, 1, "semantic errors are never retried");
});

Deno.test("Core mutation retries never reinterpret an uncertain commit as a conflict", async () => {
  for (
    const details of [
      { code: "owner_commit_unknown" },
      { code: "persistence_indeterminate" },
      { indeterminate: true },
      { outcome: "unknown" },
      { execution: "indeterminate" },
    ]
  ) {
    let attempts = 0;
    const failure = Object.assign(
      new Error("uncertain commit", {
        cause: createCollectionConflictError(),
      }),
      details,
    );
    await assertRejects(
      () =>
        retryCoreMutation(() => {
          attempts++;
          return Promise.reject(failure);
        }),
      Error,
      "uncertain commit",
    );
    assertEquals(attempts, 1);
  }
});

Deno.test("legacy-ready Tool-plan migration opens the projection barrier once", () => {
  const migrate = toolPlanCollection.commands?.migrateLegacyBranches;
  const projectionReady = toolPlanCollection.commands?.projectionReady;
  assertEquals(typeof migrate?.mutate, "function");
  assertEquals(typeof projectionReady?.mutate, "function");
  const migrated = migrate!.mutate({
    current: {
      state: {
        status: "ready",
        branches: [{ status: "settled", stageIndex: 2, resultId: "r" }],
      },
    },
    input: {},
  });
  assert(migrated?.set?.state);
  assertEquals(migrated.set.state, {
    status: "ready",
    layoutVersion: 2,
    branchCount: 1,
  });
  const ready = projectionReady!.mutate({
    current: { state: migrated.set.state },
    input: {},
  });
  assert(ready?.set?.state);
  assertEquals(ready.set.state, {
    status: "ready",
    layoutVersion: 2,
    branchCount: 1,
    projectionReadyEvent: 1,
  });
  assertEquals(
    projectionReady!.mutate({ current: { state: ready.set.state }, input: {} }),
    undefined,
    "a replay cannot request final projection twice",
  );
});
