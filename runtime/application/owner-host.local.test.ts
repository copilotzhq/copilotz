import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveOxianSource } from "../../scripts/test-owner-connected.mjs";
import { defineAction } from "../actions/define.ts";
import type { ActionContext, RuntimeActionCallers } from "../actions/types.ts";
import { defineView } from "../views/definition.ts";
import type { OwnerHostLocalProcessorOptions } from "./owner-host-local-processor.ts";
import { defineCollection } from "../collections/definition.ts";
import type { SqlSession } from "../events/session.ts";
import { createOwnerConnection } from "../owner/connection.ts";
import { encodeOwnerMetadataConstraints } from "../owner/metadata-constraints.ts";
import type { OwnerLocalActionAssignmentBinding } from "../owner/placement-binding.ts";
import {
  defineProcessor,
  type ProcessorContext,
} from "../plugins/processor.ts";
import {
  createPluginRegistry,
  type PluginRegistry,
} from "../plugins/registry.ts";
import { createTestDatabase } from "../testing/ominipg.ts";
import { createOwnerActionCallers } from "./owner-actions.ts";
import {
  captureOwnerHostLocalActions,
  type OwnerHostLocalActionOptions,
} from "./owner-host-local.ts";
import {
  createOwnerHost,
  type OwnerHostOptions,
  type OwnerHostPolicy,
} from "./owner-host.ts";
import { createOwnerConnectedWorker } from "./owner-worker.ts";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((yes) => resolve = yes);
  return { promise, resolve };
}
async function eventually(check: () => boolean | Promise<boolean>) {
  const until = Date.now() + 15_000;
  while (!await check()) {
    if (Date.now() >= until) throw new Error("Local host fixture timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
function outcome<T>(promise: Promise<T>) {
  return promise.then(
    (value) => ({ value, error: undefined }),
    (error: unknown) => ({ value: undefined, error }),
  );
}
const notes = defineCollection({
  name: "local_note",
  schema: {
    type: "object",
    properties: { id: { type: "string" }, title: { type: "string" } },
    required: ["id", "title"],
  } as const,
});
function ordinaryRegistry(
  execute = (value: string, _ctx: ActionContext) => Promise.resolve(value),
) {
  return createPluginRegistry({
    collections: { notes },
    actions: {
      work: defineAction({
        id: "fixture.local",
        inputSchema: { type: "string" } as const,
        outputSchema: { type: "string" } as const,
        execute,
      }),
    },
  });
}
function localOptions(
  extra: Partial<OwnerHostLocalActionOptions> = {},
): OwnerHostLocalActionOptions {
  return {
    actionIds: ["fixture.local"],
    policy: {
      grants: () => ({ ctx: true, settlement: true }),
      input() {},
      collections: () => ({}),
    },
    createCapabilities: () => ({ resources: {}, adapters: {} }),
    ...extra,
  };
}
function baseOptions(
  session: SqlSession,
  registry: PluginRegistry = ordinaryRegistry(),
): OwnerHostOptions {
  return {
    ownerId: "owner",
    holderId: "holder",
    schema: "public",
    session,
    initialization: "fresh",
    registry,
    policy: {
      ingress: (_tx, { fence }) =>
        fence.identity.workerId === "ingress"
          ? {
            namespace: "space",
            principalKey: "api:local-fixture",
            principal: { actorId: "api:local-fixture" },
            route: { kind: "wrapper", id: "local-fixture" },
            allowedActions: Object.keys(registry.actions),
            actionMetadata: { source: "trusted-ingress" },
            operationMetadata: { tenant: "space" },
            metadataConstraints: encodeOwnerMetadataConstraints({
              tenant: "space",
              actorId: "api:local-fixture",
            }),
            group: { key: "local-fixture", actorId: "api:local-fixture" },
          }
          : undefined,
      worker: () => ({ ctx: true, settlement: true }),
      input() {},
      collections: () => ({}),
      processorEvent() {},
      effectOutcome: () => false,
      effectNotStarted: () => false,
    },
    transport: { transports: [] },
    createTransport() {
      throw new Error("A real compatible transport must be supplied");
    },
  };
}

const sourceRoot = process.env.COPILOTZ_OXIAN_SOURCE_ROOT;
type Mode = "in-process" | "websocket";
async function fixture(input: {
  registry?: PluginRegistry;
  mode?: Mode;
  maxActive?: number;
  callWaitMs?: number;
  local?: OwnerHostLocalActionOptions;
  policy?: Partial<OwnerHostPolicy>;
  preparation?: OwnerHostOptions["preparation"];
  processors?: OwnerHostLocalProcessorOptions;
  session?(db: SqlSession): SqlSession;
  beforeReady?(): Promise<void>;
  shutdownFailure?: Readonly<{ error: Error; observed(): void }>;
}) {
  const { entrypoints } = await resolveOxianSource(sourceRoot!);
  const { createHypervisor } = await import(entrypoints["./hypervisor"]);
  const { createWorker } = await import(entrypoints["./worker"]);
  const { serve } = await import(entrypoints["./adapters/node"]);
  const db = await createTestDatabase({ pgliteMemoryProfile: "low-memory" });
  const registry = input.registry ?? ordinaryRegistry();
  const errors: unknown[] = [];
  let workerActionFactories = 0, workerProcessorFactories = 0;
  const local = {
    type: "in-process" as const,
    config: { topic: crypto.randomUUID() },
  };
  const options: OwnerHostOptions = {
    ...baseOptions(input.session?.(db) ?? db, registry),
    policy: { ...baseOptions(db, registry).policy, ...input.policy },
    maxActive: input.maxActive ?? 4,
    maxPending: 32,
    ...(input.preparation ? { preparation: input.preparation } : {}),

    onError: (error) => errors.push(error),
    transport: {
      transports: input.mode === "websocket"
        ? [{ type: "websocket", config: { path: "/workers" } }]
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
    },
    createTransport(options, lifecycle) {
      const transport = createHypervisor(options, lifecycle);
      const failure = input.shutdownFailure;
      if (!failure) return transport;
      const shutdown = transport.shutdown.bind(transport);
      return {
        ...transport,
        async shutdown(reason) {
          await shutdown(reason);
          failure.observed();
          throw failure.error;
        },
      };
    },
  };
  const starting = createOwnerHost(
    options,
    undefined,
    {
      actions: input.local ?? localOptions(),
      ...(input.processors ? { processors: input.processors } : {}),
    },
  );
  let host: Awaited<ReturnType<typeof createOwnerHost>>;
  try {
    await input.beforeReady?.();
    host = await starting;
  } catch (error) {
    await db.close();
    throw error;
  }
  const listener = input.mode === "websocket"
    ? await serve({ hypervisor: host.listener })
    : undefined;
  const url = listener ? new URL("/workers", listener.url) : undefined;
  if (url) url.protocol = "ws:";
  const workerOptions = (id: string) => ({
    id,
    transport: url
      ? { type: "websocket", config: { url, allowInsecureLoopback: true } }
      : local,
    capacity: 4,
    hostCalls: { maxConcurrent: 16, timeoutMs: 10_000 },
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
    registry,
    ownerId: "owner",
    namespace: "space",
    worker: workerOptions("execution") as never,
    createCapabilities: () => {
      workerActionFactories++;
      return { resources: registry.resources, adapters: registry.adapters };
    },
    createProcessorCapabilities: () => {
      workerProcessorFactories++;
      return { resources: registry.resources, adapters: registry.adapters };
    },
  }, createWorker);
  const ingress = createWorker({
    ...workerOptions("ingress"),
    workloads: { unused: () => new Uint8Array() },
  });
  const facade = createOwnerActionCallers({
    actions: registry.actions,
    namespace: "space",
    maxWaitMs: input.callWaitMs ?? 15_000,
    port: createOwnerConnection({
      ownerId: "owner",
      callHost: ingress.callHost,
    }),
  });
  let shutdown: Promise<void> | undefined;
  const stop = () =>
    shutdown ??= (async () => {
      facade.close();
      await Promise.allSettled([
        ingress.stop("fixture finished"),
        worker.close("fixture finished"),
      ]);
      const cleanup = await Promise.allSettled([
        host.close(),
        listener?.shutdown(),
      ]);
      for (const result of cleanup) {
        // This fixture alone deliberately injects the exact cleanup failure.
        if (
          result.status === "rejected" &&
          result.reason !== input.shutdownFailure?.error
        ) throw result.reason;
      }
    })();
  try {
    await Promise.all([worker.ready, ingress.ready]);
  } catch (error) {
    await stop();
    await db.close();
    throw error;
  }
  return {
    db,
    host,
    options,
    errors,
    facade,
    counts: () => ({ workerActionFactories, workerProcessorFactories }),
    shutdown: stop,
    async close() {
      try {
        await stop();
      } finally {
        await db.close();
      }
    },
  };
}

test("local host options refuse resume and malformed selection before SQL or transport", async () => {
  let sql = 0, transports = 0;
  const session: SqlSession = {
    query() {
      sql++;
      throw new Error("unexpected SQL");
    },
    transaction() {
      sql++;
      throw new Error("unexpected SQL");
    },
  };
  const options: OwnerHostOptions = {
    ...baseOptions(session),
    createTransport() {
      transports++;
      throw new Error("unexpected transport");
    },
  };
  await assert.rejects(createOwnerHost(
    {
      ...options,
      initialization: { mode: "resume", expectedEpoch: 1 },
    },
    undefined,
    { actions: localOptions() },
  ));
  for (
    const invalid of [
      null,
      [],
      {},
      { ...localOptions(), actionIds: "fixture.local" },
      { ...localOptions(), actionIds: ["missing"] },
      { ...localOptions(), actionIds: ["work"] },
      { ...localOptions(), actionIds: ["fixture.local", "fixture.local"] },
      { ...localOptions(), actionIds: [" fixture.local"] },
      { ...localOptions(), createCapabilities: null },
      { ...localOptions(), policy: null },
      ...["grants", "input", "collections"].map((name) => ({
        ...localOptions(),
        policy: { ...localOptions().policy, [name]: null },
      })),
      ...[0, -1, 1.5, 4097, NaN, "1", null, undefined].map((maxEntries) => ({
        ...localOptions(),
        maxEntries,
      })),
      ...[0, -1, 1.5, 60001, NaN, "1", null, undefined].map((childWaitMs) => ({
        ...localOptions(),
        childWaitMs,
      })),
      ...[0, -1, 1.5, 129, NaN, "1", null, undefined].map((
        maxPendingCalls,
      ) => ({
        ...localOptions(),
        maxPendingCalls,
      })),
    ]
  ) {
    await assert.rejects(
      createOwnerHost(options, undefined, { actions: invalid as never }),
    );
  }
  let bundleGetters = 0;
  for (
    const invalid of [
      null,
      [],
      {},
      { actions: undefined },
      { processors: undefined },
      { unknown: localOptions() },
      localOptions(),
      Object.defineProperty({}, "actions", {
        enumerable: true,
        get() {
          bundleGetters++;
          return localOptions();
        },
      }),
    ]
  ) {
    await assert.rejects(createOwnerHost(options, undefined, invalid as never));
  }
  assert.equal(bundleGetters, 0);
  assert.equal(sql, 0);
  assert.equal(transports, 0);
});

test("local host option capture rejects accessors and non-own-data shapes without invoking getters", () => {
  const registry = ordinaryRegistry();
  let getters = 0;
  const invalid: unknown[] = [
    { ...localOptions(), unexpected: true },
    {
      ...localOptions(),
      policy: { ...localOptions().policy, unexpected: true },
    },
    Object.assign(Object.create({ inherited: true }), localOptions()),
    {
      ...localOptions(),
      policy: Object.assign(
        Object.create({ inherited: true }),
        localOptions().policy,
      ),
    },
  ];
  for (
    const key of [
      "actionIds",
      "policy",
      "createCapabilities",
      "maxEntries",
      "maxPendingCalls",
    ]
  ) {
    invalid.push(Object.defineProperty({ ...localOptions() }, key, {
      enumerable: true,
      get() {
        getters++;
        return undefined;
      },
    }));
  }
  for (const key of ["grants", "input", "collections"]) {
    invalid.push({
      ...localOptions(),
      policy: Object.defineProperty({ ...localOptions().policy }, key, {
        enumerable: true,
        get() {
          getters++;
          return () => undefined;
        },
      }),
    });
  }
  for (const key of ["hidden", Symbol("hidden")]) {
    invalid.push(
      Object.defineProperty({ ...localOptions() }, key, { value: true }),
    );
    invalid.push({
      ...localOptions(),
      policy: Object.defineProperty({ ...localOptions().policy }, key, {
        value: true,
      }),
    });
    invalid.push({
      ...localOptions(),
      actionIds: Object.defineProperty(["fixture.local"], key, { value: true }),
    });
  }
  invalid.push(
    { ...localOptions(), actionIds: [] },
    { ...localOptions(), actionIds: new Array(1) },
    {
      ...localOptions(),
      actionIds: Object.assign(["fixture.local"], { extra: true }),
    },
    {
      ...localOptions(),
      actionIds: Object.setPrototypeOf(
        ["fixture.local"],
        Object.create(Array.prototype),
      ),
    },
    {
      ...localOptions(),
      actionIds: Object.defineProperty(["fixture.local"], "0", {
        enumerable: true,
        get() {
          getters++;
          return "fixture.local";
        },
      }),
    },
    {
      ...localOptions(),
      actionIds: Object.defineProperty(["fixture.local"], "0", {
        value: "fixture.local",
        enumerable: false,
      }),
    },
  );
  for (const candidate of invalid) {
    assert.throws(() =>
      captureOwnerHostLocalActions(candidate as never, registry)
    );
  }
  assert.equal(
    getters,
    0,
    "validation must inspect descriptors without invoking supplied accessors",
  );
});

test("local host pure capture retains callbacks, dense IDs and exact supported bounds", () => {
  for (const [maxEntries, maxPendingCalls] of [[1, 1], [4096, 128]]) {
    const configured = {
      ...localOptions(),
      actionIds: ["fixture.local"],
      policy: { ...localOptions().policy },
      maxEntries,
      maxPendingCalls,
    };
    const original = { ...configured.policy };
    const capabilities = configured.createCapabilities;
    const captured = captureOwnerHostLocalActions(
      configured,
      ordinaryRegistry(),
    );
    configured.actionIds[0] = "changed";
    configured.policy.grants = () => undefined;
    configured.policy.input = () => {
      throw new Error("replaced");
    };
    configured.policy.collections = () => {
      throw new Error("replaced");
    };
    configured.createCapabilities = () => {
      throw new Error("replaced");
    };
    configured.maxEntries = 0;
    configured.maxPendingCalls = 0;
    assert.equal(captured.selects("fixture.local"), true);
    assert.equal(captured.selects("changed"), false);
    assert.equal(captured.policy.grants, original.grants);
    assert.equal(captured.policy.input, original.input);
    assert.equal(captured.policy.collections, original.collections);
    assert.equal(captured.createCapabilities, capabilities);
    assert.equal(captured.maxEntries, maxEntries);
    assert.equal(captured.maxPendingCalls, maxPendingCalls);
  }
});

for (const mode of ["in-process", "websocket"] as const) {
  for (const maxActive of [1, 2]) {
    test(
      `local host ${mode}/${maxActive}: exact local Collection identity and real worker Processors share capacity`,
      { skip: !sourceRoot, timeout: 45_000 },
      async () => {
        const releaseLocal = deferred(), releaseProcessors = deferred();
        let localWaiting = false, localFactories = 0, live = 0, peak = 0;
        const processorStarts: string[] = [];
        const factoryInputs: Parameters<
          OwnerHostLocalActionOptions["createCapabilities"]
        >[0][] = [];
        const enter = () => {
          live++;
          peak = Math.max(peak, live);
          assert.ok(live <= maxActive, "local and worker code share one bound");
        };
        const handle =
          (name: string) => async (_event: unknown, ctx: ProcessorContext) => {
            enter();
            processorStarts.push(name);
            try {
              await releaseProcessors.promise;
              await ctx.transaction(
                ({ collections }) =>
                  collections.notes.create({
                    id: `processor:${name}`,
                    title: name,
                  }),
                { operationKey: "write" },
              );
            } finally {
              live--;
            }
          };
        const registry = createPluginRegistry({
          collections: { notes },
          actions: {
            work: defineAction({
              id: "fixture.local",
              inputSchema: { type: "string" } as const,
              outputSchema: { type: "string" } as const,
              async execute(value: string, ctx: ActionContext) {
                enter();
                try {
                  await ctx.transaction(
                    ({ collections }) =>
                      collections.notes.create({
                        id: "local:note",
                        title: value,
                      }),
                    { operationKey: "write" },
                  );
                  localWaiting = true;
                  await releaseLocal.promise;
                  return `local:${value}`;
                } finally {
                  live--;
                }
              },
            }),
          },
          processors: {
            invoked: defineProcessor({
              id: "fixture.invoked",
              on: [{ eventType: "fixture.local.invoked" }],
              handle: handle("invoked"),
            }),
            created: defineProcessor({
              id: "fixture.created",
              on: [{
                eventType: "local_note.created",
                subject: { id: "local:note" },
              }],
              handle: handle("created"),
            }),
          },
        });
        const f = await fixture({
          registry,
          mode,
          maxActive,
          local: localOptions({
            createCapabilities(input) {
              localFactories++;
              assert.deepEqual(Object.keys(input).sort(), [
                "invocation",
                "reference",
                "registry",
                "signal",
              ]);
              factoryInputs.push(input);
              return { resources: {}, adapters: {} };
            },
          }),
        });
        try {
          const result = outcome(
            f.facade.actions.work("ordinary", { operationKey: "one" }),
          );
          await eventually(() => localWaiting);
          await eventually(async () =>
            (await f.db.query(
              "SELECT id FROM event_deliveries WHERE consumer_id LIKE 'processor:%'",
            ))
              .rows.length === 2
          );
          if (maxActive === 2) {
            await eventually(() => processorStarts.length === 1);
          }
          assert.equal(processorStarts.length, maxActive - 1);
          assert.equal(f.host.snapshot().active, maxActive);
          assert.equal(localFactories, 1);
          assert.equal(f.counts().workerActionFactories, 0);
          const source = (await f.db.query<{
            id: string;
            event_id: string;
            settlement_scope_id: string;
            status: string;
            attempts: number;
            lease_owner: string;
            lease_expires_at: null;
            correlation_id: string;
            metadata: {
              actionId: string;
              actionRunId: string;
              rootKey: string;
            };
          }>(
            "SELECT d.id,d.event_id,d.settlement_scope_id,d.status,d.attempts,d.lease_owner,d.lease_expires_at,e.correlation_id,e.metadata FROM event_deliveries d JOIN events e ON e.id=d.event_id WHERE d.consumer_id='registered:fixture.local'",
          )).rows[0];
          const assignment = (await f.db.query<{
            binding: OwnerLocalActionAssignmentBinding;
            retired: boolean;
          }>(
            "SELECT binding,retired FROM owner_assignments WHERE delivery_id=$1",
            [source.id],
          )).rows;
          assert.equal(assignment.length, 1);
          const binding = assignment[0].binding;
          assert.equal(assignment[0].retired, false);
          assert.equal(binding.placement, "owner-local");
          assert.equal(binding.kind, "action");
          assert.equal(binding.ownerId, "owner");
          assert.equal(binding.epoch, 1);
          assert.equal(binding.holderId, "holder");
          assert.equal(binding.namespace, "space");
          assert.equal(binding.deliveryId, source.id);
          assert.equal(binding.sourceEventId, source.event_id);
          assert.equal(binding.actionId, source.metadata.actionId);
          assert.equal(binding.actionRunId, source.metadata.actionRunId);
          assert.equal(source.status, "leased");
          assert.equal(source.attempts, 1);
          assert.equal(source.lease_owner, binding.attemptId);
          assert.equal(source.lease_expires_at, null);
          for (
            const key of [
              "workerId",
              "workerAttemptId",
              "sessionId",
              "assignmentId",
              "dispatchAttemptId",
            ]
          ) {
            assert.equal(Object.hasOwn(binding, key), false);
            assert.equal(Object.hasOwn(factoryInputs[0].reference, key), false);
          }
          assert.deepEqual(factoryInputs[0].reference, binding);
          assert.equal(
            factoryInputs[0].invocation.invocation.identity?.causationId,
            source.event_id,
          );
          assert.equal(
            factoryInputs[0].invocation.invocation.identity?.correlationId,
            source.correlation_id,
          );
          assert.equal(
            factoryInputs[0].invocation.invocation.identity?.settlementScopeId,
            source.settlement_scope_id,
          );
          assert.deepEqual(factoryInputs[0].invocation.invocation.metadata, {
            source: "trusted-ingress",
          });
          const alarmName = JSON.stringify([
            "host.delivery",
            "space",
            source.id,
          ]);
          assert.equal(
            (await f.db.query("SELECT name FROM owner_alarms WHERE name=$1", [
              alarmName,
            ])).rows.length,
            0,
          );
          assert.equal(
            (await f.db.query(
              "SELECT name FROM owner_alarms WHERE name LIKE '%host.delivery%'",
            )).rows.length,
            3 - maxActive,
            "only not-yet-started Processors retain availability alarms",
          );
          await f.host.wake();
          await f.host.wake();
          assert.equal(
            localFactories,
            1,
            "duplicate wake never reruns a local Action",
          );
          assert.equal(processorStarts.length, maxActive - 1);
          releaseLocal.resolve();
          const finished = await result;
          assert.equal(finished.error, undefined);
          assert.equal(finished.value, "local:ordinary");
          await eventually(() => processorStarts.length === maxActive);
          assert.equal(f.host.snapshot().active, maxActive);
          assert.notEqual(
            (await f.db.query(
              "SELECT state FROM copilotz_operations WHERE operation_id=$1",
              [source.settlement_scope_id],
            )).rows[0].state,
            "completed",
            "ordinary Action completion does not settle pending Processor work",
          );
          releaseProcessors.resolve();
          await eventually(() =>
            processorStarts.length === 2 && f.host.snapshot().active === 0
          );
          await eventually(async () =>
            (await f.db.query(
              "SELECT state FROM copilotz_operations WHERE operation_id=$1",
              [source.settlement_scope_id],
            )).rows[0].state === "completed"
          );
          assert.equal(peak, maxActive);
          assert.deepEqual([...processorStarts].sort(), ["created", "invoked"]);
          assert.deepEqual(f.counts(), {
            workerActionFactories: 0,
            workerProcessorFactories: 2,
          });
          const assignments = (await f.db.query<
            { binding: Record<string, unknown>; retired: boolean }
          >("SELECT binding,retired FROM owner_assignments")).rows;
          assert.equal(assignments.length, 3);
          assert.ok(assignments.every((row) => row.retired));
          const workers = assignments.filter((row) =>
            row.binding.placement === "worker"
          );
          assert.equal(workers.length, 2);
          assert.ok(
            workers.every((row) =>
              row.binding.kind === "processor" &&
              row.binding.workerId === "execution"
            ),
          );
          const terminal = (await f.db.query(
            "SELECT status,attempts,lease_expires_at FROM event_deliveries WHERE id=$1",
            [source.id],
          )).rows[0];
          assert.equal(terminal.status, "succeeded");
          assert.equal(terminal.attempts, 1);
          assert.equal(terminal.lease_expires_at, null);
          const created = (await f.db.query<
            { id: string; causation_id: string; correlation_id: string }
          >(
            "SELECT id,causation_id,correlation_id FROM events WHERE type='local_note.created' AND causation_id=$1",
            [source.event_id],
          )).rows;
          assert.equal(created.length, 1);
          assert.equal(created[0].correlation_id, source.correlation_id);
          assert.deepEqual(
            (await f.db.query(
              "SELECT operation_id FROM copilotz_operation_events WHERE event_id=$1",
              [created[0].id],
            )).rows,
            [{ operation_id: source.settlement_scope_id }],
          );
          assert.equal(
            (await f.db.query("SELECT id FROM nodes WHERE id='local:note'"))
              .rows.length,
            1,
          );
          assert.equal(
            (await f.db.query(
              "SELECT kind FROM owner_receipts WHERE kind='owner.local-start'",
            )).rows.length,
            1,
          );
          assert.deepEqual(f.errors, []);
          assert.equal(f.host.snapshot().ready, true);
        } finally {
          releaseLocal.resolve();
          releaseProcessors.resolve();
          await f.close();
        }
      },
    );
  }
}

test("local host rechecks current grants after awaited Collection policy", {
  skip: !sourceRoot,
  timeout: 30_000,
}, async () => {
  const entered = deferred(), release = deferred();
  let ctxAllowed = true, currentChecks = 0;
  const configured = localOptions({
    policy: {
      grants(_tx, authority) {
        if (authority.phase === "current") currentChecks++;
        return { ctx: ctxAllowed, settlement: true };
      },
      input() {},
      async collections() {
        entered.resolve();
        await release.promise;
        return {};
      },
    },
  });
  const f = await fixture({
    local: configured,
    registry: ordinaryRegistry(async (value, ctx) => {
      await ctx.transaction(
        ({ collections }) =>
          collections.notes.create({ id: "forbidden", title: value }),
        { operationKey: "write" },
      );
      return value;
    }),
  });
  try {
    const result = outcome(
      f.facade.actions.work("revoked", { operationKey: "revoked" }),
    );
    await entered.promise;
    const before = currentChecks;
    ctxAllowed = false;
    release.resolve();
    assert.ok((await result).error);
    await eventually(() => f.host.snapshot().active === 0);
    assert.ok(
      currentChecks > before,
      "the post-await check uses current local policy",
    );
    assert.equal(
      (await f.db.query("SELECT id FROM nodes WHERE id='forbidden'")).rows
        .length,
      0,
    );
    assert.equal(
      (await f.db.query(
        "SELECT kind FROM owner_receipts WHERE kind='collections'",
      )).rows.length,
      0,
    );
    assert.equal(
      (await f.db.query(
        "SELECT status FROM event_deliveries WHERE consumer_id='registered:fixture.local'",
      )).rows[0].status,
      "dead_letter",
    );
    assert.equal(
      (await f.db.query("SELECT retired FROM owner_assignments")).rows[0]
        .retired,
      true,
    );
    assert.equal(
      f.host.snapshot().ready,
      true,
      "ctx revocation preserves separately granted terminal settlement",
    );
    assert.equal(f.counts().workerActionFactories, 0);
  } finally {
    release.resolve();
    await f.close();
  }
});

test(
  "local host captures selection, callbacks and budgets before the first provisioning await",
  { skip: !sourceRoot, timeout: 30_000 },
  async () => {
    const entered = deferred(), release = deferred();
    const counts = {
      grants: 0,
      input: 0,
      collections: 0,
      capabilities: 0,
      replaced: 0,
    };
    const selected = ["fixture.local"];
    const policy = {
      grants() {
        counts.grants++;
        return { ctx: true, settlement: true };
      },
      input() {
        counts.input++;
      },
      collections() {
        counts.collections++;
        return {};
      },
    };
    const configured = {
      actionIds: selected,
      policy,
      maxEntries: 2,
      maxPendingCalls: 2,
      createCapabilities() {
        counts.capabilities++;
        return { resources: {}, adapters: {} };
      },
    };
    const replaced = (): never => {
      counts.replaced++;
      throw new Error("mutated configuration must not run");
    };
    const f = await fixture({
      local: configured,
      registry: ordinaryRegistry(async (value, ctx) => {
        await ctx.transaction(
          ({ collections }) =>
            collections.notes.create({ id: value, title: value }),
          {
            operationKey: "write",
          },
        );
        return value;
      }),
      session(db) {
        let first = true;
        const hold = async () => {
          if (!first) return;
          first = false;
          entered.resolve();
          await release.promise;
        };
        return {
          async query(sql, values) {
            await hold();
            return await db.query(sql, values);
          },
          async transaction(run) {
            await hold();
            return await db.transaction(run);
          },
        };
      },
      async beforeReady() {
        await entered.promise;
        selected.splice(0, 1, "missing");
        policy.grants = replaced;
        policy.input = replaced;
        policy.collections = replaced;
        configured.policy = {
          grants: replaced,
          input: replaced,
          collections: replaced,
        };
        configured.createCapabilities = replaced;
        configured.maxEntries = 0;
        configured.maxPendingCalls = 0;
        release.resolve();
      },
    });
    try {
      assert.equal(
        await f.facade.actions.work("first", { operationKey: "first" }),
        "first",
      );
      assert.equal(
        await f.facade.actions.work("second", { operationKey: "second" }),
        "second",
      );
      await eventually(() => f.host.snapshot().active === 0);
      assert.equal(counts.capabilities, 2);
      assert.ok(
        counts.grants > 0 && counts.input > 0 && counts.collections >= 2,
      );
      assert.equal(counts.replaced, 0);
      assert.equal(f.counts().workerActionFactories, 0);
      assert.equal(
        (await f.db.query(
          "SELECT id FROM nodes WHERE id IN ('first','second')",
        )).rows.length,
        2,
      );
      assert.deepEqual(f.errors, []);
    } finally {
      release.resolve();
      await f.close();
    }
  },
);

test(
  "local host refuses named preparation without owner registration",
  { skip: !sourceRoot, timeout: 30_000 },
  async () => {
    let childCalls = 0;
    const observed: string[] = [];
    const registry = createPluginRegistry({
      actions: {
        work: defineAction({
          id: "fixture.local",
          inputSchema: { type: "string" } as const,
          async execute(kind: string, ctx: ActionContext) {
            try {
              await ctx.actions.child.prepareNamed({
                preparation: "notes.context",
                recordId: "record",
                mode: "context",
              }, { operationKey: "prepared" });
            } catch {
              observed.push(kind);
            }
            return "catching unsupported capability cannot certify success";
          },
        }),
        child: defineAction({
          id: "fixture.child",
          execute() {
            childCalls++;
            return "unexpected";
          },
        }),
      },
    });
    const f = await fixture({ registry });
    try {
      for (const kind of ["preparation"]) {
        await assert.rejects(
          f.facade.actions.work(kind, { operationKey: kind }),
        );
        await eventually(() => f.host.snapshot().active === 0);
      }
      assert.deepEqual(observed, ["preparation"]);
      assert.equal(childCalls, 0);
      assert.equal(f.counts().workerActionFactories, 0);
      const deliveries = (await f.db.query(
        "SELECT consumer_id,status,attempts FROM event_deliveries",
      )).rows;
      assert.equal(deliveries.length, 1);
      assert.ok(
        deliveries.every((row) =>
          row.consumer_id === "registered:fixture.local" &&
          row.status === "dead_letter" && row.attempts === 1
        ),
      );
      assert.equal(
        (await f.db.query(
          "SELECT kind FROM owner_receipts WHERE kind LIKE 'effect.%' OR kind LIKE 'action.child%'",
        )).rows.length,
        0,
      );
      assert.equal(
        (await f.db.query(
          "SELECT id FROM events WHERE metadata ? 'preparation'",
        )).rows.length,
        0,
      );
      assert.equal(f.host.snapshot().ready, true);
    } finally {
      await f.close();
    }
  },
);

test(
  "local host close revokes immediately but drains a noncooperative factory without releasing uncertain occupancy",
  { skip: !sourceRoot, timeout: 30_000 },
  async () => {
    const entered = deferred(), release = deferred();
    let authored = 0, factories = 0, closed = false;
    let signal: AbortSignal | undefined;
    let abortSnapshot:
      | ReturnType<Awaited<ReturnType<typeof createOwnerHost>>["snapshot"]>
      | undefined;
    const f = await fixture({
      maxActive: 1,
      registry: ordinaryRegistry((value) => {
        authored++;
        return Promise.resolve(value);
      }),
      local: localOptions({
        async createCapabilities(input) {
          factories++;
          signal = input.signal;
          input.signal.addEventListener("abort", () => {
            abortSnapshot = f.host.snapshot();
          }, { once: true });
          entered.resolve();
          await release.promise; // Deliberately ignores abort until the fixture releases it.
          return { resources: {}, adapters: {} };
        },
      }),
    });
    try {
      const first = outcome(
        f.facade.actions.work("held", { operationKey: "held" }),
      );
      await entered.promise;
      assert.equal(f.host.snapshot().active, 1);
      const second = outcome(
        f.facade.actions.work("queued", { operationKey: "queued" }),
      );
      await eventually(async () =>
        (await f.db.query("SELECT id FROM event_deliveries")).rows.length === 2
      );
      const rawClosing = f.host.close();
      assert.equal(
        f.host.close("duplicate close"),
        rawClosing,
        "duplicate close returns the same pending actual drain",
      );
      const closing = rawClosing.then(() => {
        closed = true;
      });
      assert.equal(f.host.snapshot().ready, false);
      assert.equal(signal?.aborted, true);
      assert.equal(
        abortSnapshot?.ready,
        false,
        "authority is gone before exposed abort listeners run",
      );
      await f.host.stopped;
      // Give transport shutdown and ordinary cancellation work time to settle;
      // the deliberately unresolved factory is the remaining explicit barrier.
      await new Promise((resolve) => setTimeout(resolve, 30));
      assert.equal(closed, false, "close waits for the actual factory promise");
      assert.equal(
        f.host.snapshot().active,
        1,
        "revocation is not proof of terminal release",
      );
      assert.equal(factories, 1);
      assert.equal(authored, 0);
      assert.equal(f.counts().workerActionFactories, 0);
      release.resolve();
      await closing;
      await Promise.all([first, second]);
      assert.equal(closed, true);
      assert.equal(
        authored,
        0,
        "factory completion cannot reopen revoked authored execution",
      );
      assert.equal(
        factories,
        1,
        "queued local work never reuses the uncertain slot",
      );
      assert.equal(
        f.host.snapshot().active,
        1,
        "drain alone is not a durable terminal witness",
      );
      const deliveries = (await f.db.query(
        "SELECT status,attempts FROM event_deliveries ORDER BY attempts DESC",
      )).rows;
      assert.deepEqual(deliveries.map((row) => [row.status, row.attempts]), [[
        "leased",
        1,
      ], ["pending", 0]]);
      assert.equal(
        (await f.db.query("SELECT retired FROM owner_assignments")).rows[0]
          .retired,
        false,
      );
      assert.equal(
        (await f.db.query(
          "SELECT kind FROM owner_receipts WHERE kind='execution.complete'",
        )).rows.length,
        0,
      );
    } finally {
      release.resolve();
      await f.close();
    }
  },
);

test("ordinary worker resume still refuses retained completed local history", {
  skip: !sourceRoot,
  timeout: 30_000,
}, async () => {
  const f = await fixture({});
  try {
    assert.equal(
      await f.facade.actions.work("retained", { operationKey: "retained" }),
      "retained",
    );
    await eventually(() => f.host.snapshot().active === 0);
    assert.equal(
      (await f.db.query("SELECT retired FROM owner_assignments")).rows[0]
        .retired,
      true,
    );
    await f.shutdown();
    let transports = 0;
    await assert.rejects(
      createOwnerHost({
        ...f.options,
        session: f.db,
        holderId: "successor",
        initialization: { mode: "resume", expectedEpoch: 1 },
        createTransport() {
          transports++;
          throw new Error("resume must refuse before constructing transport");
        },
      }, ["space"]),
      /startup blockers/,
    );
    assert.equal(transports, 0);
    const local = (await f.db.query<
      { binding: OwnerLocalActionAssignmentBinding; retired: boolean }
    >("SELECT binding,retired FROM owner_assignments")).rows;
    assert.equal(local.length, 1);
    assert.equal(local[0].retired, true);
    assert.equal(local[0].binding.placement, "owner-local");
    assert.equal(
      (await f.db.query(
        "SELECT attempts FROM event_deliveries WHERE consumer_id='registered:fixture.local'",
      )).rows[0].attempts,
      1,
    );
  } finally {
    await f.close();
  }
});

for (const stage of ["start", "terminal"] as const) {
  for (const durability of ["committed", "aborted"] as const) {
    test(
      `local host unknown ${durability} ${stage} reply stops without fallback, retry or false release`,
      { skip: !sourceRoot, timeout: 30_000 },
      async () => {
        const kind = stage === "start"
          ? "owner.local-start"
          : "execution.complete";
        let injected = 0, factories = 0, authored = 0;
        const f = await fixture({
          maxActive: 1,
          registry: ordinaryRegistry(async (value, ctx) => {
            authored++;
            await ctx.transaction(
              ({ collections }) =>
                collections.notes.create({
                  id: "before-terminal",
                  title: value,
                }),
              { operationKey: "write" },
            );
            return value;
          }),
          local: localOptions({
            createCapabilities() {
              factories++;
              return { resources: {}, adapters: {} };
            },
          }),
          session(db) {
            return {
              query: db.query.bind(db),
              async transaction(run) {
                let selected = false;
                const unknown = () =>
                  Object.assign(
                    new Error(`unknown ${durability} ${stage} reply`),
                    { code: "persistence_indeterminate" },
                  );
                const result = await db.transaction(async (tx) => {
                  const result = await run({
                    async query<TRow extends Record<string, unknown>>(
                      sql: string,
                      values?: unknown[],
                    ) {
                      const result = await tx.query<TRow>(sql, values);
                      if (
                        injected === 0 &&
                        sql.startsWith(
                          'INSERT INTO "public"."owner_receipts"(',
                        ) &&
                        values?.[5] === kind
                      ) {
                        selected = true;
                        injected++;
                      }
                      return result;
                    },
                  });
                  if (selected && durability === "aborted") throw unknown();
                  return result;
                });
                if (selected && durability === "committed") throw unknown();
                return result;
              },
            };
          },
        });
        try {
          const result = outcome(
            f.facade.actions.work("uncertain", { operationKey: "uncertain" }),
          );
          await eventually(() => injected === 1 && !f.host.snapshot().ready);
          await f.host.stopped;
          await f.host.close();
          await result;
          assert.equal(f.host.snapshot().recoveryRequired, true);
          assert.equal(
            f.host.snapshot().active,
            1,
            "raw drain cannot replace a known terminal hook",
          );
          assert.equal(factories, stage === "start" ? 0 : 1);
          assert.equal(authored, stage === "start" ? 0 : 1);
          assert.equal(f.counts().workerActionFactories, 0);
          assert.equal(
            (await f.db.query(
              "SELECT id FROM nodes WHERE id='before-terminal'",
            )).rows.length,
            stage === "start" ? 0 : 1,
          );
          const deliveries = (await f.db.query(
            "SELECT status,attempts,lease_expires_at FROM event_deliveries WHERE consumer_id='registered:fixture.local'",
          )).rows;
          assert.equal(deliveries.length, 1);
          const rolledBackStart = stage === "start" && durability === "aborted";
          const committedTerminal = stage === "terminal" &&
            durability === "committed";
          assert.equal(deliveries[0].attempts, rolledBackStart ? 0 : 1);
          assert.equal(
            deliveries[0].status,
            rolledBackStart
              ? "pending"
              : committedTerminal
              ? "succeeded"
              : "leased",
          );
          assert.equal(deliveries[0].lease_expires_at, null);
          const assignments =
            (await f.db.query("SELECT binding,retired FROM owner_assignments"))
              .rows;
          assert.equal(assignments.length, rolledBackStart ? 0 : 1);
          if (assignments.length) {
            assert.equal(
              (assignments[0].binding as { placement: string }).placement,
              "owner-local",
            );
            assert.equal(assignments[0].retired, committedTerminal);
          }
          assert.equal(
            (await f.db.query("SELECT kind FROM owner_receipts WHERE kind=$1", [
              kind,
            ])).rows.length,
            durability === "committed" ? 1 : 0,
          );
          await f.host.wake();
          assert.equal(injected, 1);
          assert.equal(factories, stage === "start" ? 0 : 1);
          assert.equal(f.host.snapshot().active, 1);
          assert.ok(
            f.errors.length > 0,
            "unknown persistence outcome is surfaced",
          );
        } finally {
          await f.close();
        }
      },
    );
  }
}

for (
  const corruption of [
    "reintroduced-worker-alarm",
    "reintroduced-local-alarm",
  ] as const
) {
  test(
    `local host ${corruption}: durable NULL alarm inconsistency stops before the active-entry skip`,
    { skip: !sourceRoot, timeout: 30_000 },
    async () => {
      const release = deferred(), entered = deferred();
      let authored = 0, processorCalls = 0;
      const registry = createPluginRegistry({
        actions: {
          work: defineAction({
            id: "fixture.local",
            inputSchema: { type: "string" } as const,
            outputSchema: { type: "string" } as const,
            async execute(value: string) {
              authored++;
              if (corruption === "reintroduced-local-alarm") {
                entered.resolve();
                await release.promise;
              }
              return value;
            },
          }),
        },
        processors: corruption === "reintroduced-worker-alarm"
          ? {
            watch: defineProcessor({
              id: "fixture.watch",
              on: [{ eventType: "fixture.local.invoked" }],
              async handle() {
                processorCalls++;
                entered.resolve();
                await release.promise;
              },
            }),
          }
          : {},
      });
      const f = await fixture({ registry, maxActive: 1 });
      try {
        const result = outcome(
          f.facade.actions.work("alarm", { operationKey: "alarm" }),
        );
        await entered.promise;
        assert.equal(f.host.snapshot().active, 1);
        const target =
          (await f.db.query<{ id: string; lease_expires_at: string | null }>(
            "SELECT id,lease_expires_at FROM event_deliveries WHERE consumer_id=$1 AND status='leased'",
            [
              corruption === "reintroduced-worker-alarm"
                ? "processor:fixture.watch"
                : "registered:fixture.local",
            ],
          )).rows[0];
        assert.ok(target);
        if (corruption === "reintroduced-worker-alarm") {
          assert.equal(
            target.lease_expires_at,
            null,
            "worker attempts have no job lease",
          );
          const binding = (await f.db.query<
            { binding: { placement: string; workerId: string } }
          >(
            "SELECT binding FROM owner_assignments WHERE delivery_id=$1 AND retired=FALSE",
            [target.id],
          )).rows[0].binding;
          assert.equal(binding.placement, "worker");
          assert.equal(binding.workerId, "execution");
        } else {
          assert.equal(target.lease_expires_at, null);
          assert.equal(
            (await f.db.query("SELECT name FROM owner_alarms WHERE name=$1", [
              JSON.stringify(["host.delivery", "space", target.id]),
            ])).rows.length,
            0,
          );
        }
        await f.db.transaction(async (tx) => {
          await tx.query(
            "INSERT INTO owner_alarms(owner,name,due_at) VALUES('owner',$1,'2000-01-01T00:00:00.000Z') ON CONFLICT(owner,name) DO UPDATE SET due_at=EXCLUDED.due_at",
            [JSON.stringify(["host.delivery", "space", target.id])],
          );
        });
        await outcome(f.host.wake());
        await eventually(() => !f.host.snapshot().ready);
        await f.host.stopped;
        assert.equal(f.host.snapshot().recoveryRequired, true);
        release.resolve();
        await f.host.close();
        await result;
        assert.equal(authored, 1);
        assert.equal(
          processorCalls,
          corruption === "reintroduced-worker-alarm" ? 1 : 0,
        );
        assert.equal(f.counts().workerActionFactories, 0);
        assert.equal(
          (await f.db.query(
            "SELECT attempts FROM event_deliveries WHERE id=$1",
            [target.id],
          )).rows[0].attempts,
          1,
        );
        assert.ok(
          f.errors.some((error) =>
            /NULL|inconsistent|authority|lease/i.test(String(error))
          ),
        );
        if (corruption === "reintroduced-local-alarm") {
          assert.equal(
            f.host.snapshot().active,
            1,
            "revoked local code draining does not release the lost attempt",
          );
        }
      } finally {
        release.resolve();
        await f.close();
      }
    },
  );
}

// Actual-table proof of the production helper's held caller-facing start reply.
// The SQL boundary remains real and its serialized pump is allowed to advance.
import { createCoreSchemaStatements as localHelperCoreStatements } from "../events/schema.ts";
import { createEventStore as localHelperEventStore } from "../events/store.ts";
import type { DeliveryExecutor as LocalHelperExecutor } from "../execution/types.ts";
import {
  createOwnerCommandBoundary as localHelperBoundary,
  type OwnerCaller as LocalHelperCaller,
  type OwnerCommandContext as LocalHelperContext,
} from "../owner/boundary.ts";
import { createOwnerExecutionCommands as localHelperExecution } from "../owner/execution.ts";
import { provisionOwnerAssignments as localHelperAssignments } from "../owner/assignments.ts";
import { provisionOwnerCommandSchema as localHelperOwnerSchema } from "../owner/schema.ts";
import {
  createOperationCatalog as localHelperCatalog,
  provisionOperationCatalog as localHelperCatalogSchema,
} from "../streams/catalog.ts";
import {
  captureOwnerHostLocalActions as captureLocalHelperOptions,
  createOwnerHostCommandContexts as createLocalHelperContexts,
  createOwnerHostLocalActions as createLocalHelper,
} from "./owner-host-local.ts";

async function localHelperFixture(
  extra: { revokeAfterTerminal?: boolean } = {},
) {
  const db = await createTestDatabase({ pgliteMemoryProfile: "low-memory" });
  for (const sql of localHelperCoreStatements("public")) await db.query(sql);
  await localHelperCatalogSchema(db, "public");
  await localHelperOwnerSchema(db, "public");
  await localHelperAssignments(db, "public");
  const token = crypto.randomUUID();
  const control: LocalHelperCaller = {
    principal: {
      kind: "owner-control",
      ownerId: "owner",
      epoch: 1,
      holderId: "holder",
    },
    ownerEpoch: 1,
    hostControl: token,
  };
  const committedStart = deferred(), releaseReply = deferred();
  const stats = {
    active: 0,
    released: 0,
    factories: 0,
    authored: 0,
    inputProjections: 0,
    scans: [] as string[],
  };
  let current = true;
  let clock = 0;
  let reference: OwnerLocalActionAssignmentBinding | undefined;
  let lastContext: LocalHelperContext | undefined;
  const registry = createPluginRegistry({
    actions: {
      work: defineAction({
        id: "helper.work",
        execute() {
          stats.authored++;
          return "done";
        },
      }),
    },
  });
  const catalog = localHelperCatalog(db, "public");
  const executor: LocalHelperExecutor = {
    ownership: "injected_dispatcher",
    workload: "unused",
    workloads: {},
    scheduleDelivery() {},
    dispatchWork: () => Promise.reject(new Error("no worker dispatch")),
    dispatchDelivery: () => Promise.reject(new Error("no worker dispatch")),
    dispatchRecoverable: () => Promise.reject(new Error("no recovery")),
    settleOutputs: () => Promise.resolve(),
    awaitScopeProgress: () => Promise.resolve(false),
    shutdown: () => Promise.resolve(),
  };
  const contexts = createLocalHelperContexts({
    ownerId: "owner",
    holderId: "holder",
    epoch: () => 1,
    isCurrent: () => current,
  });
  const assertControl = (who: LocalHelperCaller) => {
    assert.equal(current, true);
    assert.deepEqual(who.principal, control.principal);
    assert.equal(who.ownerEpoch, 1);
    assert.equal(who.hostControl, token);
  };
  const execution = localHelperExecution({
    ownerId: "owner",
    schema: "public",
    session: db,
    registry,
    catalog,
    executor,
    local: {
      authorizeStart: (...args) => helper.execution.authorizeStart(...args),
      reserveLocal: (...args) => helper.execution.reserveLocal(...args),
      retireLocal: (...args) => helper.execution.retireLocal(...args),
    },
    resolveAssignment: (...args) => helper.resolve(...args),
    authorizeInput(tx, assignment, value, time) {
      if (assignment.placement !== "owner-local") {
        throw new Error("worker forbidden");
      }
      return helper.input(tx, assignment, value, time);
    },
  });
  const boundary = localHelperBoundary({
    ownerId: "owner",
    holderId: "holder",
    schema: "public",
    session: db,
    now: () => new Date(Date.UTC(2020, 0, 1) + ++clock * 1000).toISOString(),
    handlers: {
      ...Object.fromEntries(
        Object.entries(execution.handlers).map((
          [kind, handler],
        ) => [
          kind,
          (input: Parameters<typeof handler>[0], context: LocalHelperContext) =>
            contexts.run(context, async () => {
              const result = await handler(input, context);
              if (kind === "owner.local-start") {
                assert.ok(reference);
              }
              return result;
            }),
        ]),
      ),
      async seed(_input, context) {
        const seeded = await localHelperEventStore({
          session: db,
          ownerCommit: context.ownerCommit,
          admitOperationEventSql: catalog.admitEventSql.bind(catalog),
          indexOperationEventSql: catalog.indexEventSql.bind(catalog),
          indexOperationEvent: catalog.indexEvent.bind(catalog),
        }).commitMutation({
          transaction: context.tx,
          draft: {
            type: "copilotz.owner.action.requested",
            namespace: "space",
            payload: {
              dataRef: {
                eventBodyId: "helper-body",
                schemaVersion: 1,
                mediaType: "application/json",
              },
            },
            metadata: {
              actionId: "helper.work",
              actionRunId: "helper-run",
              actionMetadata: {},
              rootKey: "helper-root",
            },
            deduplicationId: "helper-run",
            correlationId: "helper-correlation",
          },
          body: { id: "helper-body", json: null },
          consumers: [{
            consumerId: "registered:helper.work",
            settlement: "inherit",
          }],
        });
        return {
          eventId: seeded.event.id,
          deliveryId: seeded.deliveries[0].id,
        };
      },
      scan(_input, context) {
        return contexts.run(context, async () => {
          assert.ok(reference);
          lastContext = context;
          assert.equal(
            contexts.isCurrent({ ...context }),
            false,
            "a structural copy is not the live actual context",
          );

          const row = (await context.tx.query(
            "SELECT status FROM event_deliveries WHERE id=$1",
            [reference.deliveryId],
          )).rows[0];
          const status = String(row.status);
          stats.scans.push(status);
          return status;
        });
      },
    },
    projections: execution.projections,
    inputDefinitions: execution.inputDefinitions,
    authorize(tx, who, command, time, input) {
      return contexts.authorize(tx, who, command, time, async () => {
        if (command.kind === "seed" || command.kind === "scan") {
          assertControl(who);
        } else await execution.authorize(tx, who, command, time, input);
      });
    },
    authenticateReceipt() {
      throw new Error("receipt recovery forbidden");
    },
  });
  await boundary.acquire(0);
  const seeded = (await boundary.execute(control, {
    kind: "seed",
    domain: "logical",
    key: "helper-seed",
    intent: null,
  })).result as { eventId: string; deliveryId: string };
  const helper: ReturnType<typeof createLocalHelper> = createLocalHelper({
    configuration: captureLocalHelperOptions({
      actionIds: ["helper.work"],
      policy: {
        grants: () => ({ ctx: true, settlement: true }),
        input() {},
        collections: () => ({}),
      },
      createCapabilities() {
        stats.factories++;
        return { resources: {}, adapters: {} };
      },
    }, registry),
    registry,
    schema: "public",
    controlCaller: control,
    maxActive: 1,
    assertControl,
    isCurrent: () => current,
    onIndeterminate(error) {
      current = false;
      helper.stop(error);
    },
    capacity: {
      reserve(binding) {
        assert.equal(stats.active, 0);
        reference = structuredClone(binding);
        stats.active++;
        return {
          release() {
            assert.equal(stats.active, 1);
            stats.active--;
            stats.released++;
          },
        };
      },
    },
    boundary: {
      async execute(who, command, options) {
        const result = await boundary.execute(who, command, options);
        if (command.kind === "owner.local-start") {
          committedStart.resolve();
          await releaseReply.promise;
        }
        return result;
      },
      async executeInput(who, command, options) {
        const result = await boundary.executeInput(who, command, options);
        if (extra.revokeAfterTerminal) {
          current = false;
          helper.stop(new Error("revoked after real terminal COMMIT"));
        }
        return result;
      },
      project(who, kind, value, options) {
        if (kind === "execution.input") stats.inputProjections++;
        return boundary.project(who, kind, value, options);
      },
    },
  });
  const running = outcome(
    helper.run({
      namespace: "space",
      actionId: "helper.work",
      executionId: "helper-run",
      sourceEventId: seeded.eventId,
      deliveryId: seeded.deliveryId,
    }),
  );
  return {
    db,
    stats,
    helper,
    contexts,
    committedStart,
    releaseReply,
    running,
    reference: () => {
      assert.ok(reference);
      return reference;
    },
    lastContext: () => {
      assert.ok(lastContext);
      return lastContext;
    },
    scan: () =>
      boundary.execute(control, {
        kind: "scan",
        domain: "occurrence",
        key: crypto.randomUUID(),
        intent: null,
      }),
    async close() {
      releaseReply.resolve();
      current = false;
      helper.stop(new Error("fixture closed"));
      boundary.stop();
      await running;
      await db.close();
    },
  };
}

test("local host actual helper classifies committed held start reply in an unrelated authenticated command without opening ctx", async () => {
  const f = await localHelperFixture();
  try {
    await f.committedStart.promise;
    assert.deepEqual(f.stats, {
      active: 1,
      released: 0,
      factories: 0,
      authored: 0,
      inputProjections: 0,
      scans: [],
    });
    assert.deepEqual(
      (await f.db.query(
        "SELECT status,attempts,lease_expires_at FROM event_deliveries",
      )).rows,
      [{ status: "leased", attempts: 1, lease_expires_at: null }],
    );
    assert.equal((await f.scan()).result, "leased");
    assert.equal(f.stats.factories, 0);
    assert.equal(f.stats.inputProjections, 0);
    assert.equal(f.stats.active, 1);
    assert.equal(
      f.contexts.isCurrent(f.lastContext()),
      false,
      "handler return closes context membership",
    );

    f.releaseReply.resolve();
    assert.equal((await f.running).error, undefined);
    assert.equal(f.stats.authored, 1);
    assert.equal(f.stats.factories, 1);
    assert.equal(f.stats.active, 0);
    assert.equal(f.stats.released, 1);
    assert.deepEqual(
      (await f.db.query("SELECT retired FROM owner_assignments")).rows,
      [{ retired: true }],
    );
  } finally {
    await f.close();
  }
});

test("local host actual input refuses corrupt held-start authority before factory admission", async () => {
  for (
    const corruption of [
      "token",
      "attempts",
      "retired",
      "epoch",
      "source-type",
      "source-action",
    ]
  ) {
    const f = await localHelperFixture();
    try {
      await f.committedStart.promise;
      const binding = f.reference();
      await f.db.transaction(async (tx) => {
        if (corruption.startsWith("source-")) {
          await tx.query(
            'ALTER TABLE events DISABLE TRIGGER "copilotz_events_immutable"',
          );
          await tx.query(
            corruption === "source-type"
              ? "UPDATE events SET type='foreign' WHERE id=$1"
              : "UPDATE events SET metadata=jsonb_set(metadata,'{actionId}','123'::jsonb) WHERE id=$1",
            [binding.sourceEventId],
          );
          await tx.query(
            'ALTER TABLE events ENABLE TRIGGER "copilotz_events_immutable"',
          );
        } else {
          const sql = corruption === "token"
            ? "UPDATE event_deliveries SET lease_owner='foreign' WHERE id=$1"
            : corruption === "attempts"
            ? "UPDATE event_deliveries SET attempts=2 WHERE id=$1"
            : corruption === "retired"
            ? "UPDATE owner_assignments SET retired=TRUE WHERE delivery_id=$1"
            : "UPDATE owner_assignments SET epoch=2 WHERE delivery_id=$1";
          await tx.query(sql, [binding.deliveryId]);
        }
      });
      f.releaseReply.resolve();
      assert.ok((await f.running).error, corruption);
      assert.equal(f.stats.factories, 0, corruption);
      assert.equal(f.stats.authored, 0, corruption);
      assert.equal(f.stats.active, 1, corruption);
      assert.equal(f.stats.released, 0, corruption);
    } finally {
      await f.close();
    }
  }
});

test("local host actual helper retains known terminal after revocation and releases only once actual raw work drains", async () => {
  const f = await localHelperFixture({ revokeAfterTerminal: true });
  try {
    await f.committedStart.promise;
    f.releaseReply.resolve();
    assert.ok(
      (await f.running).error,
      "revocation prevents reporting normal driver success",
    );
    assert.equal(f.stats.authored, 1);
    assert.equal(f.stats.active, 0);
    assert.equal(f.stats.released, 1);
    assert.deepEqual(
      (await f.db.query("SELECT status,attempts FROM event_deliveries")).rows,
      [{ status: "succeeded", attempts: 1 }],
    );
    assert.deepEqual(
      (await f.db.query("SELECT retired FROM owner_assignments")).rows,
      [{ retired: true }],
    );
  } finally {
    await f.close();
  }
});

test(
  "local host shutdown rejection still waits actual held factory and preserves its error",
  {
    skip: !sourceRoot,
    timeout: 30_000,
  },
  async () => {
    const entered = deferred(), release = deferred(), rejected = deferred();
    const shutdownError = new Error("deliberate transport shutdown rejection");
    let authored = 0, closed = false;
    let signal: AbortSignal | undefined;
    const f = await fixture({
      maxActive: 1,
      shutdownFailure: { error: shutdownError, observed: rejected.resolve },
      registry: ordinaryRegistry((value) => {
        authored++;
        return Promise.resolve(value);
      }),
      local: localOptions({
        async createCapabilities(input) {
          signal = input.signal;
          entered.resolve();
          await release.promise;
          return { resources: {}, adapters: {} };
        },
      }),
    });
    try {
      const action = outcome(
        f.facade.actions.work("held-shutdown", {
          operationKey: "held-shutdown",
        }),
      );
      await entered.promise;
      const rawClosing = f.host.close();
      assert.equal(
        f.host.close("duplicate rejecting close"),
        rawClosing,
        "all callers share the pending drain even when shutdown rejects",
      );
      const closing = outcome(rawClosing).then((result) => {
        closed = true;
        return result;
      });
      assert.equal(signal?.aborted, true);
      assert.equal(f.host.snapshot().ready, false);
      await rejected.promise;
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.equal(
        closed,
        false,
        "transport rejection cannot bypass the actual raw/factory drain",
      );
      assert.equal(f.host.snapshot().active, 1);
      assert.equal(authored, 0);
      release.resolve();
      assert.equal((await closing).error, shutdownError);
      assert.equal(f.host.close("close after rejection"), rawClosing);
      assert.equal((await outcome(f.host.close())).error, shutdownError);
      await action;
      assert.equal(closed, true);
      assert.equal(authored, 0);
      assert.equal(
        f.host.snapshot().active,
        1,
        "a drained lost attempt has no terminal release proof",
      );
      assert.deepEqual(
        (await f.db.query("SELECT status,attempts FROM event_deliveries")).rows,
        [{ status: "leased", attempts: 1 }],
      );
    } finally {
      release.resolve();
      await f.close();
    }
  },
);

for (const mode of ["in-process", "websocket"] as const) {
  for (
    const [parentPlacement, childPlacement] of [["owner-local", "worker"], [
      "owner-local",
      "owner-local",
    ], ["worker", "owner-local"]] as const
  ) {
    test(
      `${
        parentPlacement === "owner-local" ? "local" : "worker"
      } Action parent calls ${childPlacement} child over ${mode} with one logical result`,
      { skip: !sourceRoot, timeout: 30_000 },
      async () => {
        let childCalls = 0, policyCalls = 0, localFactories = 0;
        const release = deferred();
        const registry = createPluginRegistry({
          collections: { notes },
          actions: {
            work: defineAction({
              id: "fixture.local",
              inputSchema: { type: "string" } as const,
              async execute(value: string, ctx: ActionContext) {
                const one = await ctx.actions.child(value, {
                  operationKey: "child",
                });
                const two = await ctx.actions.child(value, {
                  operationKey: "child",
                });
                return `root:${one}:${two}`;
              },
            }),
            child: defineAction({
              id: "fixture.child",
              inputSchema: { type: "string" } as const,
              async execute(value: string, ctx: ActionContext) {
                childCalls++;
                await release.promise;
                await ctx.transaction(
                  ({ collections }) =>
                    collections.notes.create({
                      id: "nested-note",
                      title: value,
                    }),
                  { operationKey: "write" },
                );
                return `child:${value}`;
              },
            }),
          },
        });
        const f = await fixture({
          registry,
          mode,
          local: localOptions({
            actionIds: [
              ...(parentPlacement === "owner-local" ? ["fixture.local"] : []),
              ...(childPlacement === "owner-local" ? ["fixture.child"] : []),
            ],
            createCapabilities() {
              localFactories++;
              return { resources: {}, adapters: {} };
            },
          }),
          policy: {
            child(_tx, parent, actionId) {
              policyCalls++;
              assert.equal(actionId, "fixture.child");
              assert.equal(parent.originalMetadata.source, "trusted-ingress");
            },
          },
        });
        try {
          let ended = false;
          const pending = outcome(
            f.facade.actions.work("hello", { operationKey: "nested" }),
          ).then((result) => {
            ended = true;
            return result;
          });
          await eventually(() => childCalls > 0 || ended);
          assert.equal(
            childCalls,
            1,
            JSON.stringify({ snapshot: f.host.snapshot(), errors: f.errors }),
          );
          assert.equal(
            f.host.snapshot().active,
            2,
            "waiting parent remains charged alongside its child",
          );
          const rows = (await f.db.query<
            { consumer_id: string; lease_expires_at: unknown }
          >("SELECT consumer_id,lease_expires_at FROM event_deliveries WHERE status='leased'"))
            .rows;
          assert.equal(rows.length, 2);
          assert.equal(
            rows.find((r) => r.consumer_id === "registered:fixture.local")
              ?.lease_expires_at === null,
            true,
          );
          assert.equal(
            rows.find((r) => r.consumer_id === "registered:fixture.child")
              ?.lease_expires_at === null,
            true,
          );
          release.resolve();
          const result = await pending;
          assert.equal(result.error, undefined);
          assert.equal(result.value, "root:child:hello:child:hello");
          await eventually(() => f.host.snapshot().active === 0);
          assert.equal(childCalls, 1);
          assert.ok(policyCalls >= 2);
          assert.equal(
            localFactories,
            Number(parentPlacement === "owner-local") +
              Number(childPlacement === "owner-local"),
          );
          assert.equal(
            f.counts().workerActionFactories,
            Number(parentPlacement === "worker") +
              Number(childPlacement === "worker"),
          );
          assert.equal(
            (await f.db.query("SELECT * FROM nodes WHERE id='nested-note'"))
              .rows.length,
            1,
          );
          assert.equal(
            (await f.db.query(
              "SELECT * FROM owner_receipts WHERE kind='action.child-admit'",
            )).rows.length,
            1,
          );
          assert.equal(f.host.snapshot().recoveryRequired, false);
          assert.deepEqual(f.errors, []);
        } finally {
          release.resolve();
          await f.close();
        }
      },
    );
  }
}

test(
  "local child admission at one slot refuses boundedly and retains its parent through terminal commit",
  { skip: !sourceRoot, timeout: 30_000 },
  async () => {
    const entered = deferred(), release = deferred();
    let childCalls = 0, activeAtRefusal = 0, failureCode: unknown, held = false;
    const registry = createPluginRegistry({
      actions: {
        work: defineAction({
          id: "fixture.local",
          async execute(_input: unknown, ctx: ActionContext) {
            try {
              return await ctx.actions.child(null, { operationKey: "child" });
            } catch (error) {
              activeAtRefusal = f.host.snapshot().active;
              failureCode = (error as { code?: unknown }).code;
              throw error;
            }
          },
        }),
        child: defineAction({
          id: "fixture.child",
          execute() {
            childCalls++;
            return "unexpected";
          },
        }),
      },
    });
    const f = await fixture({
      registry,
      maxActive: 1,
      policy: { child() {} },
      local: localOptions({
        actionIds: ["fixture.local", "fixture.child"],
        childWaitMs: 1000,
      }),
      session(db) {
        return {
          query: db.query.bind(db),
          transaction(run) {
            return db.transaction(async (tx) => {
              let selected = false;
              const result = await run({
                async query<TRow extends Record<string, unknown>>(
                  sql: string,
                  values?: unknown[],
                ) {
                  const result = await tx.query<TRow>(sql, values);
                  if (
                    !held &&
                    sql.startsWith('INSERT INTO "public"."owner_receipts"(') &&
                    values?.[5] === "execution.complete"
                  ) {
                    selected = true;
                    held = true;
                  }
                  return result;
                },
              });
              if (selected) {
                entered.resolve();
                await release.promise;
              }
              return result;
            });
          },
        };
      },
    });
    try {
      const started = Date.now();
      let settled = false;
      const pending = outcome(
        f.facade.actions.work("input", { operationKey: "one-slot" }),
      ).then((result) => {
        settled = true;
        return result;
      });
      await entered.promise;
      assert.equal(failureCode, "owner_host_unavailable");
      assert.equal(activeAtRefusal, 1);
      assert.equal(f.host.snapshot().active, 1);
      assert.equal(childCalls, 0);
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(
        settled,
        false,
        "parent outcome cannot precede its terminal COMMIT",
      );
      assert.equal(f.host.snapshot().active, 1);
      release.resolve();
      assert.ok((await pending).error);
      assert.ok(
        Date.now() - started < 5000,
        "capacity refusal must not starve forever",
      );
      await eventually(() => f.host.snapshot().active === 0);
      assert.equal(childCalls, 0);
      assert.equal(f.counts().workerActionFactories, 0);
      assert.equal(
        (await f.db.query(
          "SELECT * FROM owner_receipts WHERE kind='action.child-admit'",
        )).rows.length,
        0,
      );
      const rows = (await f.db.query(
        "SELECT consumer_id,status,attempts FROM event_deliveries",
      )).rows;
      assert.deepEqual(rows.map((r) => [r.consumer_id, r.status, r.attempts]), [
        ["registered:fixture.local", "dead_letter", 1],
      ]);
      await eventually(async () =>
        (await f.db.query("SELECT state FROM copilotz_operations")).rows[0]
          .state === "failed"
      );
      assert.equal(f.host.snapshot().ready, true);
      assert.equal(f.host.snapshot().recoveryRequired, false);
    } finally {
      release.resolve();
      await f.close();
    }
  },
);

test(
  "local parent grant revocation prevents a completed worker child output from escaping",
  { skip: !sourceRoot, timeout: 30_000 },
  async () => {
    let ctxGranted = true, exposed = false, childCalls = 0;
    const registry = createPluginRegistry({
      actions: {
        work: defineAction({
          id: "fixture.local",
          async execute(_input: unknown, ctx: ActionContext) {
            const result = await ctx.actions.child(null, {
              operationKey: "child",
            });
            exposed = true;
            return result;
          },
        }),
        child: defineAction({
          id: "fixture.child",
          execute() {
            childCalls++;
            ctxGranted = false;
            return { private: "must not escape" };
          },
        }),
      },
    });
    const f = await fixture({
      registry,
      policy: { child() {} },
      local: localOptions({
        policy: {
          grants: () => ({ ctx: ctxGranted, settlement: true }),
          input() {},
          collections: () => ({}),
        },
      }),
    });
    try {
      await assert.rejects(
        f.facade.actions.work("input", { operationKey: "revoked-child" }),
      );
      await eventually(() => f.host.snapshot().active === 0);
      assert.equal(childCalls, 1);
      assert.equal(exposed, false);
      assert.equal(
        (await f.db.query(
          "SELECT status FROM event_deliveries WHERE consumer_id='registered:fixture.child'",
        )).rows[0].status,
        "succeeded",
      );
      assert.equal(
        (await f.db.query(
          "SELECT status FROM event_deliveries WHERE consumer_id='registered:fixture.local'",
        )).rows[0].status,
        "dead_letter",
      );
      assert.equal(f.host.snapshot().ready, true);
    } finally {
      await f.close();
    }
  },
);

for (
  const stage of ["unknown-committed", "unknown-aborted", "held-reply"] as const
) {
  test(
    `local child ${stage} admission retains the parent until actual drain without replay`,
    { skip: !sourceRoot, timeout: 30_000 },
    async () => {
      const entered = deferred(), release = deferred();
      let injected = 0, childCalls = 0, closed = false;
      const registry = createPluginRegistry({
        actions: {
          work: defineAction({
            id: "fixture.local",
            execute: async (_input: unknown, ctx: ActionContext) =>
              await ctx.actions.child(null, { operationKey: "child" }),
          }),
          child: defineAction({
            id: "fixture.child",
            execute() {
              childCalls++;
              return "unexpected";
            },
          }),
        },
      });
      const f = await fixture({
        registry,
        maxActive: 2,
        policy: { child() {} },
        local: localOptions({ actionIds: ["fixture.local", "fixture.child"] }),
        session(db) {
          return {
            query: db.query.bind(db),
            async transaction(run) {
              let selected = false;
              const unknown = () =>
                Object.assign(new Error(`child ${stage}`), {
                  code: "persistence_indeterminate",
                });
              const result = await db.transaction(async (tx) => {
                const result = await run({
                  async query<TRow extends Record<string, unknown>>(
                    sql: string,
                    values?: unknown[],
                  ) {
                    const result = await tx.query<TRow>(sql, values);
                    if (
                      !injected &&
                      sql.startsWith(
                        'INSERT INTO "public"."owner_receipts"(',
                      ) && values?.[5] === "action.child-admit"
                    ) {
                      injected++;
                      selected = true;
                    }
                    return result;
                  },
                });
                if (selected && stage === "unknown-aborted") throw unknown();
                return result;
              });
              if (selected && stage === "unknown-committed") throw unknown();
              if (selected && stage === "held-reply") {
                entered.resolve();
                await release.promise;
              }
              return result;
            },
          };
        },
      });
      try {
        const pending = outcome(
          f.facade.actions.work("input", { operationKey: stage }),
        );
        if (stage === "held-reply") {
          await entered.promise;
          assert.equal(f.host.snapshot().active, 1);
          const closing = f.host.close().then(() => {
            closed = true;
          });
          await f.host.stopped;
          await new Promise((resolve) => setTimeout(resolve, 20));
          assert.equal(
            closed,
            false,
            "shutdown cannot outrun the held raw acknowledgement",
          );
          assert.equal(f.host.snapshot().active, 1);
          release.resolve();
          await closing;
        } else {
          await eventually(() => injected === 1 && !f.host.snapshot().ready);
          await f.host.stopped;
          await f.host.close();
        }
        await pending;
        assert.equal(injected, 1);
        assert.equal(childCalls, 0);
        assert.equal(
          f.host.snapshot().active,
          1,
          "drain is not a parent terminal witness",
        );
        assert.equal(
          f.host.snapshot().recoveryRequired,
          stage !== "held-reply",
        );
        assert.equal(f.counts().workerActionFactories, 0);
        const childRows = (await f.db.query(
          "SELECT status,attempts FROM event_deliveries WHERE consumer_id='registered:fixture.child'",
        )).rows;
        assert.equal(childRows.length, stage === "unknown-aborted" ? 0 : 1);
        if (childRows.length) {
          assert.deepEqual([childRows[0].status, childRows[0].attempts], [
            "pending",
            0,
          ]);
        }
        assert.equal(
          (await f.db.query(
            "SELECT * FROM owner_receipts WHERE kind='action.child-admit'",
          )).rows.length,
          stage === "unknown-aborted" ? 0 : 1,
        );
        assert.equal(
          (await f.db.query(
            "SELECT status FROM event_deliveries WHERE consumer_id='registered:fixture.local'",
          )).rows[0].status,
          "leased",
        );
        assert.equal(
          (await f.db.query("SELECT retired FROM owner_assignments")).rows[0]
            .retired,
          false,
        );
        await f.host.wake();
        assert.equal(injected, 1);
        assert.equal(childCalls, 0);
      } finally {
        release.resolve();
        await f.close();
      }
    },
  );
}

for (const placement of ["owner-local", "worker"] as const) {
  test(
    `unrelated Collection command cannot erase anomalous ${placement} running-job alarm`,
    { skip: !sourceRoot, timeout: 30_000 },
    async () => {
      const entered = deferred(), release = deferred();
      let target: string | undefined, injected = false, heldCalls = 0;
      const heldId = placement === "owner-local"
        ? "fixture.local"
        : "fixture.remote";
      const registry = createPluginRegistry({
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
          hold: defineAction({
            id: heldId,
            async execute() {
              heldCalls++;
              entered.resolve();
              await release.promise;
              return "held";
            },
          }),
          probe: defineAction({
            id: "fixture.probe",
            async execute(_input: unknown, ctx: ActionContext) {
              await ctx.transaction(async ({ collections }) => {
                await collections.notes.create({
                  id: "probe-note",
                  title: "probe",
                });
              }, { operationKey: "probe-write" });
              return "probe";
            },
          }),
        },
      });
      const f = await fixture({
        registry,
        maxActive: 2,
        local: localOptions({
          actionIds: [placement === "owner-local" ? heldId : "fixture.probe"],
        }),
        session(db) {
          return {
            query: db.query,
            transaction: (run) =>
              db.transaction((tx) =>
                run({
                  async query<
                    TRow extends Record<string, unknown> = Record<
                      string,
                      unknown
                    >,
                  >(sql: string, params?: unknown[]) {
                    const result = await tx.query<TRow>(sql, params);
                    if (
                      target && !injected && sql.includes("INSERT") &&
                      sql.includes('"nodes"')
                    ) {
                      injected = true;
                      await tx.query(
                        "INSERT INTO owner_alarms(owner,name,due_at) VALUES('owner',$1,'2000-01-01T00:00:00Z')",
                        [JSON.stringify(["host.delivery", "space", target])],
                      );
                    }
                    return result;
                  },
                })
              ),
          };
        },
      });
      const facade = f.facade as ReturnType<typeof createOwnerActionCallers>;
      const holding = outcome(
        facade.actions.hold(null, { operationKey: "held" }),
      );
      try {
        await entered.promise;
        target = String(
          (await f.db.query(
            "SELECT d.id FROM event_deliveries d WHERE d.consumer_id=$1 AND status='leased'",
            [`registered:${heldId}`],
          )).rows[0].id,
        );
        await outcome(facade.actions.probe(null, { operationKey: "probe" }));
        assert.equal(injected, true);
        assert.equal(
          (await f.db.query("SELECT id FROM nodes WHERE id='probe-note'")).rows
            .length,
          1,
          "probe Collection command committed",
        );
        assert.equal(
          (await f.db.query("SELECT name FROM owner_alarms WHERE name=$1", [
            JSON.stringify(["host.delivery", "space", target]),
          ])).rows.length,
          1,
          "unrelated command did not hide running-job alarm",
        );
        await outcome(f.host.wake());
        await eventually(() => !f.host.snapshot().ready);
        assert.equal(f.host.snapshot().recoveryRequired, true);
        assert.equal(heldCalls, 1);
      } finally {
        release.resolve();
        await f.close();
        await holding;
      }
    },
  );
}

for (const mode of ["in-process", "websocket"] as const) {
  for (const scenario of ["confirmed", "not-started", "ctx-revoked"] as const) {
    test(`local host shared effects ${mode}: ${scenario}`, {
      skip: !sourceRoot,
      timeout: 30_000,
    }, async () => {
      let ctxGranted = true;
      let sends = 0;
      let outcomeChecks = 0;
      let evidenceChecks = 0;
      const f = await fixture({
        mode,
        registry: ordinaryRegistry(async (_value, ctx) => {
          assert.deepEqual(await ctx.effect.begin("send"), {
            status: "proceed",
          });
          if (scenario === "not-started") {
            await ctx.effect.notStarted("send", {
              source: "fixture",
              reference: "verified-no-start",
            });
            assert.deepEqual(await ctx.effect.inspect("send"), {
              status: "not_started",
            });
            assert.deepEqual(await ctx.effect.begin("send"), {
              status: "not_started",
            });
          } else {
            sends++;
            if (scenario === "ctx-revoked") {
              ctxGranted = false;
              await assert.rejects(ctx.effect.begin("forbidden"));
              await assert.rejects(
                ctx.transaction(({ collections }) =>
                  collections.notes.create({
                    id: "forbidden",
                    title: "denied",
                  }), { operationKey: "forbidden" }),
              );
            }
            await ctx.effect.confirm("send", { sent: true });
            assert.deepEqual(await ctx.effect.inspect("send"), {
              status: "replay",
              outcome: { sent: true },
            });
            if (scenario !== "ctx-revoked") {
              assert.deepEqual(await ctx.effect.begin("send"), {
                status: "replay",
                outcome: { sent: true },
              });
            }
          }
          return "done";
        }),
        local: localOptions({
          policy: {
            grants: () => ({ ctx: ctxGranted, settlement: true }),
            input() {},
            collections: () => ({}),
          },
        }),
        policy: {
          effectOutcome(_tx, assignment, ref, value) {
            outcomeChecks++;
            assert.equal(assignment.placement, "owner-local");
            assert.equal(Object.hasOwn(assignment, "workerId"), false);
            assert.equal(ref.actionRunId, assignment.invocation.actionRunId);
            assert.deepEqual(value, { sent: true });
            return true;
          },
          effectNotStarted(_tx, assignment, ref, proof) {
            evidenceChecks++;
            assert.equal(assignment.placement, "owner-local");
            assert.equal(ref.actionRunId, assignment.invocation.actionRunId);
            return proof.source === "fixture" &&
              proof.reference === "verified-no-start";
          },
        },
      });
      try {
        if (scenario === "ctx-revoked") {
          // A caught rejected ctx call still fails the invocation, but the
          // already-started effect must retain its narrow settlement route.
          await assert.rejects(
            f.facade.actions.work("effect", { operationKey: "effect" }),
          );
        } else {
          assert.equal(
            await f.facade.actions.work("effect", { operationKey: "effect" }),
            "done",
          );
        }
        await eventually(() => f.host.snapshot().active === 0);
        assert.equal(sends, scenario === "not-started" ? 0 : 1);
        assert.equal(outcomeChecks, scenario === "not-started" ? 0 : 1);
        assert.equal(evidenceChecks, scenario === "not-started" ? 1 : 0);
        assert.equal(f.counts().workerActionFactories, 0);
        assert.deepEqual(
          (await f.db.query(
            "SELECT kind FROM owner_receipts WHERE kind LIKE 'effect.%' ORDER BY kind",
          )).rows,
          [{ kind: "effect.begin" }, {
            kind: scenario === "not-started"
              ? "effect.notStarted"
              : "effect.confirm",
          }],
        );
        assert.equal(
          (await f.db.query("SELECT id FROM nodes WHERE id='forbidden'"))
            .rows.length,
          0,
        );
        assert.equal(f.host.snapshot().ready, true);
        assert.deepEqual(f.errors, []);
      } finally {
        await f.close();
      }
    });
  }
}

for (const mode of ["in-process", "websocket"] as const) {
  for (const stage of ["begin", "confirm", "notStarted"] as const) {
    for (const durability of ["committed", "aborted"] as const) {
      test(`local host effect unknown ${mode}: ${stage} ${durability}`, {
        skip: !sourceRoot,
        timeout: 30_000,
      }, async () => {
        let injected = 0, factories = 0, sends = 0;
        const kind = `effect.${stage}`;
        const f = await fixture({
          mode,
          registry: ordinaryRegistry(async (_value, ctx) => {
            assert.deepEqual(await ctx.effect.begin("send"), {
              status: "proceed",
            });
            if (stage === "notStarted") {
              await ctx.effect.notStarted("send", {
                source: "fixture",
                reference: "no-start",
              });
            } else {
              sends++;
              await ctx.effect.confirm("send", { sent: true });
            }
            return "done";
          }),
          local: localOptions({
            createCapabilities() {
              factories++;
              return { resources: {}, adapters: {} };
            },
          }),
          policy: { effectOutcome: () => true, effectNotStarted: () => true },
          session(db) {
            return {
              query: db.query.bind(db),
              async transaction(run) {
                let selected = false;
                const unknown = () =>
                  Object.assign(
                    new Error(`unknown effect ${stage} ${durability}`),
                    { code: "persistence_indeterminate" },
                  );
                const result = await db.transaction(async (tx) => {
                  const value = await run({
                    async query<TRow extends Record<string, unknown>>(
                      sql: string,
                      values?: unknown[],
                    ) {
                      const result = await tx.query<TRow>(sql, values);
                      if (
                        !injected &&
                        sql.startsWith(
                          'INSERT INTO "public"."owner_receipts"(',
                        ) && values?.[5] === kind
                      ) {
                        selected = true;
                        injected++;
                      }
                      return result;
                    },
                  });
                  if (selected && durability === "aborted") throw unknown();
                  return value;
                });
                if (selected && durability === "committed") throw unknown();
                return result;
              },
            };
          },
        });
        try {
          const result = outcome(
            f.facade.actions.work("uncertain", { operationKey: "uncertain" }),
          );
          await eventually(() => injected === 1 && !f.host.snapshot().ready);
          await f.host.stopped;
          await f.host.close();
          assert.ok((await result).error);
          assert.equal(factories, 1);
          assert.equal(sends, stage === "confirm" ? 1 : 0);
          assert.equal(f.counts().workerActionFactories, 0);
          assert.equal(f.host.snapshot().recoveryRequired, true);
          assert.equal(f.host.snapshot().active, 1);
          assert.deepEqual(
            (await f.db.query(
              "SELECT status,attempts,lease_expires_at FROM event_deliveries WHERE consumer_id='registered:fixture.local'",
            )).rows,
            [{ status: "leased", attempts: 1, lease_expires_at: null }],
          );
          assert.equal(
            (await f.db.query("SELECT kind FROM owner_receipts WHERE kind=$1", [
              kind,
            ])).rows.length,
            durability === "committed" ? 1 : 0,
          );
          assert.equal(
            (await f.db.query(
              "SELECT kind FROM owner_receipts WHERE kind='execution.complete'",
            )).rows.length,
            0,
          );
          await f.host.wake();
          assert.equal(factories, 1);
          assert.equal(injected, 1);
          assert.equal(sends, stage === "confirm" ? 1 : 0);
        } finally {
          await f.close();
        }
      });
    }
  }
}

for (const mode of ["in-process", "websocket"] as const) {
  for (const policy of ["outcome", "no-start"] as const) {
    test(`local host rejected effect policy ${mode}: ${policy}`, {
      skip: !sourceRoot,
      timeout: 30_000,
    }, async () => {
      let sends = 0;
      const f = await fixture({
        mode,
        registry: ordinaryRegistry(async (_value, ctx) => {
          assert.deepEqual(await ctx.effect.begin("send"), {
            status: "proceed",
          });
          if (policy === "outcome") {
            sends++;
            await assert.rejects(ctx.effect.confirm("send", { sent: true }));
          } else {await assert.rejects(
              ctx.effect.notStarted("send", {
                source: "unverified",
                reference: "no-start",
              }),
            );}
          assert.deepEqual(await ctx.effect.inspect("send"), {
            status: "indeterminate",
          });
          return "caught policy refusal is not success";
        }),
      });
      try {
        await assert.rejects(
          f.facade.actions.work("policy", { operationKey: "policy" }),
        );
        await eventually(() => f.host.snapshot().active === 0);
        assert.equal(sends, policy === "outcome" ? 1 : 0);
        assert.deepEqual(
          (await f.db.query(
            "SELECT kind,result->>'status' AS status FROM owner_receipts WHERE kind LIKE 'effect.%'",
          )).rows,
          [{ kind: "effect.begin", status: "begun" }],
        );
        assert.equal(f.host.snapshot().ready, true);
        assert.equal(f.host.snapshot().recoveryRequired, false);
      } finally {
        await f.close();
      }
    });
  }
}

for (const mode of ["in-process", "websocket"] as const) {
  for (const revoke of [false, true]) {
    test(
      `local host held committed effect begin ${mode}: ${
        revoke ? "revoked" : "released"
      }`,
      { skip: !sourceRoot, timeout: 30_000 },
      async () => {
        const reached = deferred(), release = deferred();
        let held = false, sends = 0;
        const f = await fixture({
          mode,
          registry: ordinaryRegistry(async (_value, ctx) => {
            assert.deepEqual(await ctx.effect.begin("send"), {
              status: "proceed",
            });
            sends++;
            await ctx.effect.confirm("send", { sent: true });
            return "done";
          }),
          policy: { effectOutcome: () => true },
          session(db) {
            return {
              query: db.query.bind(db),
              async transaction(run) {
                let selected = false;
                const value = await db.transaction(async (tx) =>
                  await run({
                    async query<TRow extends Record<string, unknown>>(
                      sql: string,
                      values?: unknown[],
                    ) {
                      const result = await tx.query<TRow>(sql, values);
                      if (
                        !held &&
                        sql.startsWith(
                          'INSERT INTO "public"."owner_receipts"(',
                        ) && values?.[5] === "effect.begin"
                      ) selected = true;
                      return result;
                    },
                  })
                );
                // DB COMMIT is complete, but this transaction reply hold blocks the
                // owner command pump. The test observes raw SQL, not a concurrent
                // owner command or caller-facing reply scan.
                if (selected && !held) {
                  held = true;
                  reached.resolve();
                  await release.promise;
                }
                return value;
              },
            };
          },
        });
        try {
          const pending = outcome(
            f.facade.actions.work("held", { operationKey: "held" }),
          );
          await reached.promise;
          assert.equal(sends, 0);
          assert.equal(
            (await f.db.query(
              "SELECT kind FROM owner_receipts WHERE kind='effect.begin'",
            )).rows.length,
            1,
          );
          assert.equal(f.host.snapshot().active, 1);
          if (revoke) {
            let closed = false;
            const closing = f.host.close().then(() => {
              closed = true;
            });
            await eventually(() => !f.host.snapshot().ready);
            assert.equal(
              closed,
              false,
              "close must wait for the raw committed reply",
            );
            assert.equal(sends, 0);
            release.resolve();
            await closing;
            assert.ok((await pending).error);
            assert.equal(sends, 0);
            assert.equal(f.host.snapshot().active, 1);
            assert.equal(
              (await f.db.query(
                "SELECT kind FROM owner_receipts WHERE kind='effect.confirm' OR kind='execution.complete'",
              )).rows.length,
              0,
            );
          } else {
            release.resolve();
            assert.equal((await pending).value, "done");
            await eventually(() => f.host.snapshot().active === 0);
            assert.equal(sends, 1);
          }
        } finally {
          release.resolve();
          await f.close();
        }
      },
    );
  }
}

for (const mode of ["in-process", "websocket"] as const) {
  test(`local host repeated unresolved begin stays indeterminate ${mode}`, {
    skip: !sourceRoot,
    timeout: 30_000,
  }, async () => {
    let sends = 0;
    const f = await fixture({
      mode,
      registry: ordinaryRegistry(async (_value, ctx) => {
        assert.deepEqual(await ctx.effect.begin("send"), { status: "proceed" });
        sends++;
        await assert.rejects(ctx.effect.begin("send"));
        return "caught indeterminate cannot certify success";
      }),
    });
    try {
      const pending = outcome(
        f.facade.actions.work("unresolved", { operationKey: "unresolved" }),
      );
      await eventually(() => f.host.snapshot().recoveryRequired);
      await f.host.close();
      assert.ok((await pending).error);
      assert.equal(sends, 1);
      assert.equal(f.host.snapshot().active, 1);
      assert.deepEqual(
        (await f.db.query(
          "SELECT kind FROM owner_receipts WHERE kind LIKE 'effect.%'",
        )).rows,
        [{ kind: "effect.begin" }],
      );
      assert.equal(
        (await f.db.query(
          "SELECT kind FROM owner_receipts WHERE kind='execution.complete'",
        )).rows.length,
        0,
      );
    } finally {
      await f.close();
    }
  });
}

for (const mode of ["in-process", "websocket"] as const) {
  for (const stage of ["outcome", "no-start"] as const) {
    test(
      `local host effect policy cannot retain revoked settlement ${mode}: ${stage}`,
      { skip: !sourceRoot, timeout: 30_000 },
      async () => {
        let settlementGranted = true, sends = 0;
        const f = await fixture({
          mode,
          registry: ordinaryRegistry(async (_value, ctx) => {
            assert.deepEqual(await ctx.effect.begin("send"), {
              status: "proceed",
            });
            if (stage === "outcome") {
              sends++;
              await ctx.effect.confirm("send", { sent: true });
            } else {await ctx.effect.notStarted("send", {
                source: "fixture",
                reference: "no-start",
              });}
            return "stale settlement must not succeed";
          }),
          local: localOptions({
            policy: {
              grants: () => ({ ctx: true, settlement: settlementGranted }),
              input() {},
              collections: () => ({}),
            },
          }),
          policy: {
            effectOutcome() {
              settlementGranted = false;
              return true;
            },
            effectNotStarted() {
              settlementGranted = false;
              return true;
            },
          },
        });
        try {
          const pending = outcome(
            f.facade.actions.work("revoked", { operationKey: "revoked" }),
          );
          await eventually(() => f.host.snapshot().recoveryRequired);
          await f.host.close();
          assert.ok((await pending).error);
          assert.equal(settlementGranted, false);
          assert.equal(sends, stage === "outcome" ? 1 : 0);
          assert.equal(f.host.snapshot().active, 1);
          assert.deepEqual(
            (await f.db.query(
              "SELECT kind,result->>'status' AS status FROM owner_receipts WHERE kind LIKE 'effect.%'",
            )).rows,
            [{ kind: "effect.begin", status: "begun" }],
          );
          assert.equal(
            (await f.db.query(
              "SELECT kind FROM owner_receipts WHERE kind='execution.complete'",
            )).rows.length,
            0,
          );
        } finally {
          await f.close();
        }
      },
    );
  }
}

for (const mode of ["in-process", "websocket"] as const) {
  for (const recovered of ["confirmed", "not_started"] as const) {
    test(`same-attempt local effect reconciliation ${mode}: ${recovered}`, {
      skip: !sourceRoot,
      timeout: 30_000,
    }, async () => {
      let sends = 0, reconciliations = 0;
      const replay = recovered === "confirmed"
        ? { status: "replay", outcome: { sent: true } }
        : { status: "not_started" };
      const registry = createPluginRegistry({
        actions: {
          work: defineAction({
            id: "fixture.local",
            inputSchema: { type: "string" } as const,
            async execute(_value: string, ctx: ActionContext) {
              assert.deepEqual(await ctx.effect.begin("send"), {
                status: "proceed",
              });
              if (recovered === "confirmed") sends++;
              assert.deepEqual(await ctx.effect.begin("send"), replay);
              assert.deepEqual(await ctx.effect.begin("send"), replay);
              return "done";
            },
            async reconcile(step, ctx) {
              reconciliations++;
              assert.equal(step, "send");
              assert.deepEqual(await ctx.effect.inspect(step), {
                status: "indeterminate",
              });
              return recovered === "confirmed"
                ? { status: "confirmed" as const, outcome: { sent: true } }
                : {
                  status: "not_started" as const,
                  evidence: {
                    source: "fixture",
                    reference: "verified-no-start",
                  },
                };
            },
          }),
        },
      });
      const f = await fixture({
        mode,
        registry,
        policy: {
          effectOutcome(_tx, assignment, _ref, value) {
            assert.equal(assignment.placement, "owner-local");
            return JSON.stringify(value) === JSON.stringify({ sent: true });
          },
          effectNotStarted(_tx, assignment, _ref, proof) {
            assert.equal(assignment.placement, "owner-local");
            return proof.source === "fixture" &&
              proof.reference === "verified-no-start";
          },
        },
      });
      try {
        assert.equal(
          await f.facade.actions.work("reconcile", {
            operationKey: "reconcile",
          }),
          "done",
        );
        await eventually(() => f.host.snapshot().active === 0);
        assert.equal(sends, recovered === "confirmed" ? 1 : 0);
        assert.equal(reconciliations, 1);
        assert.equal(f.counts().workerActionFactories, 0);
        assert.deepEqual(
          (await f.db.query(
            "SELECT kind FROM owner_receipts WHERE kind LIKE 'effect.%' ORDER BY kind",
          )).rows,
          [{ kind: "effect.begin" }, {
            kind: recovered === "confirmed"
              ? "effect.confirm"
              : "effect.notStarted",
          }],
        );
        assert.equal(f.host.snapshot().ready, true);
        assert.deepEqual(f.errors, []);
      } finally {
        await f.close();
      }
    });
  }
}

for (const mode of ["in-process", "websocket"] as const) {
  for (const parentKind of ["action", "processor"] as const) {
    for (const retry of parentKind === "processor" ? [false, true] : [false]) {
      for (const childPlacement of ["owner-local", "worker"] as const) {
        for (
          const denial
            of parentKind === "action" && childPlacement === "owner-local"
              ? [
                "none",
                "claim",
                "input",
                "result",
                "duplicate",
                "parent-replay",
                "unknown-committed",
                "unknown-aborted",
                "held-reply",
              ]
              : ["none"]
        ) {
          test(
            `local ${mode} ${parentKind}/${
              retry ? "retry" : "fresh"
            } prepares View input for ${childPlacement} child once / ${denial}`,
            { skip: !sourceRoot, timeout: 40_000 },
            async () => {
              let parentAttempts = 0;
              let parentDelivery: string | undefined;
              let denied = false;
              let injected = 0;
              const held = deferred(), release = deferred();
              let armReplay = false, replayReads = 0;
              let rendered = 0,
                mapped = 0,
                childCalls = 0,
                version = "original";
              const outputs: string[] = [], checks: string[] = [];
              const prepare = async (ctx: ActionContext | ProcessorContext) => {
                const child = ctx.actions.child as RuntimeActionCallers[string];
                assert.equal(typeof child.prepareNamed, "function");
                const request = {
                  preparation: "notes.context",
                  recordId: "prepared-record",
                  mode: "context",
                };
                const first = await child.prepareNamed(request, {
                  operationKey: "prepared",
                });
                await ctx.transaction(({ collections }) => {
                  collections.notes.update({
                    id: "prepared-record",
                    set: { title: "changed" },
                  });
                }, { operationKey: "edit-source" });
                version = "changed";
                armReplay = denial === "parent-replay";
                const second = await child.prepareNamed(request, {
                  operationKey: "prepared",
                });
                outputs.push(String(first), String(second));
              };
              const registry = createPluginRegistry({
                collections: { notes },
                views: {
                  note: defineView({
                    id: "local.note.context",
                    shows: "local_note",
                    renderer: "text",
                    modes: ["context"],
                    render(value: { record: { title: string } }) {
                      rendered++;
                      return `${value.record.title}:${version}`;
                    },
                  }),
                },
                actions: {
                  work: defineAction({
                    id: "fixture.local",
                    inputSchema: { type: "string" } as const,
                    async execute(_value: string, ctx: ActionContext) {
                      await ctx.transaction(({ collections }) => {
                        collections.notes.create({
                          id: "prepared-record",
                          title: "first",
                        });
                      }, { operationKey: "source" });
                      if (parentKind === "action") await prepare(ctx);
                      return "done";
                    },
                  }),
                  child: defineAction({
                    id: "fixture.child",
                    inputSchema: { type: "string" } as const,
                    execute(value: string) {
                      childCalls++;
                      return `child:${value}`;
                    },
                  }),
                },
                ...(parentKind === "processor"
                  ? {
                    processors: {
                      follow: defineProcessor({
                        id: "fixture.prepare",
                        on: [{ eventType: "local_note.created" }],
                        async handle(_event, ctx) {
                          parentAttempts++;
                          await prepare(ctx);
                          if (retry && parentAttempts === 1) {
                            throw new Error(
                              "retry parent after confirmed child",
                            );
                          }
                        },
                      }),
                    },
                  }
                  : {}),
              });
              const preparation: NonNullable<OwnerHostOptions["preparation"]> =
                {
                  records: {
                    sources: { notes: { collectionAlias: "notes" } },
                    authorize(_tx, context) {
                      // Original-source checks reuse this scope callback for the
                      // child as well as its parent, including pre-assignment start.
                      const principal = context.caller.principal;
                      if (principal.kind === "owner-local") {
                        parentDelivery ??= principal.deliveryId;
                      }
                      if (principal.kind === "worker") {
                        assert.equal(principal.workerId, "execution");
                      } else {
                        assert.equal(principal.ownerId, "owner");
                        assert.equal(principal.epoch, 1);
                        assert.equal(principal.holderId, "holder");
                        if (principal.kind === "owner-control") {
                          assert.equal(
                            typeof context.caller.localPlacementStart,
                            "string",
                          );
                        }
                      }
                      assert.equal(context.request.recordId, "prepared-record");
                      return { namespace: "space", audience: "test-reader" };
                    },
                    projectRecord: (record) => ({ title: record.title }),
                    authorizeReference(_tx, context) {
                      // The host has already proven this actual caller's authority.
                      // Claim-time local children still carry the genuine controller.
                      checks.push(context.caller.principal.kind);
                      const principal = context.caller.principal;
                      if (
                        (denial === "claim" &&
                          principal.kind === "owner-control") ||
                        (denial === "input" && context.purpose === "input" &&
                          principal.kind === "owner-local" &&
                          principal.deliveryId !== parentDelivery) ||
                        (denial === "result" && context.purpose === "result") ||
                        (denial === "duplicate" &&
                          context.purpose === "duplicate")
                      ) {
                        denied = true;
                        throw new Error("original prepared source denied");
                      }
                      assert.equal(context.reference.source.namespace, "space");
                      assert.equal(context.reference.audience, "test-reader");
                      return true;
                    },
                  },
                  registrations: {
                    "notes.context": {
                      source: "notes",
                      actionAlias: "child",
                      shows: "local_note",
                      modes: ["context"],
                      mapInput(text) {
                        mapped++;
                        return text;
                      },
                    },
                  },
                  projectResource() {
                    throw new Error("No resources configured");
                  },
                  authorizeResource() {
                    throw new Error("No resources configured");
                  },
                };
              const f = await fixture({
                mode,
                registry,
                preparation,
                ...(denial === "parent-replay" || denial === "held-reply" ||
                    denial.startsWith("unknown-")
                  ? {
                    session(db: SqlSession): SqlSession {
                      return {
                        ...db,
                        async transaction(run) {
                          let selected = false;
                          const unknown = () =>
                            Object.assign(
                              new Error("unknown preparation COMMIT"),
                              { code: "persistence_indeterminate" },
                            );
                          const value = await db.transaction(async (tx) => {
                            const output = await run({
                              async query<
                                T extends Record<string, unknown> = Record<
                                  string,
                                  unknown
                                >,
                              >(sql: string, params?: unknown[]) {
                                const result = await tx.query<T>(sql, params);
                                if (
                                  armReplay &&
                                  sql.includes("SELECT kind,intent,result") &&
                                  ++replayReads === 2
                                ) {
                                  denied = true;
                                  assert.ok(closeHost);
                                  closeHost();
                                }
                                if (
                                  (denial.startsWith("unknown-") ||
                                    denial === "held-reply") &&
                                  !injected &&
                                  sql.startsWith(
                                    'INSERT INTO "public"."owner_receipts"(',
                                  ) && params?.[5] === "action.child-prepare"
                                ) {
                                  selected = true;
                                  denied = true;
                                  injected++;
                                }
                                return result;
                              },
                            });
                            if (
                              selected && denial === "unknown-aborted"
                            ) throw unknown();
                            return output;
                          });
                          if (
                            selected && denial === "unknown-committed"
                          ) throw unknown();
                          if (selected && denial === "held-reply") {
                            held.resolve();
                            await release.promise;
                          }
                          return value;
                        },
                      };
                    },
                  }
                  : {}),
                ...(denial !== "none" ? { callWaitMs: 5000 } : {}),
                policy: {
                  child(_tx, parent, actionId) {
                    assert.equal(parent.namespace, "space");
                    assert.equal(actionId, "fixture.child");
                  },
                },
                local: localOptions({
                  actionIds: childPlacement === "owner-local"
                    ? ["fixture.local", "fixture.child"]
                    : ["fixture.local"],
                }),
                ...(parentKind === "processor"
                  ? {
                    processors: {
                      processorIds: ["fixture.prepare"],
                      policy: {
                        grants: () => ({ ctx: true, settlement: true }),
                        event() {},
                        collections: () => ({}),
                      },
                      createCapabilities: () => ({
                        resources: {},
                        adapters: {},
                      }),
                    },
                  }
                  : {}),
              });
              let closing: Promise<void> | undefined;
              const closeHost = () => {
                closing ??= f.host.close();
              };
              try {
                if (denial === "held-reply") {
                  const pending = outcome(
                    f.facade.actions.work("start", { operationKey: "source" }),
                  );
                  await held.promise;
                  let closed = false;
                  const stopping = f.host.close().then(() => {
                    closed = true;
                  });
                  await f.host.stopped;
                  await new Promise((resolve) => setTimeout(resolve, 20));
                  assert.equal(closed, false);
                  assert.equal(f.host.snapshot().active, 1);
                  assert.equal(
                    (await f.db.query(
                      "SELECT kind FROM owner_receipts WHERE kind='action.child-prepare'",
                    )).rows.length,
                    1,
                  );
                  release.resolve();
                  await stopping;
                  assert.ok((await pending).error);
                  assert.equal(injected, 1);
                  assert.equal(childCalls, 0);
                  assert.deepEqual(outputs, []);
                  assert.equal(f.host.snapshot().active, 1);
                  assert.equal(f.host.snapshot().recoveryRequired, false);
                  return;
                }
                if (denial !== "none") {
                  await assert.rejects(
                    f.facade.actions.work("start", { operationKey: "source" }),
                  );
                  assert.equal(denied, true);
                  assert.deepEqual(outputs, []);
                  assert.equal(
                    childCalls,
                    denial === "claim" || denial === "input" ||
                      denial.startsWith("unknown-")
                      ? 0
                      : 1,
                  );
                  assert.equal(rendered, 1);
                  assert.equal(mapped, 1);
                  if (denial.startsWith("unknown-")) {
                    await f.host.stopped;
                    assert.equal(injected, 1);
                    assert.equal(f.host.snapshot().recoveryRequired, true);
                    assert.equal(f.host.snapshot().active, 1);
                    assert.equal(
                      (await f.db.query(
                        "SELECT kind FROM owner_receipts WHERE kind='action.child-prepare'",
                      )).rows.length,
                      denial === "unknown-committed" ? 1 : 0,
                    );
                    assert.equal(
                      (await f.db.query(
                        "SELECT id FROM events WHERE metadata ? 'preparation'",
                      )).rows.length,
                      denial === "unknown-committed" ? 1 : 0,
                    );
                  }
                  if (denial === "parent-replay") {
                    assert.equal(replayReads, 2);
                    await closing;
                  }
                  return;
                }
                assert.equal(
                  await f.facade.actions.work("start", {
                    operationKey: "source",
                  }),
                  "done",
                );
                await eventually(() =>
                  outputs.length === (retry ? 4 : 2) &&
                  f.host.snapshot().active === 0
                );
                assert.deepEqual(
                  outputs,
                  Array(retry ? 4 : 2).fill("child:first:original"),
                );
                if (parentKind === "processor") {
                  assert.equal(parentAttempts, retry ? 2 : 1);
                }
                assert.deepEqual([rendered, mapped, childCalls], [1, 1, 1]);
                assert.equal(
                  (await f.db.query(
                    "SELECT metadata FROM events WHERE type='copilotz.owner.action.requested' AND metadata ? 'preparation'",
                  )).rows.length,
                  1,
                );
                assert.equal(
                  (await f.db.query(
                    "SELECT data->>'title' AS title FROM nodes WHERE id='prepared-record'",
                  )).rows[0].title,
                  "changed",
                );
                assert.ok(checks.includes("owner-local"));
                assert.ok(
                  checks.includes(
                    childPlacement === "owner-local"
                      ? "owner-control"
                      : "worker",
                  ),
                );
                assert.deepEqual(f.errors, []);
              } finally {
                release.resolve();
                await f.close();
              }
            },
          );
        }
      }
    }
  }
}

for (const mode of ["in-process", "websocket"] as const) {
  for (const kind of ["action", "processor"] as const) {
    for (const placement of ["owner-local", "worker"] as const) {
      test(
        `ordinary Collection reads use real ${placement} ${kind} / ${mode}`,
        {
          skip: !sourceRoot,
        },
        async () => {
          let readCompleted = false;
          const bindings: string[] = [];
          const readTraces: Record<string, unknown>[] = [];
          const verify = async (ctx: ActionContext | ProcessorContext) => {
            const note = await ctx.collections.notes.get({ id: "a" });
            assert.equal(note?.count, 0);
            assert.equal(
              await ctx.collections.notes.get({ id: "0-hidden" }),
              null,
            );
            assert.deepEqual(
              (await ctx.collections.notes.list({ limit: 1 })).map((r) => r.id),
              ["a"],
            );
            assert.deepEqual(
              (await ctx.collections.notes.list({ after: "a", limit: 1 })).map((
                r,
              ) => r.id),
              ["b"],
            );
            assert.deepEqual(
              await ctx.collections.notes.aggregate({
                groupBy: ["title"],
                metrics: { total: { op: "count" } },
              }),
              [{ title: "visible", total: 2 }],
            );
            await ctx.transaction(({ collections }) => {
              collections.notes.update({ id: "a", set: { count: 1 } });
            }, { operationKey: "change-after-read" });
            assert.equal(
              (await ctx.collections.notes.get({ id: "a" }))?.count,
              1,
            );
            readCompleted = true;
          };
          const registry = createPluginRegistry({
            collections: { notes },
            actions: {
              idle: defineAction({ id: "fixture.idle", execute: () => null }),
              work: defineAction({
                id: "fixture.local",
                inputSchema: { type: "string" } as const,
                async execute(_value: string, ctx: ActionContext) {
                  await ctx.transaction(({ collections }) => {
                    for (const id of ["0-hidden", "a", "b", "trigger"]) {
                      collections.notes.create({
                        id,
                        title: ["a", "b"].includes(id) ? "visible" : "hidden",
                        count: 0,
                      });
                    }
                  }, { operationKey: "seed" });
                  if (kind === "action") await verify(ctx);
                  return "done";
                },
              }),
            },
            ...(kind === "processor"
              ? {
                processors: {
                  read: defineProcessor({
                    id: "fixture.read",
                    on: [{
                      eventType: "local_note.created",
                      data: { record: { id: "trigger" } },
                    }],
                    async handle(_event, ctx) {
                      await verify(ctx);
                    },
                  }),
                },
              }
              : {}),
          });
          const f = await fixture({
            registry,
            mode,
            local: localOptions({
              actionIds: kind === "action" && placement === "worker"
                ? ["fixture.idle"]
                : ["fixture.local"],
            }),
            ...(kind === "processor" && placement === "owner-local"
              ? {
                processors: {
                  processorIds: ["fixture.read"],
                  policy: {
                    grants: () => ({ ctx: true, settlement: true }),
                    event() {},
                    collections: () => ({}),
                  },
                  createCapabilities: () => ({ resources: {}, adapters: {} }),
                },
              }
              : {}),
            policy: {
              async collectionRead(tx, binding, request) {
                readTraces.push(
                  (await tx.query(
                    "SELECT (SELECT count(*) FROM events) AS events, (SELECT count(*) FROM owner_receipts) AS receipts",
                  )).rows[0],
                );
                assert.equal(binding.kind, kind);
                assert.equal(binding.assignment.namespace, "space");
                assert.equal(request.collectionAlias, "notes");
                bindings.push(
                  "placement" in binding.assignment
                    ? binding.assignment.placement
                    : "worker",
                );
                return { where: { title: "visible" } };
              },
            },
          });
          try {
            assert.equal(
              await f.facade.actions.work("read", {
                operationKey: `reads-${kind}-${placement}`,
              }),
              "done",
            );
            await eventually(() => readCompleted);
            assert.deepEqual([...new Set(bindings)], [placement]);
            assert.equal(readTraces.length, 12);
            for (let i = 0; i < readTraces.length; i += 2) {
              assert.deepEqual(readTraces[i], readTraces[i + 1]);
            }
            assert.equal(
              (await f.db.query(
                "SELECT key FROM owner_receipts WHERE kind='collections.read'",
              )).rows.length,
              0,
            );
            assert.deepEqual(f.errors, []);
          } finally {
            await f.close();
          }
        },
      );
    }
  }
}

for (const mode of ["in-process", "websocket"] as const) {
  for (const placement of ["owner-local", "worker"] as const) {
    for (
      const denial of [
        "missing-policy",
        "changed-scope",
        "last-policy-revocation",
        "foreign-cursor",
      ] as const
    ) {
      test(
        `ordinary Collection read refuses ${denial} / ${placement} / ${mode}`,
        { skip: !sourceRoot },
        async () => {
          let ctxGranted = true,
            policyCalls = 0,
            disclosed = false,
            caught = false;
          const registry = createPluginRegistry({
            collections: { notes },
            actions: {
              idle: defineAction({ id: "fixture.idle", execute: () => null }),
              work: defineAction({
                id: "fixture.local",
                inputSchema: { type: "string" } as const,
                async execute(_value: string, ctx: ActionContext) {
                  await ctx.transaction(({ collections }) => {
                    collections.notes.create({
                      id: "private",
                      title: "private",
                    });
                    collections.notes.create({
                      id: "visible",
                      title: "visible",
                    });
                  }, { operationKey: "seed" });
                  try {
                    await ctx.collections.notes.list(
                      denial === "foreign-cursor" ? { after: "private" } : {},
                    );
                    disclosed = true;
                  } catch {
                    caught = true;
                  }
                  return "caught";
                },
              }),
            },
          });
          const f = await fixture({
            registry,
            mode,
            callWaitMs: 5000,
            local: localOptions({
              actionIds: placement === "owner-local"
                ? ["fixture.local"]
                : ["fixture.idle"],
              policy: {
                grants: () => ({ ctx: ctxGranted, settlement: true }),
                input() {},
                collections: () => ({}),
              },
            }),
            policy: {
              worker: () => ({ ctx: ctxGranted, settlement: true }),
              ...(denial === "missing-policy" ? {} : {
                collectionRead() {
                  policyCalls++;
                  if (
                    policyCalls === 2 && denial === "last-policy-revocation"
                  ) ctxGranted = false;
                  return policyCalls === 2 && denial === "changed-scope"
                    ? {}
                    : { where: { title: "visible" } };
                },
              }),
            },
          });
          try {
            await assert.rejects(
              f.facade.actions.work("read", { operationKey: `deny-${denial}` }),
            );
            assert.equal(caught, true);
            assert.equal(disclosed, false);
            assert.equal(
              policyCalls,
              denial === "missing-policy"
                ? 0
                : denial === "foreign-cursor"
                ? 1
                : 2,
            );
            assert.equal(
              (await f.db.query(
                "SELECT key FROM owner_receipts WHERE kind='collections.read'",
              )).rows.length,
              0,
            );
          } finally {
            await f.close();
          }
        },
      );
    }
  }
}

for (const mode of ["in-process", "websocket"] as const) {
  for (const placement of ["owner-local", "worker"] as const) {
    test(
      `ordinary Processor read closes final event-policy grant window / ${placement} / ${mode}`,
      { skip: !sourceRoot },
      async () => {
        let ctxGranted = true,
          readPolicies = 0,
          disclosed = false,
          caught = false;
        const registry = createPluginRegistry({
          collections: { notes },
          actions: {
            work: defineAction({
              id: "fixture.local",
              inputSchema: { type: "string" } as const,
              async execute(_value: string, ctx: ActionContext) {
                await ctx.transaction(
                  ({ collections }) =>
                    collections.notes.create({
                      id: "trigger",
                      title: "visible",
                    }),
                  { operationKey: "seed" },
                );
                return "done";
              },
            }),
          },
          processors: {
            read: defineProcessor({
              id: "fixture.read",
              on: [{ eventType: "local_note.created" }],
              async handle(_event, ctx: ProcessorContext) {
                try {
                  await ctx.collections.notes.get({ id: "trigger" });
                  disclosed = true;
                } catch {
                  caught = true;
                }
              },
            }),
          },
        });
        const eventPolicy = () => {
          if (readPolicies === 2) ctxGranted = false;
        };
        const f = await fixture({
          registry,
          mode,
          ...(placement === "owner-local"
            ? {
              processors: {
                processorIds: ["fixture.read"],
                policy: {
                  grants: () => ({ ctx: ctxGranted, settlement: true }),
                  event: eventPolicy,
                  collections: () => ({}),
                },
                createCapabilities: () => ({ resources: {}, adapters: {} }),
              },
            }
            : {}),
          policy: {
            worker: () => ({ ctx: ctxGranted, settlement: true }),
            processorEvent: eventPolicy,
            collectionRead() {
              readPolicies++;
              return {};
            },
          },
        });
        const run = outcome(
          f.facade.actions.work("read", { operationKey: "event-window" }),
        );
        try {
          await eventually(() => caught || disclosed);
          assert.equal(
            disclosed,
            false,
            "final event policy must not disclose with its stale ctx grant",
          );
          assert.equal(caught, true);
        } finally {
          await f.close();
          await run;
        }
      },
    );
  }
}

for (const mode of ["in-process", "websocket"] as const) {
  for (const kind of ["action", "processor"] as const) {
    test(
      `ordinary local ${kind} read keeps raw COMMIT acknowledgement charged through close / ${mode}`,
      { skip: !sourceRoot },
      async () => {
        const release = deferred();
        let held = false, disclosed = false, closed = false;
        const read = async (ctx: ActionContext | ProcessorContext) => {
          try {
            await ctx.collections.notes.get({ id: "trigger" });
            disclosed = true;
          } catch { /* private close still owns completion */ }
        };
        const registry = createPluginRegistry({
          collections: { notes },
          actions: {
            work: defineAction({
              id: "fixture.local",
              inputSchema: { type: "string" } as const,
              async execute(_value: string, ctx: ActionContext) {
                await ctx.transaction(
                  ({ collections }) =>
                    collections.notes.create({
                      id: "trigger",
                      title: "visible",
                    }),
                  { operationKey: "seed" },
                );
                if (kind === "action") await read(ctx);
                return "done";
              },
            }),
          },
          ...(kind === "processor"
            ? {
              processors: {
                read: defineProcessor({
                  id: "fixture.read",
                  on: [{ eventType: "local_note.created" }],
                  async handle(_event, ctx: ProcessorContext) {
                    await read(ctx);
                  },
                }),
              },
            }
            : {}),
        });
        const f = await fixture({
          registry,
          mode,
          policy: { collectionRead: () => ({}) },
          ...(kind === "processor"
            ? {
              processors: {
                processorIds: ["fixture.read"],
                policy: {
                  grants: () => ({ ctx: true, settlement: true }),
                  event() {},
                  collections: () => ({}),
                },
                createCapabilities: () => ({ resources: {}, adapters: {} }),
              },
            }
            : {}),
          session(db) {
            return {
              ...db,
              async transaction(run) {
                let reading = false;
                const result = await db.transaction((tx) =>
                  run({
                    query(sql, params) {
                      if (sql.includes("AS bounded_value")) reading = true;
                      return tx.query(sql, params);
                    },
                  })
                );
                // The actual COMMIT happened; only its raw acknowledgement is held.
                if (reading && !held) {
                  held = true;
                  await release.promise;
                }
                return result;
              },
            };
          },
        });
        const running = outcome(
          f.facade.actions.work("read", { operationKey: "held-read" }),
        );
        try {
          await eventually(() => held);
          const closing = f.host.close().then(() => {
            closed = true;
          });
          await new Promise((resolve) => setTimeout(resolve, 20));
          assert.equal(closed, false);
          assert.equal(disclosed, false);
          // Independent SQL observation; the serialized owner pump is still held.
          assert.equal(
            (await f.db.query(
              "SELECT key FROM owner_receipts WHERE kind='collections.read'",
            )).rows.length,
            0,
          );
          release.resolve();
          await closing;
          assert.equal(disclosed, false);
        } finally {
          release.resolve();
          await f.close();
          await running;
        }
      },
    );
  }
}
