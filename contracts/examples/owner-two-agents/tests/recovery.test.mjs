import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { createCopilotzEngine } from "@copilotz/copilotz/engine";
import { createPluginRegistry, definePlugin } from "@copilotz/copilotz/plugins";
import { openManagedOminipgDatabase } from "@copilotz/copilotz/persistence";

// Business-state regression from the independent review. No Action/Processor is
// dispatched in Node: load the exact Action body with an explicit placement spy,
// then use the installed owner's real Collection kernel and in-memory database.
// This checks mutation receipts/conditions, not a browser or transport retry.
async function definition(path, bindings) {
  const source = await readFile(new URL(`../${path}`, import.meta.url), "utf8");
  const body = stripTypeScriptTypes(source, { mode: "strip" })
    .replace(/^import[\s\S]*?;\n/gm, "").replace("export default", "return");
  return Function(...Object.keys(bindings), body)(...Object.values(bindings));
}
async function fixture(name, status) {
  let placementChecks = 0;
  const action = await definition(`actions/${name}/index.ts`, {
    defineAction: (value) => value,
    assertBrowserWorker: () => placementChecks++,
    runInput: {},
  });
  const collection = await definition("collections/plan/index.ts", {
    defineCollection: (value) => value,
  });
  // Policy is tested by owner.test.mjs. This low-level receipt fixture registers
  // only the schema, with no app handler or protected invocation impersonation.
  const { ownerPolicy: _policy, ...schema } = collection;
  const db = await openManagedOminipgDatabase({ url: ":memory:" });
  const registry = await createPluginRegistry({
    plugins: [definePlugin({
      id: "test.demo.receipts",
      version: "1",
      collections: { plan: schema },
    })],
  });
  const engine = await createCopilotzEngine({
    session: db.session,
    registry,
    defaultDatabaseSchema: "demo_receipt_test",
  });
  const plan = engine.collections.withScope({
    namespace: "test",
    createMutationIdentity: (key) => ({
      deduplicationId: `same-action:${key}`,
      correlationId: "demo-run:r",
    }),
  }).demo_plan;
  if (status !== undefined) {
    await plan.create({
      id: "r",
      runId: "r",
      title: "Plan",
      status,
      steps: ["Test"],
      review: "Pending",
      clock: "2026-10-19T02:50:00.000Z",
      execution: "browser-worker",
    }, { operationKey: "seed" });
  }
  return {
    action,
    plan,
    engine,
    checks: () => placementChecks,
    async close() {
      await engine.shutdown();
      await db.close();
    },
  };
}
for (
  const [name, initial, committed] of [["review-plan", "draft", "reviewed"], [
    "publish-plan",
    "reviewed",
    "published",
  ]]
) {
  test(`${name}: lost committed reply replays the exact receipt after later advancement`, async () => {
    const f = await fixture(name, initial);
    try {
      let attempts = 0, original, captured;
      const context = {
        collections: {
          plan: {
            get() {
              assert.fail(
                "Action must return mutation provenance, never a current-row read",
              );
            },
            async update(input, options) {
              captured = structuredClone({ input, options });
              const result = await f.plan.update(input, options);
              if (++attempts === 1) {
                original = result;
                throw new Error("lost reply after owner commit");
              }
              return result;
            },
          },
        },
      };
      const input = { runId: "r", clock: "2026-10-19T02:50:01.000Z" };
      await assert.rejects(
        () => f.action.execute(input, context),
        /lost reply/,
      );
      assert.equal((await f.plan.get({ id: "r" })).status, committed);
      await f.plan.update({
        id: "r",
        set: { status: "published", review: "Later authorized mutation" },
      }, { operationKey: "later" });
      const before = await f.engine.events.list({
        namespace: "test",
        limit: 100,
      });
      const result = await f.action.execute(input, context);
      assert.deepEqual(result, original);
      assert.equal(result.status, committed);
      assert.notEqual(result.review, "Later authorized mutation");
      assert.equal(
        (await f.plan.get({ id: "r" })).review,
        "Later authorized mutation",
      );
      assert.deepEqual(
        await f.engine.events.list({ namespace: "test", limit: 100 }),
        before,
      );
      assert.equal(f.checks(), 2);
      await assert.rejects(
        () =>
          f.plan.update({
            ...captured.input,
            set: { ...captured.input.set, review: "Different intent" },
          }, captured.options),
        /intent|mutation/i,
      );
      if (name === "review-plan") {
        await assert.rejects(
          () =>
            f.action.execute(
              { ...input, clock: "2026-10-20T00:00:00.000Z" },
              context,
            ),
          /intent|mutation/i,
        );
      }
    } finally {
      await f.close();
    }
  });
  test(`${name}: an unrelated advanced row is not proof of this transition`, async () => {
    const f = await fixture(name, committed);
    try {
      const before = await f.engine.events.list({
        namespace: "test",
        limit: 100,
      });
      await assert.rejects(
        () =>
          f.action.execute({ runId: "r", clock: "2026-10-19T02:50:01.000Z" }, {
            collections: { plan: f.plan },
          }),
        (error) => error.code === "collection_mutation_condition_failed",
      );
      assert.deepEqual(
        await f.engine.events.list({ namespace: "test", limit: 100 }),
        before,
      );
    } finally {
      await f.close();
    }
  });
  test(`${name}: input is captured before the asynchronous mutation`, async () => {
    const f = await fixture(name, initial);
    try {
      let release;
      const gate = new Promise((resolve) => release = resolve);
      const input = { runId: "r", clock: "2026-10-19T02:50:01.000Z" };
      const pending = f.action.execute(input, {
        collections: {
          plan: {
            async update(value, options) {
              await gate;
              return f.plan.update(value, options);
            },
          },
        },
      });
      input.runId = "changed";
      input.clock = "changed";
      release();
      const result = await pending;
      assert.equal(result.runId, "r");
      if (name === "review-plan") {
        assert.equal(result.reviewedAt, "2026-10-19T02:50:01.000Z");
      }
    } finally {
      await f.close();
    }
  });
}

test("save-draft returns its original create receipt after a lost reply and later review", async () => {
  const f = await fixture("save-draft");
  try {
    let attempts = 0, original;
    const context = {
      collections: {
        plan: {
          get() {
            assert.fail("Draft result must come from the original mutation");
          },
          async create(input, options) {
            const result = await f.plan.create(input, options);
            if (++attempts === 1) {
              original = result;
              throw new Error("lost create reply");
            }
            return result;
          },
        },
      },
    };
    const input = { runId: "r", clock: "2026-10-19T02:50:01.000Z" };
    await assert.rejects(
      () => f.action.execute(input, context),
      /lost create reply/,
    );
    await f.plan.update({ id: "r", set: { status: "reviewed" } }, {
      operationKey: "later-review",
    });
    const before = await f.engine.events.list({
      namespace: "test",
      limit: 100,
    });
    assert.deepEqual(await f.action.execute(input, context), original);
    assert.equal(original.status, "draft");
    assert.equal((await f.plan.get({ id: "r" })).status, "reviewed");
    assert.deepEqual(
      await f.engine.events.list({ namespace: "test", limit: 100 }),
      before,
    );
    await assert.rejects(
      () => f.action.execute({ ...input, clock: "different" }, context),
      /intent|mutation/i,
    );
  } finally {
    await f.close();
  }
});
