/** Actual public owner/worker context compatibility; shared setup remains test-only. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { defineAction } from "../actions/define.ts";
import { defineCollection } from "../collections/definition.ts";
import type { SqlSession } from "../events/session.ts";
import { createOwnerHost, type OwnerHostOptions } from "./owner-host.ts";
import { createPluginRegistry } from "../plugins/registry.ts";
import { eventually, fixture } from "./owner-host.preparation.fixture.test.ts";
const source = process.env.COPILOTZ_OXIAN_SOURCE_ROOT;
for (const mode of ["in-process", "websocket"] as const) {
  test(
    `public ${mode} named preparation creates ordinary source through owner, captures View once, and reuses child`,
    { skip: !source, timeout: 60_000 },
    async () => {
      const f = await fixture(mode);
      try {
        assert.deepEqual(
          await f.remote.actions.parent("normal", { idempotencyKey: "first" }),
          ["child:first:original", "child:first:original"],
        );
        assert.deepEqual([
          f.state.rendered,
          f.state.mapped,
          f.state.projected,
          f.state.childExecuted,
        ], [1, 1, 1, 1]);
        assert.equal(
          (await f.query(
            "SELECT data->>'title' AS title FROM nodes WHERE id='normal'",
          )).rows[0].title,
          "changed",
        );
        const prepared = await f.query(
          "SELECT metadata FROM events WHERE type='copilotz.owner.action.requested' AND metadata ? 'preparation'",
        );
        assert.equal(prepared.rows.length, 1);
        assert.equal(
          JSON.stringify(prepared.rows[0]).includes("private"),
          false,
        );
        await eventually(async () =>
          !(await f.query(
            "SELECT id FROM event_deliveries WHERE status NOT IN ('succeeded','dead_letter','cancelled')",
          )).rows.length
        );
        const bindings = await f.query<
          { binding: { workerId: string; actionId: string } }
        >("SELECT binding FROM owner_assignments");
        assert.ok(
          bindings.rows.some(({ binding }) =>
            binding.workerId === "parent" &&
            binding.actionId === "context.parent"
          ),
        );
        assert.ok(
          bindings.rows.some(({ binding }) =>
            binding.workerId === "embedded" &&
            binding.actionId === "context.child"
          ),
          "capacity-one parent waits while separate capacity-one worker executes child",
        );
        assert.deepEqual(f.errors, []);
      } catch (error) {
        throw new AggregateError(
          [error, ...f.errors],
          `Actual preparation failed: ${JSON.stringify(f.state)}`,
        );
      } finally {
        await f.close();
      }
    },
  );
}

test("owner named preparation rejects malformed configuration and present malformed budgets before SQL", async () => {
  let queries = 0;
  const session: SqlSession = {
    query() {
      queries++;
      throw new Error("unexpected SQL");
    },
    transaction() {
      queries++;
      throw new Error("unexpected SQL");
    },
  };
  const registry = createPluginRegistry({
    actions: { child: defineAction({ id: "test.child", execute: () => null }) },
    collections: {
      notes: defineCollection({
        name: "test_note",
        schema: {
          type: "object",
          properties: { title: { type: "string" } },
        } as const,
      }),
    },
  });
  const preparation = {
    records: {
      sources: { notes: { collectionAlias: "notes" } },
      authorize: () => ({ namespace: "space", audience: "reader" }),
      authorizeReference: () => true as const,
      projectRecord: () => null,
    },
    registrations: {
      context: {
        source: "notes",
        actionAlias: "child",
        shows: "test_note",
        modes: ["context"],
        mapInput: () => null,
      },
    },
    projectResource: () => null,
    authorizeResource: () => true as const,
  };
  const options: OwnerHostOptions = {
    ownerId: "owner",
    holderId: "holder",
    schema: "public",
    initialization: "fresh",
    session,
    registry,
    policy: {
      ingress: () => undefined,
      worker: () => undefined,
      input() {},
      collections: () => ({}),
      effectOutcome: () => false,
      effectNotStarted: () => false,
    },
    transport: { transports: [] },
    createTransport() {
      throw new Error("unexpected transport");
    },
  };
  for (
    const malformed of [null, undefined, false, "config", {}, {
      ...preparation,
      unknown: true,
    }, {
      ...preparation,
      records: { ...preparation.records, ownerId: "other" },
    }, {
      ...preparation,
      records: { ...preparation.records, authorizeReference: null },
    }]
  ) {
    await assert.rejects(
      Reflect.apply(createOwnerHost, undefined, [{
        ...options,
        preparation: malformed,
      }]),
    );
  }
  for (
    const key of ["maxPendingRenders", "renderTimeoutMs", "maxBytes"] as const
  ) {
    for (const value of [null, undefined, false, "1", NaN, Infinity, 0, -1]) {
      await assert.rejects(
        Reflect.apply(createOwnerHost, undefined, [{
          ...options,
          preparation: { ...preparation, [key]: value },
        }]),
      );
    }
  }
  for (const value of [null, undefined, false, "1", NaN, Infinity, 0]) {
    await assert.rejects(
      Reflect.apply(createOwnerHost, undefined, [{
        ...options,
        preparation: {
          ...preparation,
          records: { ...preparation.records, maxBytes: value },
        },
      }]),
    );
  }
  assert.equal(queries, 0);
});

for (const mode of ["in-process", "websocket"] as const) {
  test(
    `public ${mode} preparation retains generic fallback over the authorized ordinary projection`,
    { skip: !source, timeout: 60_000 },
    async () => {
      const f = await fixture(mode, "generic");
      try {
        const result = await f.remote.actions.parent("generic", {
          idempotencyKey: "generic",
        });
        assert.equal(result.length, 2);
        assert.equal(result[0], result[1]);
        assert.match(result[0], /first/);
        assert.equal(result[0].includes("private"), false);
        assert.deepEqual([
          f.state.rendered,
          f.state.projected,
          f.state.mapped,
          f.state.childExecuted,
        ], [0, 1, 1, 1]);
        assert.deepEqual(f.errors, []);
      } finally {
        await f.close();
      }
    },
  );
  for (
    const scenario of mode === "in-process"
      ? [
        "input-revoked",
        "result-revoked",
        "parent-revoked",
        "missing",
        "one-slot",
      ]
      : []
  ) {
    test(
      `public ${mode} preparation refuses ${scenario} without returning prepared child output`,
      { skip: !source, timeout: 60_000 },
      async () => {
        const f = await fixture(mode, scenario);
        try {
          const started = Date.now();
          await assert.rejects(
            f.remote.actions.parent(scenario, { idempotencyKey: scenario }),
          );
          if (scenario === "one-slot") {
            assert.ok(
              Date.now() - started < 10_000,
              "exhausted nested capacity refuses boundedly",
            );
          }
          assert.equal(
            f.state.childExecuted,
            scenario === "result-revoked" ? 1 : 0,
          );
          const prepared = await f.query(
            "SELECT id FROM events WHERE type='copilotz.owner.action.requested' AND metadata ? 'preparation'",
          );
          assert.equal(
            prepared.rows.length,
            ["input-revoked", "result-revoked"].includes(scenario) ? 1 : 0,
          );
          if (["one-slot", "missing"].includes(scenario)) {
            assert.equal(f.state.rendered, 0);
          }
          if (scenario === "result-revoked") {
            assert.equal(
              (await f.query(
                "SELECT id FROM event_deliveries WHERE consumer_id='registered:context.child' AND status='succeeded'",
              )).rows.length,
              1,
              "safe child terminal survives output-permission revocation",
            );
          }
        } finally {
          await f.close();
        }
      },
    );
  }
}

test(
  "public preparation snapshots owner registration and policy callbacks before held provisioning",
  { skip: !source, timeout: 60_000 },
  async () => {
    const f = await fixture("in-process", "snapshot");
    try {
      assert.equal(f.state.replacedConfiguration, true);
      assert.deepEqual(
        await f.remote.actions.parent("snapshot", {
          idempotencyKey: "snapshot",
        }),
        ["child:first:original", "child:first:original"],
      );
      assert.deepEqual([
        f.state.rendered,
        f.state.mapped,
        f.state.projected,
        f.state.childExecuted,
      ], [1, 1, 1, 1]);
    } finally {
      await f.close();
    }
  },
);
