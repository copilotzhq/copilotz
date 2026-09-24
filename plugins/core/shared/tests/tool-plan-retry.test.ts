import { assert, assertEquals, assertRejects } from "@std/assert";
import { toolPlanCollection } from "../../collections/tool-plan/index.ts";
import { retryToolPlanMutation } from "../tool-plan.ts";

Deno.test("Tool-plan state writes retry structured transient database errors", async () => {
  for (const code of ["40P01", "40001"]) {
    let attempts = 0;
    const value = await retryToolPlanMutation(async () => {
      attempts++;
      if (attempts === 1) {
        throw Object.assign(new Error("transaction aborted"), { code });
      }
      return "committed";
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
    await retryToolPlanMutation(async () => {
      attempts++;
      if (attempts === 1) throw new Error(message);
    });
    assertEquals(attempts, 2);
  }
});

Deno.test("Tool-plan state writes retry exact collection conflicts only", async () => {
  let attempts = 0;
  await retryToolPlanMutation(async () => {
    attempts++;
    if (attempts === 1) {
      throw new Error(
        "Collection 'toolPlanBranch' 'branch-a' was created while its mutation was prepared.",
      );
    }
  });
  assertEquals(attempts, 2);

  attempts = 0;
  const semantic = new TypeError("Tool-plan stage cursor is invalid.");
  await assertRejects(
    () =>
      retryToolPlanMutation(async () => {
        attempts++;
        throw semantic;
      }),
    TypeError,
    "Tool-plan stage cursor is invalid.",
  );
  assertEquals(attempts, 1, "semantic errors are never retried");
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
