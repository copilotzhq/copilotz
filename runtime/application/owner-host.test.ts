import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createOwnerHost,
  type OwnerHostIngressScope,
  type OwnerHostOptions,
  type OwnerHostPolicy,
  type OwnerHostTransportOptions,
} from "./owner-host.ts";
import { createOwnerConnectedWorker } from "./owner-worker.ts";
import { createOwnerActionCallers } from "./owner-actions.ts";
import type { ActionContext } from "../actions/types.ts";
import { defineAction } from "../actions/define.ts";
import { defineCollection } from "../collections/definition.ts";
import { createPluginRegistry } from "../plugins/registry.ts";
import { defineProcessor } from "../plugins/processor.ts";
import { createTestDatabase } from "../testing/ominipg.ts";
import { createOwnerConnection } from "../owner/connection.ts";
import { ownerActionAdmissionKey } from "../owner/admission.ts";
import { encodeOwnerMetadataConstraints } from "../owner/metadata-constraints.ts";
import { resolveOxianSource } from "../../scripts/test-owner-connected.mjs";
import type { SqlSession } from "../events/session.ts";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((yes) => resolve = yes);
  return { promise, resolve };
}
async function within<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("owner host fixture timed out")),
          12_000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function eventually(check: () => boolean | Promise<boolean>) {
  await within((async () => {
    while (!await check()) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  })());
}
const scope: OwnerHostIngressScope = {
  namespace: "space",
  principalKey: "api:credential",
  principal: { kind: "developer", actorId: "api:credential" },
  route: { kind: "wrapper", id: "fixture-wrapper" },
  allowedActions: ["work", "other"],
  actionMetadata: {},
  operationMetadata: { tenant: "space" },
  metadataConstraints: encodeOwnerMetadataConstraints({
    tenant: "space",
    forbidden: undefined,
    actorId: "api:credential",
    httpAdmissionKey: "fixture-group",
  }),
  group: { key: "fixture-group", actorId: "api:credential" },
};
function provenance(value = scope) {
  return {
    principalKey: value.principalKey,
    principal: value.principal,
    route: value.route,
    operationMetadata: value.operationMetadata,
    metadataConstraints: value.metadataConstraints,
  };
}
function policies(): OwnerHostPolicy {
  return {
    ingress: (_tx, context) =>
      context.fence.identity.workerId === "ingress"
        ? structuredClone(scope)
        : undefined,
    worker: () => ({ ctx: true, settlement: true }),
    input() {},
    collections: () => ({}),
    effectOutcome: () => true,
    effectNotStarted: () => false,
  };
}
function registry(
  hooks: { afterEffectBegin?(): void; deniedMutation?(): void } = {},
) {
  return createPluginRegistry({
    collections: {
      notes: defineCollection({
        name: "note",
        schema: {
          type: "object",
          properties: { id: { type: "string" }, title: { type: "string" } },
        } as const,
      }),
    },
    actions: {
      other: defineAction({
        id: "fixture.other",
        inputSchema: { type: "string" } as const,
        outputSchema: { type: "string" } as const,
        execute: (value: string) => `other:${value}`,
      }),
      work: defineAction({
        id: "fixture.work",
        inputSchema: { type: "string" } as const,
        outputSchema: { type: "string" } as const,
        async execute(value: string, ctx: ActionContext) {
          await ctx.transaction(
            ({ collections }) =>
              collections.notes.create({ id: value, title: value }),
            { operationKey: "write" },
          );
          if (value === "effect" || value === "effect-denied") {
            const begin = await ctx.effect.begin("send");
            if (begin.status !== "proceed") {
              throw new Error("expected first effect proceed");
            }
            hooks.afterEffectBegin?.();
            await ctx.effect.confirm("send", { sent: true });
            if ((await ctx.effect.inspect("send")).status !== "replay") {
              throw new Error("expected effect replay after ctx revocation");
            }
            if (value === "effect-denied") {
              try {
                await ctx.transaction(
                  ({ collections }) =>
                    collections.notes.create({
                      id: "forbidden",
                      title: "forbidden",
                    }),
                  { operationKey: "forbidden" },
                );
                throw new Error("revoked mutation unexpectedly committed");
              } catch (error) {
                if (
                  (error as Error).message ===
                    "revoked mutation unexpectedly committed"
                ) throw error;
                hooks.deniedMutation?.();
              }
            }
          }
          return `done:${value}`;
        },
      }),
    },
  });
}
function options(
  session: SqlSession,
  extras: Partial<OwnerHostOptions> = {},
): OwnerHostOptions {
  return {
    ownerId: "owner",
    holderId: "holder",
    schema: "public",
    initialization: "fresh",
    session,
    registry: registry(),
    policy: policies(),
    transport: {
      transports: [{
        type: "in-process",
        config: { topic: crypto.randomUUID() },
      }],
    },
    createTransport() {
      throw new Error("fixture transport must not be reached");
    },
    ...extras,
  };
}
test("owner host refuses missing current policy and unsupported Processor registration before opening schema", async () => {
  let reads = 0;
  const session: SqlSession = {
    query() {
      reads++;
      throw new Error("unexpected DB");
    },
    transaction() {
      reads++;
      throw new Error("unexpected DB");
    },
  };
  await assert.rejects(
    createOwnerHost(options(session, { policy: {} as OwnerHostPolicy })),
    /policy/,
  );
  const processors = createPluginRegistry({
    processors: {
      bad: defineProcessor({
        id: "fixture.processor",
        on: [{ eventType: "fixture" }],
        handle() {},
      }),
    },
  });
  await assert.rejects(
    createOwnerHost(options(session, { registry: processors })),
    /Processor/,
  );
  assert.equal(reads, 0);
});
test("owner host fenced fresh proof rejects orphan domain rows before constructing transport", async () => {
  const db = await createTestDatabase({ pgliteMemoryProfile: "low-memory" });
  let checkedUnderFence = false;
  let initialized = false;
  const session: SqlSession = {
    query: db.query,
    transaction: (callback) =>
      db.transaction(async (tx) => {
        let fenced = false;
        return await callback({
          async query(sql, params) {
            if (
              sql.startsWith("UPDATE") && sql.includes("owner_epochs")
            ) fenced = true;
            if (sql.startsWith('SELECT 1 FROM "public"."nodes" LIMIT')) {
              checkedUnderFence = fenced;
              return { rows: [{ id: "orphan" }] } as never;
            }
            return await tx.query(sql, params);
          },
        });
      }),
  };
  try {
    await assert.rejects(
      createOwnerHost(options(session, {
        createTransport() {
          initialized = true;
          throw new Error("unreachable");
        },
      })),
      /empty tables/,
    );
    assert.equal(checkedUnderFence, true);
    assert.equal(initialized, false);
  } finally {
    await db.close();
  }
});

test("owner host releases aborted unstarted ingress and bounds cancelled asynchronous admission", async () => {
  const db = await createTestDatabase({ pgliteMemoryProfile: "low-memory" });
  let calls!: OwnerHostTransportOptions["workerCalls"];
  const gate = deferred();
  let waiting = false;
  const host = await createOwnerHost(options(db, {
    maxPending: 1,
    maxActive: 1,
    policy: {
      ...policies(),
      async worker() {
        if (waiting) await gate.promise;
        return { ctx: true, settlement: true };
      },
    },
    createTransport(config) {
      calls = config.workerCalls;
      return {
        sessions: { assertCurrent: () => ({ phase: "ready" }) },
        prepare() {},
        snapshot: () => ({}),
        shutdown: () => Promise.resolve(),
      } as never;
    },
  }));
  const context = (
    signal: AbortSignal,
    workload = "copilotz.owner.action",
  ) => ({
    workload,
    metadata: { ownerId: "owner" },
    signal,
    fence: {
      identity: { workerId: "ingress", attemptId: "attempt", epoch: 1 },
      connectionId: "connection",
      sessionGeneration: 1,
    },
  });
  try {
    const first = new AbortController();
    assert.equal(
      typeof await calls.admitUnassigned!(context(first.signal)),
      "function",
    );
    first.abort();
    const second = new AbortController();
    assert.equal(
      typeof await calls.admitUnassigned!(context(second.signal)),
      "function",
      "unstarted cancellation releases authority capacity",
    );
    second.abort();
    waiting = true;
    const third = new AbortController();
    const pending = calls.admitUnassigned!(
      context(third.signal, "copilotz.owner.ready"),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    third.abort();
    gate.resolve();
    assert.equal(await pending, undefined);
    waiting = false;
    const fourth = new AbortController();
    assert.equal(
      typeof await calls.admitUnassigned!(context(fourth.signal)),
      "function",
    );
    fourth.abort();
  } finally {
    gate.resolve();
    await host.close();
    await db.close();
  }
});

test("owner host terminal notification follows ingress COMMIT uncertainty, not diagnostics", async () => {
  const db = await createTestDatabase({ pgliteMemoryProfile: "low-memory" });
  let loseAdmissionReply = false;
  let admissions!: OwnerHostTransportOptions["workerCalls"];
  let shutdowns = 0;
  const diagnostics: unknown[] = [];
  const session: SqlSession = {
    query: db.query,
    async transaction(run) {
      let rootAdmission = false;
      const result = await db.transaction((tx) =>
        run({
          async query(sql, params) {
            if (
              sql.startsWith("INSERT INTO") && sql.includes("owner_receipts") &&
              params?.includes("action.admit")
            ) rootAdmission = true;
            return await tx.query(sql, params);
          },
        })
      );
      if (rootAdmission && loseAdmissionReply) {
        loseAdmissionReply = false;
        throw new Error("fixture lost committed admission reply");
      }
      return result;
    },
  };
  const host = await createOwnerHost(options(session, {
    onError: (error) => diagnostics.push(error),
    createTransport(config) {
      admissions = config.workerCalls;
      return {
        sessions: { assertCurrent: () => ({ phase: "ready" }) },
        prepare() {},
        snapshot: () => ({}),
        shutdown() {
          shutdowns++;
          return Promise.resolve();
        },
      } as never;
    },
  }));
  let notifications = 0;
  void host.stopped.then(() => {
    assert.equal(host.snapshot().ready, false);
    assert.equal(host.snapshot().state, "stopped");
    notifications++;
  });
  const controller = new AbortController();
  const context = {
    workload: "copilotz.owner.action-call",
    metadata: { ownerId: "owner" },
    signal: controller.signal,
    fence: {
      identity: { workerId: "ingress", attemptId: "attempt", epoch: 1 },
      connectionId: "connection",
      sessionGeneration: 1,
    },
  };
  try {
    assert.equal(notifications, 0);
    const handler = await admissions.admitUnassigned!(context);
    assert.ok(handler);
    loseAdmissionReply = true;
    const reply = JSON.parse(new TextDecoder().decode(
      await handler({
        input: new ReadableStream({
          start(stream) {
            stream.enqueue(
              new TextEncoder().encode(
                JSON.stringify({
                  actionAlias: "work",
                  input: "uncertain",
                  operationKey: "uncertain",
                }),
              ),
            );
            stream.close();
          },
        }),
        signal: controller.signal,
      }),
    ));
    assert.deepEqual(reply, {
      ok: false,
      outcome: "unknown",
      code: "owner_commit_unknown",
    });
    await within(host.stopped);
    assert.equal(notifications, 1);
    assert.equal(host.snapshot().recoveryRequired, true);
    assert.equal(
      host.snapshot().pending,
      0,
      "unknown commit never schedules execution",
    );
    assert.equal(
      (await db.query(
        "SELECT key FROM owner_receipts WHERE kind='action.admit'",
      )).rows.length,
      1,
      "committed receipt remains durable for successor recovery",
    );
    assert.equal(await admissions.admitUnassigned!(context), undefined);
    assert.equal(
      diagnostics.length,
      1,
      "reentrant boundary and host retirement report once",
    );
    assert.equal(
      shutdowns,
      0,
      "terminal notification is separate from transport cleanup",
    );
  } finally {
    await host.close();
    await host.stopped;
    assert.equal(notifications, 1);
    assert.equal(shutdowns, 1);
    await db.close();
  }
});

const sourceRoot = process.env.COPILOTZ_OXIAN_SOURCE_ROOT;
for (const mode of ["in-process", "websocket"] as const) {
  test(
    `owner host actual tables + ${mode}: root admission, current policy, assignment, collection, result and settlement`,
    { skip: !sourceRoot, timeout: 45_000 },
    async () => {
      const { entrypoints } = await resolveOxianSource(sourceRoot!);
      const { createHypervisor } = await import(entrypoints["./hypervisor"]);
      const { createWorker } = await import(entrypoints["./worker"]);
      const { serve } = await import(entrypoints["./adapters/node"]);
      const db = await createTestDatabase({
        pgliteMemoryProfile: "low-memory",
      });
      const local = {
        type: "in-process" as const,
        config: { topic: crypto.randomUUID() },
      };
      const policy = policies();
      let authorized = true;
      let currentScope = structuredClone(scope);
      let ctxGranted = true;
      let deniedMutations = 0;
      let calls = 0;
      const errors: unknown[] = [];
      const reached = deferred(), release = deferred();
      let gate = true;
      const session: SqlSession = {
        query: db.query,
        transaction: (callback) =>
          db.transaction(async (tx) => {
            let admitted = false;
            const value = await callback({
              async query(sql, params) {
                if (
                  sql.startsWith("INSERT INTO") &&
                  sql.includes("owner_receipts") &&
                  params?.includes("action.admit")
                ) admitted = true;
                return await tx.query(sql, params);
              },
            });
            if (gate && admitted) {
              gate = false;
              reached.resolve();
              await release.promise;
            }
            return value;
          }),
      };
      const appRegistry = registry({
        afterEffectBegin() {
          ctxGranted = false;
        },
        deniedMutation() {
          deniedMutations++;
        },
      });
      const host = await createOwnerHost(options(session, {
        registry: appRegistry,
        maxActive: 1,
        maxPending: 64,
        onError: (error) => errors.push(error),
        policy: {
          ...policy,
          async ingress(tx, input, time) {
            calls++;
            return authorized && await policy.ingress(tx, input, time)
              ? structuredClone(currentScope)
              : undefined;
          },
          worker() {
            return { ctx: ctxGranted, settlement: true };
          },
        },
        transport: {
          transports: mode === "in-process"
            ? [local]
            : [{ type: "websocket", config: { path: "/workers" } }],
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
        },
        createTransport: createHypervisor,
      }));
      const listener = mode === "websocket"
        ? await serve({ hypervisor: host.listener })
        : undefined;
      const url = listener ? new URL("/workers", listener.url) : undefined;
      if (url) url.protocol = "ws:";
      const workerConfig = (id: string) => ({
        id,
        transport: url
          ? { type: "websocket", config: { url, allowInsecureLoopback: true } }
          : local,
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
      const worker = createOwnerConnectedWorker({
        registry: appRegistry,
        ownerId: "owner",
        namespace: "space",
        worker: workerConfig("action") as never,
        createCapabilities: () => ({ resources: {}, adapters: {} }),
      }, createWorker);
      const ingress = createWorker({
        ...workerConfig("ingress"),
        workloads: { unused: () => new Uint8Array() },
      });
      try {
        await within(Promise.all([worker.ready, ingress.ready]));
        assert.equal(host.snapshot().ready, true);
        const connection = createOwnerConnection({
          ownerId: "owner",
          callHost: ingress.callHost,
        });
        const command = {
          kind: "action.admit",
          domain: "logical" as const,
          key: ownerActionAdmissionKey("owner", "space", "request"),
          input: {
            namespace: "space",
            actionAlias: "work",
            requestId: "request",
            input: "note",
            metadata: {},
            provenance: provenance(),
          },
        };
        const admitted = connection.admitAction(command);
        await within(reached.promise);
        assert.equal(
          host.snapshot().pending,
          0,
          "dispatch remains behind outer commit",
        );
        release.resolve();
        const receipt = await within(admitted);
        const ref = receipt.result;
        await eventually(async () =>
          (await connection.actionResult(ref) as { status: string }).status !==
            "pending"
        );
        assert.deepEqual(await connection.actionResult(ref), {
          status: "completed",
          output: "done:note",
        });
        assert.equal(
          (await db.query(
            "SELECT title FROM (SELECT data->>'title' AS title FROM nodes WHERE id='note') n",
          )).rows[0].title,
          "note",
        );
        await eventually(async () =>
          (await db.query("SELECT state FROM copilotz_operations")).rows[0]
            ?.state === "completed"
        );
        await eventually(() => host.snapshot().active === 0);
        assert.equal(
          (await db.query(
            "SELECT max_attempts FROM event_deliveries WHERE consumer_id='registered:fixture.work'",
          )).rows[0].max_attempts,
          3,
        );
        const assignments = await db.query<
          { binding: Record<string, unknown>; retired: boolean }
        >("SELECT binding,retired FROM owner_assignments");
        assert.equal(assignments.rows.length, 1);
        assert.equal(assignments.rows[0].binding.workerId, "action");
        assert.notEqual(
          assignments.rows[0].binding.assignmentId,
          assignments.rows[0].binding.dispatchAttemptId,
        );
        const before = calls;
        assert.equal(
          (await connection.admitAction(command)).status,
          "duplicate",
        );
        assert.ok(calls > before);
        authorized = false;
        await assert.rejects(connection.admitAction(command));
        await assert.rejects(connection.actionResult(ref));
        authorized = true;
        const wrongRoute = structuredClone(command);
        wrongRoute.input.provenance.route = {
          kind: "generic",
          id: "fixture-wrapper",
        };
        await assert.rejects(connection.admitAction(wrongRoute));
        assert.equal(
          (await db.query("SELECT COUNT(*)::int AS count FROM nodes")).rows[0]
            .count,
          1,
        );
        assert.equal(
          (await db.query(
            "SELECT COUNT(*)::int AS count FROM owner_receipts WHERE kind='action.admit'",
          )).rows[0].count,
          1,
        );
        const simple = {
          actionAlias: "work",
          input: "simple",
          operationKey: "simple",
        };
        const simpleRef = (await connection.callAction(simple)).result;
        await eventually(async () =>
          (await connection.actionResult(simpleRef) as { status: string })
            .status !== "pending"
        );
        assert.deepEqual(await connection.actionResult(simpleRef), {
          status: "completed",
          output: "done:simple",
        });
        assert.equal((await connection.callAction(simple)).status, "duplicate");
        await assert.rejects(
          connection.callAction({ ...simple, input: "changed" }),
        );
        const otherRef = (await connection.callAction({
          ...simple,
          actionAlias: "other",
        })).result;
        assert.notDeepEqual(otherRef, simpleRef);
        await eventually(async () =>
          (await connection.actionResult(otherRef) as { status: string })
            .status !== "pending"
        );
        assert.deepEqual(await connection.actionResult(otherRef), {
          status: "completed",
          output: "other:simple",
        });
        currentScope = {
          ...scope,
          group: { key: "different-group", actorId: "different-actor" },
        };
        assert.equal(
          (await connection.callAction(simple)).status,
          "duplicate",
          "replay preserves the original captured group under current constraints",
        );
        await assert.rejects(connection.callAction({
          ...simple,
          operationKey: "wrong-group",
        }));
        currentScope = {
          ...scope,
          metadataConstraints: encodeOwnerMetadataConstraints({
            tenant: "space",
            actorId: undefined,
          }),
        };
        await assert.rejects(connection.callAction({
          ...simple,
          operationKey: "reserved-actor-must-be-absent",
        }));
        currentScope = structuredClone(scope);
        const captured = (await db.query<{ metadata: { ingress: unknown } }>(
          "SELECT metadata FROM events WHERE type='copilotz.owner.action.requested' AND metadata->>'requestId' LIKE 'root-call%' ORDER BY position LIMIT 1",
        )).rows[0];
        assert.deepEqual(captured.metadata.ingress, provenance());
        const facade = createOwnerActionCallers({
          actions: appRegistry.actions,
          namespace: "space",
          port: connection,
        });
        try {
          assert.equal(
            await facade.actions.work("facade", { operationKey: "facade" }),
            "done:facade",
          );
          assert.equal(
            await facade.actions.work("facade", { operationKey: "facade" }),
            "done:facade",
          );
          authorized = false;
          await assert.rejects(
            facade.actions.work("facade", { operationKey: "facade" }),
          );
          authorized = true;
        } finally {
          facade.close();
        }
        const effectRequest = {
          ...command,
          key: ownerActionAdmissionKey("owner", "space", "effect-request"),
          input: {
            ...command.input,
            requestId: "effect-request",
            input: "effect",
          },
        };
        const effectRef = (await connection.admitAction(effectRequest)).result;
        await eventually(async () =>
          (await connection.actionResult(effectRef) as { status: string })
            .status !== "pending"
        );
        assert.deepEqual(await connection.actionResult(effectRef), {
          status: "completed",
          output: "done:effect",
        });
        assert.equal(deniedMutations, 0);
        ctxGranted = true;
        const deniedRef = (await connection.callAction({
          actionAlias: "work",
          input: "effect-denied",
          operationKey: "denied",
        })).result;
        await eventually(async () =>
          (await connection.actionResult(deniedRef) as { status: string })
            .status !== "pending"
        );
        assert.deepEqual(await connection.actionResult(deniedRef), {
          status: "failed",
          code: "action_failed",
        });
        assert.equal(deniedMutations, 1);
        assert.equal(
          (await db.query(
            "SELECT COUNT(*)::int AS count FROM nodes WHERE id='forbidden'",
          )).rows[0].count,
          0,
        );
        assert.equal(
          (await db.query(
            "SELECT COUNT(*)::int AS count FROM owner_receipts WHERE kind='effect.confirm'",
          )).rows[0].count,
          2,
        );
        ctxGranted = true;
        await eventually(() => host.snapshot().active === 0);
        assert.deepEqual(errors, []);
        ctxGranted = false;
        const refusedRef = (await connection.callAction({
          actionAlias: "work",
          input: "dispatch-denied",
          operationKey: "dispatch-denied",
        })).result as { deliveryId: string };
        await eventually(() => Promise.resolve(errors.length > 0));
        assert.equal(
          host.snapshot().ready,
          true,
          "dispatch policy refusal does not stop owner settlement authority",
        );
        assert.deepEqual(
          (await db.query(
            "SELECT status,attempts FROM event_deliveries WHERE id=$1",
            [refusedRef.deliveryId],
          )).rows[0],
          { status: "pending", attempts: 0 },
        );
        assert.equal(
          (await db.query("SELECT id FROM nodes WHERE id='dispatch-denied'"))
            .rows.length,
          0,
        );
        ctxGranted = true;
        await host.wake();
        await eventually(async () =>
          (await connection.actionResult(refusedRef as never) as {
            status: string;
          }).status === "completed"
        );
        await eventually(() => host.snapshot().active === 0);
        await worker.close("saturation fixture");
        for (let index = 0; index < 32; index++) {
          const requestId = `queued-${index}`;
          await connection.admitAction({
            ...command,
            key: ownerActionAdmissionKey("owner", "space", requestId),
            input: { ...command.input, requestId, input: requestId },
          });
        }
        await assert.rejects(
          connection.admitAction({
            ...command,
            key: ownerActionAdmissionKey("owner", "space", "overflow"),
            input: {
              ...command.input,
              requestId: "overflow",
              input: "overflow",
            },
          }),
        );
        assert.equal(
          (await db.query(
            "SELECT COUNT(*)::int AS count FROM copilotz_operations WHERE state IN ('accepted','running')",
          )).rows[0].count,
          32,
        );
        assert.equal(
          (await db.query(
            "SELECT COUNT(*)::int AS count FROM owner_alarms WHERE name LIKE '%host.delivery%'",
          )).rows[0].count,
          32,
          "refused dispatch preserves durable wakeups",
        );
        await host.wake();
        assert.equal(host.snapshot().ready, true);
      } finally {
        release.resolve();
        await ingress.stop("done");
        await worker.close("done");
        await host.close();
        await listener?.shutdown();
        await db.close();
      }
    },
  );
}
