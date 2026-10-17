/** Actual public owner/worker context flow. Source records are created through
 * owner Collection commands; fixture SQL is assertion/policy reads only. */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createCopilotz,
  type OwnerConnectionOptions,
  type OwnerStorageOptions,
} from "../../create-copilotz.ts";
import { defineAction } from "../actions/define.ts";
import type { ActionContext } from "../actions/types.ts";
import { defineCollection } from "../collections/definition.ts";
import { definePlugin } from "../plugins/types.ts";
import { defineView } from "../views/definition.ts";
import { createTestDatabase } from "../testing/ominipg.ts";
import { encodeOwnerMetadataConstraints } from "../owner/metadata-constraints.ts";
import { ownerAssignmentKey } from "../owner/assignments.ts";
import type { OwnerCaller } from "../owner/boundary.ts";
import type { SqlExecutor, SqlSession } from "../events/session.ts";
import type { Hypervisor } from "../../dependencies/oxian-hypervisor.ts";
import { resolveOxianSource } from "../../scripts/test-owner-connected.mjs";
import { createOwnerHost, type OwnerHostOptions } from "./owner-host.ts";
import { createPluginRegistry } from "../plugins/registry.ts";

async function eventually(check: () => boolean | Promise<boolean>) {
  const until = Date.now() + 12_000;
  while (!await check()) {
    if (Date.now() >= until) {
      throw new Error("preparation host fixture timed out");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
async function fixture(mode: "in-process" | "websocket", scenario = "normal") {
  const { entrypoints } = await resolveOxianSource(
    process.env.COPILOTZ_OXIAN_SOURCE_ROOT!,
  );
  const { createHypervisor } = await import(entrypoints["./hypervisor"]);
  const { createWorker } = await import(entrypoints["./worker"]);
  const { serve } = await import(entrypoints["./adapters/node"]);
  const db = await createTestDatabase({ pgliteMemoryProfile: "low-memory" });
  const local = {
    type: "in-process" as const,
    config: { topic: crypto.randomUUID() },
  };
  let transport: Hypervisor | undefined;
  const state = {
    rendered: 0,
    mapped: 0,
    childExecuted: 0,
    projected: 0,
    originalAllowed: true,
    replacedConfiguration: false,
    version: "original",
    parentCtx: true,
  };
  const errors: unknown[] = [];
  const plugin = definePlugin({
    id: "prepared-context",
    version: "1",
    collections: {
      notes: defineCollection({
        name: "context_note",
        schema: {
          type: "object",
          properties: {
            id: { type: "string" },
            title: { type: "string" },
            hidden: { type: "string" },
          },
          required: ["title", "hidden"],
        } as const,
      }),
    },
    actions: {
      child: defineAction({
        id: "context.child",
        inputSchema: { type: "string" } as const,
        outputSchema: { type: "string" } as const,
        execute(value: string) {
          state.childExecuted++;
          if (scenario === "result-revoked") state.originalAllowed = false;
          return `child:${value}`;
        },
      }),
      parent: defineAction({
        id: "context.parent",
        inputSchema: { type: "string" } as const,
        outputSchema: { type: "array", items: { type: "string" } } as const,
        async execute(id: string, ctx: ActionContext) {
          await ctx.transaction(({ collections }) => {
            collections.notes.create({ id, title: "first", hidden: "private" });
          }, { operationKey: "source" });
          const request = {
            preparation: scenario === "missing" ? "missing" : "notes.context",
            recordId: id,
            mode: scenario === "generic" ? "brief" : "context",
          };
          const first = await ctx.actions.child.prepareNamed(request, {
            operationKey: "reply",
          });
          if (!["normal", "generic", "snapshot"].includes(scenario)) {
            return [String(first)];
          }
          await ctx.transaction(({ collections }) => {
            collections.notes.update({
              id,
              set: { title: "changed", hidden: "changed-private" },
            });
          }, { operationKey: "edit-source" });
          state.version = "changed";
          const duplicate = await ctx.actions.child.prepareNamed(request, {
            operationKey: "reply",
          });
          return [String(first), String(duplicate)];
        },
      }),
    },
    views: {
      note: defineView({
        id: "context.note",
        shows: "context_note",
        renderer: "text",
        modes: ["context"],
        render(value: { record: { title: string } }) {
          state.rendered++;
          if (scenario === "parent-revoked") state.parentCtx = false;
          return `${value.record.title}:${state.version}`;
        },
      }),
    },
  });
  async function currentSource(
    tx: SqlExecutor,
    caller: OwnerCaller,
    time: string,
  ) {
    if (
      caller.principal.kind !== "worker" ||
      !["parent", "embedded"].includes(caller.principal.workerId)
    ) throw new Error("source principal refused");
    if (
      typeof caller.sessionId !== "string" ||
      typeof caller.assignmentId !== "string"
    ) throw new Error("source binding refused");
    // The real host first proves current authenticated Started/ctx authority.
    // At claim, that exact reservation precedes lease acquisition. Only an
    // untouched pending row or this exact live lease satisfies the data policy.
    const rows = await tx.query<
      { namespace: string; binding: Record<string, unknown> }
    >(
      `SELECT e.namespace,a.binding FROM owner_assignments a JOIN event_deliveries d ON d.id=a.delivery_id JOIN events e ON e.id=d.event_id WHERE a.owner=$1 AND a.epoch=$2 AND a.assignment_key=$3 AND a.retired=FALSE AND e.owner_id=$1 AND e.namespace='space' AND e.id=a.binding->>'sourceEventId' AND e.metadata->>'actionId'=a.binding->>'actionId' AND e.metadata->>'actionRunId'=a.binding->>'executionId' AND d.consumer_id='registered:'||(a.binding->>'actionId') AND ((d.status='pending' AND d.attempts=0 AND d.lease_owner IS NULL AND d.lease_expires_at IS NULL AND d.available_at<=$4::timestamptz) OR (d.status='leased' AND d.lease_owner=a.binding->>'dispatchAttemptId' AND d.lease_expires_at>$4::timestamptz))`,
      [
        "owner",
        caller.ownerEpoch,
        ownerAssignmentKey("owner", {
          placement: "worker",
          sessionId: caller.sessionId,
          assignmentId: caller.assignmentId,
        }),
        time,
      ],
    );
    if (rows.rows.length !== 1) {
      errors.push(
        new Error(
          `source policy has no current claimable/live assignment: ${
            JSON.stringify({
              caller,
              rendered: state.rendered,
              mapped: state.mapped,
              childExecuted: state.childExecuted,
            })
          }`,
        ),
      );
    }
    assert.equal(
      rows.rows.length,
      1,
      "current exact original source assignment",
    );
    assert.equal(rows.rows[0].namespace, "space");
    for (
      const name of [
        "sessionId",
        "assignmentId",
        "workerAttemptId",
        "sessionGeneration",
        "parentOperationId",
        "deliveryId",
        "dispatchAttemptId",
        "sourceEventId",
        "actionId",
        "executionId",
      ] as const
    ) assert.equal(rows.rows[0].binding[name], caller[name]);
    assert.equal(rows.rows[0].binding.workerId, caller.principal.workerId);
  }
  const preparation = {
    records: {
      sources: { notes: { collectionAlias: "notes" } },
      async authorize(tx, context) {
        assert.equal(context.ownerId, "owner");
        assert.equal(context.request.source, "notes");
        assert.equal(context.request.recordId, scenario);
        await currentSource(tx, context.caller, context.commandTime);
        return { namespace: "space", audience: "context-reader" };
      },
      projectRecord(record) {
        state.projected++;
        return { title: record.title };
      },
      async authorizeReference(tx, context) {
        await currentSource(tx, context.caller, context.commandTime);
        assert.equal(context.reference.source.recordId, scenario);
        assert.equal(context.reference.source.namespace, "space");
        assert.equal(context.reference.source.kind, "context_note");
        assert.equal(context.reference.audience, "context-reader");
        if (!state.originalAllowed) {
          throw new Error("original projection permission revoked");
        }
        return true as const;
      },
    },
    registrations: {
      "notes.context": {
        source: "notes",
        actionAlias: "child",
        shows: "context_note",
        modes: ["context", "brief"],
        mapInput(text) {
          state.mapped++;
          return text;
        },
      },
    },
    projectResource() {
      throw new Error("no resource registered");
    },
    authorizeResource() {
      throw new Error("no resource registered");
    },
  } satisfies NonNullable<OwnerStorageOptions["storage"]["preparation"]>;
  const session: SqlSession = {
    async query(sql, params) {
      if (scenario === "snapshot" && !state.replacedConfiguration) {
        await Promise.resolve();
        state.replacedConfiguration = true;
        preparation.records.sources.notes.collectionAlias = "replaced";
        preparation.records.authorize = () => {
          throw new Error("replacement source callback invoked");
        };
        preparation.records.authorizeReference = () => {
          throw new Error("replacement reference callback invoked");
        };
        preparation.records.projectRecord = () => {
          throw new Error("replacement projection callback invoked");
        };
        preparation.registrations["notes.context"].source = "replaced";
        preparation.registrations["notes.context"].mapInput = () => {
          throw new Error("replacement mapper invoked");
        };
      }
      return await db.query(sql, params);
    },
    transaction: db.transaction,
  };
  const worker = (id: string, connection: unknown) => ({
    id,
    transport: connection,
    capacity: 1,
    hostCalls: { maxConcurrent: 8, timeoutMs: 10_000 },
    activate: () => ({
      workerId: id,
      attemptId: crypto.randomUUID(),
      epoch: 1,
    }),
    register: () => ({
      credential: { kind: "registration", capability: "fixture" },
      expiresAtMs: Date.now() + 60_000,
    }),
    reconnectDelay: false,
  });
  const options = {
    namespace: "space",
    plugins: [plugin],
    childWaitMs: 10_000,
    storage: {
      ownerId: "owner",
      holderId: "holder",
      schema: "public",
      session,
      initialization: "fresh",
      preparation,
      maxActive: scenario === "one-slot" ? 1 : 2,
      maxPending: 32,
      leaseMs: 3000,
      onError: (error) => errors.push(error),
      policy: {
        ingress: (_tx, { fence }) =>
          ["parent", "embedded"].includes(fence.identity.workerId)
            ? {
              namespace: "space",
              principalKey: "api:context",
              principal: { actorId: "api:context" },
              route: { kind: "wrapper", id: "context-only" },
              allowedActions: ["parent"],
              actionMetadata: {},
              operationMetadata: { tenant: "space" },
              metadataConstraints: encodeOwnerMetadataConstraints({
                actorId: "api:context",
                tenant: "space",
              }),
              group: { key: "context", actorId: "api:context" },
            }
            : undefined,
        worker: (_tx, { fence }) =>
          ["parent", "embedded"].includes(fence.identity.workerId)
            ? {
              ctx: fence.identity.workerId !== "parent" || state.parentCtx,
              settlement: true,
            }
            : undefined,
        input(_tx, assignment) {
          assert.equal(assignment.namespace, "space");
          assert.ok(
            ["context.parent", "context.child"].includes(assignment.actionId),
          );
          if (
            scenario === "input-revoked" &&
            assignment.actionId === "context.child"
          ) state.originalAllowed = false;
        },
        collections(_tx, assignment) {
          assert.ok("actionId" in assignment);
          assert.equal(assignment.actionId, "context.parent");
          assert.equal(assignment.namespace, "space");
          return {};
        },
        child(_tx, parent, actionId) {
          assert.equal(parent.namespace, "space");
          assert.ok(parent.actionRunId);
          assert.equal(actionId, "context.child");
        },
        effectOutcome: () => false,
        effectNotStarted: () => false,
      },
      transport: {
        transports: mode === "websocket"
          ? [local, { type: "websocket", config: { path: "/workers" } }]
          : [local],
        admit: ({ identity, credential, workloads, capacity }) => ({
          definition: {
            workerId: identity.workerId,
            providerId: "fixture",
            workloads,
            capacity,
            providerConfig: {},
            labels: {},
          },
          sessionGeneration: 1,
          authenticatedWith: credential.kind,
          resume: {
            credential: { kind: "resume", capability: "fixture" },
            expiresAtMs: Date.now() + 60_000,
          },
        }),
        assign: ({ available }) =>
          available.find((fence) => fence.identity.workerId === "parent") ??
            available.find((fence) => fence.identity.workerId === "embedded"),
      },
      createTransport(options, lifecycle) {
        transport = createHypervisor(options, lifecycle);
        return transport!;
      },
    },
    worker: { connection: worker("embedded", local) as never, createWorker },
  } satisfies OwnerStorageOptions;
  const app = await createCopilotz(options);
  let listener: Awaited<ReturnType<typeof serve>> | undefined;
  const connect = (options: Omit<OwnerConnectionOptions, "plugins">) =>
    createCopilotz({ ...options, plugins: [plugin] });
  let remote: Awaited<ReturnType<typeof connect>> | undefined;
  try {
    await app.ready;
    if (mode === "websocket") listener = await serve({ hypervisor: transport });
    const url = listener ? new URL("/workers", listener.url) : undefined;
    if (url) url.protocol = "ws:";
    remote = await connect({
      namespace: "space",
      owner: { id: "owner" },
      childWaitMs: 10_000,
      worker: {
        connection: worker(
          "parent",
          url
            ? {
              type: "websocket",
              config: { url, allowInsecureLoopback: true },
            }
            : local,
        ) as never,
        createWorker,
      },
    });
    await remote.ready;
    return {
      app,
      remote,
      state,
      errors,
      query: db.query,
      async close() {
        await remote?.close();
        await app.close();
        await listener?.shutdown();
        await db.close();
      },
    };
  } catch (error) {
    await remote?.close();
    await app.close();
    await listener?.shutdown();
    await db.close();
    throw error;
  }
}
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
