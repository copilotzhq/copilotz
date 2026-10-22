import { createAuthorizationOwner } from "../authorization/owner.ts";
import type { OperationCatalog } from "../streams/catalog.ts";
import { assert, assertEquals, assertRejects } from "@std/assert";
import { createOwnerTestDatabase } from "../testing/owner-database.ts";
import { bindSqlDatabaseIdentity } from "../events/database-identity.ts";
import type { SqlExecutor, SqlSession } from "../events/session.ts";
import {
  createSchemaCommandRunner,
  openDatabaseOwner,
  releaseDatabaseOwner,
} from "../engine/commands.ts";
import {
  createEventStore,
  type EventCoordinator,
  provisionCopilotzSchema,
} from "../events/index.ts";
import { defineCollection } from "./definition.ts";
import { createCollectionRuntime } from "./kernel.ts";
import { projectCollectionEvent } from "./reducer.ts";
import {
  authorizationRefused,
  collectionAuthorizations,
  createOwnerEvaluator,
  type OwnerAuthorization,
} from "../authorization/evaluator.ts";
import {
  type CollectionInvocationAuthority,
  withOwnerCollectionInvocation,
} from "../authorization/invocation.ts";
import { testAuthority } from "../testing/authority.ts";
import {
  type AuthenticatedAuthority,
  credentialValidity,
} from "../authorization/authority.ts";
import {
  observeAuthorizationCache,
  readAuthorizationRecord,
} from "../authorization/cache.ts";
import { assertCachedOwnerInvocationLive } from "../engine/invocation-liveness.ts";
import { defineAction } from "../actions/define.ts";
import type { ActionContext } from "../actions/types.ts";
import { createPluginRegistry } from "../plugins/registry.ts";
import { createOwnerCapabilityHost } from "../execution/owner-capabilities.ts";
import { createOwnerWorkerWorkloads } from "../execution/owner-capability-worker.ts";
import {
  type CapabilityCall,
  decodeCapability,
  encodeCapability,
  OWNER_CAPABILITY_WORKLOAD,
  readCapability,
} from "../execution/owner-capability-wire.ts";
import type { WorkerCallContext } from "../../dependencies/oxian-hypervisor.ts";
import type { WorkerWorkHandler } from "../../dependencies/oxian-worker.ts";

async function fixture(attempt = false) {
  const database = await createOwnerTestDatabase();
  const sql: string[] = [];
  let transactions = 0;
  const track = (tx: SqlExecutor): SqlExecutor => ({
    query(s, p) {
      sql.push(s);
      return tx.query(s, p);
    },
  });
  const db: SqlSession = bindSqlDatabaseIdentity({
    ...track(database),
    transaction(fn) {
      transactions++;
      return database.transaction((tx) => fn(track(tx)));
    },
  }, database);
  const schema = "public", namespace = "space";
  await provisionCopilotzSchema(db, schema);
  let time = Date.now();
  let owner = await openDatabaseOwner(db, schema, {
    now: () => new Date(time),
  });
  const store = createEventStore({ session: db, schema });
  const run = createSchemaCommandRunner(db, schema);
  const records = defineCollection({
    name: "record",
    ownerPolicy: "required",
    schema: { type: "object" },
  });
  const facts = defineCollection({ name: "fact", schema: { type: "object" } });
  const root = await store.append({
    namespace,
    type: "agent.turn",
    payload: {},
  }, ["agent"]);
  const deliveryId = root.deliveries[0].id;
  await store.claimDelivery({
    id: deliveryId,
    owner: "worker",
    leaseMs: 60_000,
  });
  const authority: AuthenticatedAuthority = {
    ...testAuthority(schema, namespace),
    validity: credentialValidity(new Date(time)),
    principal: { kind: "session", id: "member" },
    authorityBasis: { kind: "session", id: "session" },
    ...(attempt
      ? {
        principal: {
          kind: "worker" as const,
          id: "worker",
          executing: "agent",
          initiating: "member",
        },
        authorityBasis: { kind: "attempt" as const, id: deliveryId },
        validity: {
          kind: "attempt" as const,
          attempt: deliveryId,
          worker: "worker",
          epoch: String(owner.epoch),
        },
      }
      : {}),
  };
  await run("seed", {}, async (_, c) => {
    for (let i = 0; i < 10; i++) {
      await c.transaction.query(
        `INSERT INTO public.nodes(id,namespace,type,name,data) VALUES($1,'space','fact',$1,'{"allowed":true}')`,
        [`fact-${i}`],
      );
    }
    await c.transaction.query(
      `INSERT INTO public.nodes(id,namespace,type,name,data) VALUES('record','space','record','record','{"visible":true,"value":1}')`,
    );
    await c.transaction.query(
      `INSERT INTO public.authorization_sessions(namespace,tenant,id,principal,expires_at) VALUES('space','fixture','session','member',$1)`,
      [new Date(time + 60_000).toISOString()],
    );
  });
  const phases: string[] = [];
  const policy: OwnerAuthorization["policies"][string] = {
    revision: "1",
    sources: ["facts"],
    async evaluate({ intent, read }) {
      phases.push(
        intent.kind === "collection"
          ? String((intent.input as { phase: string }).phase)
          : intent.operation,
      );
      for (let i = 0; i < 10; i++) {
        if (
          !(await read.get("facts", `fact-${i}`))?.allowed
        ) authorizationRefused();
      }
      const current = (intent.input as { current?: { visible?: boolean } })
        ?.current;
      if (current?.visible === false) authorizationRefused();
      return { collections: { records: {} }, operations: { metadata: {} } };
    },
  };
  const registration = {
    policies: { fixture: policy },
    collections: { records: { id: "fixture", revision: "1" } },
    actions: {},
  };
  const coordinator: EventCoordinator = {
    async commitMutation(input) {
      return {
        ...await store.commitMutation({ ...input, consumers: [] }),
        dispatch: { handles: [], failures: [] },
      };
    },
    append() {
      throw new Error("unused");
    },
    recover() {
      throw new Error("unused");
    },
  };
  const runtime = createCollectionRuntime({
    session: db,
    eventStore: store,
    coordinator,
    policies: collectionAuthorizations(
      registration,
      { records, facts },
      schema,
    ),
  });
  runtime.bind(records);
  runtime.bind(facts);
  const invocation: CollectionInvocationAuthority = {
    authority,
    scope: { databaseSchema: schema, namespace },
    invocation: { kind: "processor", id: "agent", runId: "worker" },
    signal: owner.signal,
    check() {
      owner.signal.throwIfAborted();
    },
    assertCurrent: (read) =>
      assertCachedOwnerInvocationLive(read, {
        databaseSchema: schema,
        namespace,
        eventId: root.event.id,
        writer: { deliveryId, leaseOwner: "worker" },
      }),
    resolveSource() {
      throw new Error("unused");
    },
  };
  const scoped = runtime.withScope({ namespace });
  const invoke = <T>(fn: () => Promise<T>) =>
    withOwnerCollectionInvocation(invocation, fn);
  const get = () => invoke(() => scoped.record.get({ id: "record" }));
  const counts: Record<string, number> = {};
  await run("observe", {}, (_, c) => {
    observeAuthorizationCache(c.transaction, (cache, result) => {
      counts[`${cache}.${result}`] = (counts[`${cache}.${result}`] ?? 0) + 1;
    });
  });
  return {
    db,
    sql,
    phases,
    counts,
    get,
    invoke,
    invocation,
    scoped,
    records,
    store,
    deliveryId,
    sourceEventId: root.event.id,
    owner,
    authority,
    registration,
    run,
    get transactions() {
      return transactions;
    },
    list: () => invoke(() => scoped.record.list({})),
    advance(ms: number) {
      time += ms;
    },
    async write(
      collection: "record" | "fact",
      id: string,
      data: Record<string, unknown>,
      create = false,
    ) {
      const definition = collection === "record" ? records : facts;
      await run("write", {}, (_, c) =>
        projectCollectionEvent(
          { transaction: c.transaction, tables: store.tables },
          definition,
          create
            ? {
              operation: "create",
              intent: { operation: "create", input: { id, ...data } },
              record: {
                id,
                namespace,
                ...data,
                createdAt: new Date(time).toISOString(),
                updatedAt: new Date(time).toISOString(),
              },
              assets: [],
            }
            : {
              operation: "update",
              id,
              set: data,
              unset: [],
              intent: { operation: "update", id, set: data, unset: [] },
              record: {
                id,
                namespace,
                ...data,
                createdAt: new Date(time).toISOString(),
                updatedAt: new Date(time).toISOString(),
              },
              assets: [],
            },
        ));
    },
    async restart() {
      await releaseDatabaseOwner(owner);
      owner = await openDatabaseOwner(db, schema, {
        now: () => new Date(time),
      });
    },
    async close() {
      await releaseDatabaseOwner(owner);
      await database.close();
    },
  };
}

Deno.test("Collection decisions reuse each phase; record versions, dependencies and list sets invalidate", async () => {
  const f = await fixture();
  try {
    await f.get();
    assertEquals(f.phases, ["read", "result"]);
    for (let i = 0; i < 5; i++) {
      const before = f.sql.length;
      await f.get();
      assertEquals(f.sql.length - before, 2);
    }
    assertEquals(f.phases, ["read", "result"]);
    await f.store.append(
      { namespace: "space", type: "unrelated", payload: {} },
      ["other"],
    );
    const afterAppend = f.sql.length;
    await f.get();
    assertEquals(f.sql.length - afterAppend, 2);
    let recordReads = 0;
    const readRecord = () =>
      f.run(
        "read-record",
        {},
        (_, c) =>
          readAuthorizationRecord(c.transaction, "public", {
            owner: "schema",
            namespace: "space",
            collection: "record",
            id: "record",
          }, async () => {
            recordReads++;
            return (await c.transaction.query(
              "SELECT data FROM public.nodes WHERE id='record'",
            )).rows[0];
          }),
      );
    await readRecord();
    const readsBeforeWrite = recordReads;
    const recordHits = f.counts["authorization-record.hit"] ?? 0;
    await f.write("record", "other", { visible: true, value: 1 }, true);
    await readRecord();
    assertEquals(recordReads, readsBeforeWrite);
    assertEquals(f.counts["authorization-record.hit"], recordHits + 1);
    await f.get();
    assertEquals(f.phases.length, 2);
    await f.write("record", "record", { visible: true, value: 2 });
    await readRecord();
    assertEquals(recordReads, readsBeforeWrite + 1);
    await f.get();
    assertEquals(f.phases.length, 4);
    await f.list();
    const count = f.phases.length;
    await f.list();
    assertEquals(f.phases.length, count);
    await f.write("record", "third", { visible: true }, true);
    await f.list();
    assertEquals(f.phases.length, count + 4);
    await f.write("record", "record", { visible: false });
    await assertRejects(f.get);
    await f.write("record", "record", { visible: true });
    await f.get();
    await f.write("fact", "fact-3", { allowed: false });
    await assertRejects(f.get);
  } finally {
    await f.close();
  }
});

Deno.test("manifest projections invalidate asset points and sets while unrelated records stay warm", async () => {
  const f = await fixture();
  const reads: Record<string, number> = {};
  const assets = (id?: string) =>
    f.run(
      "read-assets",
      {},
      (_, c) =>
        readAuthorizationRecord(c.transaction, "public", {
          owner: "schema",
          namespace: "space",
          collection: "asset",
          ...(id ? { id } : {}),
        }, async () => {
          const key = id ?? "all";
          reads[key] = (reads[key] ?? 0) + 1;
          return (await c.transaction.query(
            "SELECT id FROM public.nodes WHERE namespace='space' AND type='asset'" +
              (id ? " AND id=$1" : ""),
            id ? [id] : [],
          )).rows;
        }),
    );
  try {
    await f.get();
    assertEquals(await assets("body-A"), []);
    assertEquals(await assets("body-B"), []);
    assertEquals(await assets(), []);
    await f.run("project-manifest", {}, (_, c) =>
      projectCollectionEvent(
        { transaction: c.transaction, tables: f.store.tables },
        f.records,
        {
          operation: "create",
          intent: { operation: "create", input: { id: "other" } },
          record: {
            id: "other",
            namespace: "space",
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
          assets: [{
            assetId: "body-A",
            bodyId: "bytes-A",
            mediaType: "text/plain",
            byteLength: 0,
            digest: `sha256:${"0".repeat(64)}`,
            createdAt: "2026-01-01T00:00:00.000Z",
          }],
        },
      ));
    assertEquals(await assets("body-A"), [{ id: "body-A" }]);
    assertEquals(await assets(), [{ id: "body-A" }]);
    assertEquals(await assets("body-B"), []);
    assertEquals(reads, { "body-A": 2, "body-B": 1, all: 2 });
    await f.get();
    assertEquals(f.phases, ["read", "result"]);
  } finally {
    await f.close();
  }
});

Deno.test("a Collection notice is not a complete SQL write set", async () => {
  const f = await fixture();
  try {
    await f.get();
    await f.store.commitMutation({
      draft: { namespace: "space", type: "opaque.changed", payload: {} },
      consumers: [],
      collectionChange: { collection: "record", id: "other", record: null },
      statement: (_param, tables) => ({
        ctes: [],
        gate: "TRUE",
        effects: (source) => [
          `opaque_write AS (
            UPDATE ${tables.nodes} SET data='{"allowed":false}'::jsonb
            WHERE namespace='space' AND id='fact-3'
            AND EXISTS(SELECT 1 FROM ${source})
          )`,
        ],
        report: "'{}'::jsonb",
        resolve: () => undefined,
      }),
    });
    await assertRejects(f.get);
  } finally {
    await f.close();
  }
});

Deno.test("Collection reuse refuses revoked sessions, exact expiry, lost leases and owner changes", async (t) => {
  for (
    const mode of [
      "session",
      "expiry",
      "attempt",
      "epoch",
      "policy",
      "source",
    ] as const
  ) {
    await t.step(mode, async () => {
      const f = await fixture(mode === "attempt");
      try {
        await f.get();
        await f.get();
        if (mode === "session") {
          await f.run("revoke", {}, (_, c) =>
            c.transaction.query(
              `UPDATE public.authorization_sessions SET revoked_at=NOW() WHERE id='session'`,
            ));
        }
        if (mode === "expiry") f.advance(60_000);
        if (mode === "attempt") {
          await f.store.succeedDelivery(f.deliveryId, "worker");
        }
        if (mode === "epoch") {
          await f.restart();
        }
        if (mode === "policy") {
          f.registration.policies.fixture = {
            ...f.registration.policies.fixture,
            revision: "2",
          };
        }
        if (mode === "source") {
          await f.run(
            "delete-source",
            {},
            (_, c) =>
              c.transaction.query(`DELETE FROM public.events WHERE id=$1`, [
                f.sourceEventId,
              ]),
          );
        }
        await assertRejects(f.get);
      } finally {
        await f.close();
      }
    });
  }
});

Deno.test("Observation attach decisions share tracked facts and detach returned constraints", async () => {
  const f = await fixture();
  try {
    const evaluate = createOwnerEvaluator({
      registration: f.registration,
      collections: {
        facts: defineCollection({ name: "fact", schema: { type: "object" } }),
      },
      databaseSchema: "public",
    });
    const attach = () =>
      f.run(
        "attach",
        {},
        (_, c) =>
          evaluate(f.authority, {
            kind: "observation",
            resource: "operations",
            operation: "attach",
            input: {},
          }, c),
      );
    const first = await attach();
    Reflect.set(first.constraints, "operations", { forged: true });
    const before = f.sql.length;
    assertEquals((await attach()).constraints.operations, { metadata: {} });
    assertEquals(f.sql.length - before, 1);
    assertEquals(f.phases, ["attach"]);
    await f.write("fact", "fact-1", { allowed: false });
    await assertRejects(attach);
  } finally {
    await f.close();
  }
});

Deno.test("Collection reuse retains negative reads, rolls back speculative grants and isolates policy replacements", async () => {
  const f = await fixture();
  try {
    const missing = () =>
      f.invoke(() => f.scoped.record.get({ id: "missing" }));
    assertEquals(await missing(), null);
    await missing();
    assertEquals(f.phases.length, 2);
    await f.write("record", "missing", { visible: true }, true);
    await missing();
    assertEquals(f.phases.length, 4);
    await f.get();
    await assertRejects(() =>
      f.run("rollback", {}, async () => {
        await f.write("fact", "fact-0", { allowed: false });
        await assertRejects(f.get);
        await f.write("fact", "fact-0", { allowed: true });
        await f.get();
        throw new Error("roll back the speculative grant");
      })
    );
    const count = f.phases.length;
    await f.get();
    assertEquals(f.phases.length, count + 2);
    f.registration.policies.fixture = {
      ...f.registration.policies.fixture,
      evaluate() {
        authorizationRefused();
      },
    };
    await assertRejects(f.get);
  } finally {
    await f.close();
  }
});

Deno.test("real observation attach reuses policy while retaining channel writes and fresh refusal", async () => {
  const f = await fixture();
  try {
    const authorization = createAuthorizationOwner({
      session: f.db,
      databaseSchema: "public",
      owner: f.owner,
      registration: f.registration,
      collections: {
        facts: defineCollection({ name: "fact", schema: { type: "object" } }),
      },
      operations: {
        get: () => Promise.resolve(null),
      } as unknown as OperationCatalog,
    });
    for (let i = 0; i < 20; i++) {
      await authorization.observe(
        {
          ...f.authority,
          requestFacts: { ...f.authority.requestFacts, input: { request: i } },
        },
        {},
        () => {},
      );
    }
    assertEquals(f.phases, ["attach"]);
    assertEquals(f.counts["evaluation.hit"], 19);
    await f.write("fact", "fact-4", { allowed: false });
    await assertRejects(() => authorization.observe(f.authority, {}, () => {}));
  } finally {
    await f.close();
  }
});

function body(bytes: Uint8Array) {
  return new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(bytes);
      c.close();
    },
  });
}
Deno.test("worker get benchmark: cross-request capability calls reuse both Collection phases", async () => {
  const f = await fixture();
  const samples: {
    ms: number;
    sql: number;
    evals: number;
    transactions: number;
  }[] = [];
  const workerDurations: number[] = [];
  const registry = createPluginRegistry({
    collections: { records: f.records },
    actions: {
      run: defineAction({
        id: "agent.read",
        async execute(_input: unknown, ctx: ActionContext) {
          for (let i = 0; i < 21; i++) {
            const start = performance.now();
            await ctx.collections.records.get({ id: "record" });
            workerDurations.push(performance.now() - start);
          }
        },
      }),
    },
  });
  const context = {
    namespace: "space",
    databaseSchema: "public",
    operationKey: "turn",
    identity: { settlementScopeId: "turn" },
    signal: f.owner.signal,
    now: () => new Date(),
    collections: {
      records: {
        ...f.scoped.record,
        get: async () => {
          const start = performance.now(),
            sql = f.sql.length,
            evals = f.phases.length,
            transactions = f.transactions;
          const request = samples.length;
          const result = await withOwnerCollectionInvocation({
            ...f.invocation,
            authority: {
              ...f.authority,
              requestFacts: { ...f.authority.requestFacts, input: { request } },
            },
            invocation: {
              kind: "processor",
              id: "agent",
              runId: `request-${request}`,
            },
          }, () => f.scoped.record.get({ id: "record" }));
          samples.push({
            ms: performance.now() - start,
            sql: f.sql.length - sql,
            evals: f.phases.length - evals,
            transactions: f.transactions - transactions,
          });
          return result;
        },
      },
    },
  } as unknown as ActionContext;
  const host = createOwnerCapabilityHost({
    registry,
    localExecution: true,
    resolveAuthority: () =>
      Promise.resolve({ epoch: f.owner.epoch!, signal: f.owner.signal }),
    createWorkloads: ({ registry }) => ({
      test: async () => {
        await registry.actions.run.execute({} as never, context as never);
        return {};
      },
    }),
  });
  const binding = {
    workload: OWNER_CAPABILITY_WORKLOAD,
    fence: {
      connectionId: "connection",
      sessionGeneration: 1,
      identity: { workerId: "worker", attemptId: "attempt", epoch: 1 },
    },
    parent: {
      streamId: "parent",
      workload: "test",
      operationId: "turn",
      metadata: { databaseSchema: "public", ownerEpoch: f.owner.epoch },
    },
    signal: f.owner.signal,
  } as unknown as WorkerCallContext;
  const roundTrips: number[] = [];
  const work: Parameters<WorkerWorkHandler>[0] = {
    streamId: "parent",
    workload: "test",
    metadata: {},
    signal: f.owner.signal,
    input: body(new Uint8Array()),
    sendMetadata: () => Promise.resolve(),
    async callHost(request) {
      assert(request.body instanceof Uint8Array);
      const start = performance.now();
      const call = decodeCapability(request.body) as CapabilityCall;
      const handler = await host.workerCalls.admit(binding);
      assert(handler);
      const encoded = await handler(
        {
          input: body(encodeCapability(call)),
          signal: f.owner.signal,
        } as never,
      );
      const response = await readCapability(body(encoded as Uint8Array));
      if (call.kind === "call") roundTrips.push(performance.now() - start);
      return {
        streamId: "host-call",
        metadata: Promise.resolve({}),
        started: Promise.resolve(),
        cancel: () => Promise.resolve(),
        output: body(encodeCapability(response)),
        completed: Promise.resolve(),
      };
    },
  };
  try {
    await createOwnerWorkerWorkloads({ registry, workloads: ["test"] }).test(
      work,
    );
    const warm = samples.slice(1);
    const sorted = workerDurations.slice(1).sort((a, b) => a - b);
    console.log(
      JSON.stringify({
        getBenchmark: {
          first: samples[0],
          warm,
          workerDurations,
          roundTrips,
          medianMs: sorted[Math.floor(sorted.length / 2)],
          counts: f.counts,
          evaluations: f.phases.length,
        },
      }),
    );
    assertEquals(samples.length, 21);
    if (
      Deno.env.get("AUTHZ_REUSE_BASELINE") !== "1" &&
      Deno.env.get("AUTHZ_READSET_BASELINE") !== "1"
    ) {
      assertEquals(f.phases.length, 2);
      assertEquals(warm.map((s) => s.sql), Array(20).fill(2));
      assertEquals(warm.map((s) => s.evals), Array(20).fill(0));
      assertEquals(f.counts["evaluation.hit"], 40);
    }
  } finally {
    await host.close();
    await f.close();
  }
});

Deno.test("Time-dependent policies remain fresh across commands", async () => {
  const f = await fixture();
  try {
    const policy = f.registration.policies.fixture;
    const evaluate = policy.evaluate;
    let deadline: number | undefined;
    f.registration.policies.fixture = {
      ...policy,
      async evaluate(context) {
        deadline ??= Date.parse(context.commandTime) + 1000;
        if (Date.parse(context.commandTime) >= deadline) authorizationRefused();
        return await evaluate(context);
      },
    };
    await f.get();
    await f.get();
    assertEquals(f.phases.length, 4);
    f.advance(1000);
    await assertRejects(f.get);
  } finally {
    await f.close();
  }
});

Deno.test("Policy read sets distinguish inspected fields and share unread request/run fields", async (t) => {
  for (
    const mode of [
      "unread",
      "run",
      "fact",
      "spread",
      "keys",
      "json",
      "context",
      "descriptors",
    ] as const
  ) {
    await t.step(mode, async () => {
      const f = await fixture();
      try {
        const policy = f.registration.policies.fixture;
        f.registration.policies.fixture = {
          ...policy,
          async evaluate(context) {
            if (
              mode === "run" && context.intent.invocation?.runId === "blocked"
            ) authorizationRefused();
            if (
              mode === "fact" &&
              (context.authority.requestFacts.input as { nonce: string })
                  .nonce === "blocked"
            ) authorizationRefused();
            if (mode === "spread") void { ...context.authority };
            if (mode === "keys") {
              Object.keys(context.authority.requestFacts.input as object);
            }
            if (mode === "json") JSON.stringify(context.intent);
            if (mode === "context") Object.keys(context);
            if (mode === "descriptors") {
              Object.getOwnPropertyDescriptors(context);
            }
            return await policy.evaluate(context);
          },
        };
        const get = (nonce: string) =>
          withOwnerCollectionInvocation({
            ...f.invocation,
            authority: {
              ...f.authority,
              requestFacts: { ...f.authority.requestFacts, input: { nonce } },
            },
            invocation: { kind: "processor", id: "agent", runId: nonce },
          }, () => f.scoped.record.get({ id: "record" }));
        await get("one");
        await get("one");
        assertEquals(f.phases.length, 2);
        await get("two");
        assertEquals(f.phases.length, mode === "unread" ? 2 : 4);
        if (mode === "run" || mode === "fact") {
          await assertRejects(() => get("blocked"));
        }
        if (mode === "unread") {
          await f.write("fact", "fact-0", { allowed: false });
          await assertRejects(() => get("three"));
        }
      } finally {
        await f.close();
      }
    });
  }
});

Deno.test("Read sets bind current authority and validate a new attempt even when its ID is unread", async () => {
  const f = await fixture(true);
  try {
    const evaluate = createOwnerEvaluator({
      registration: f.registration,
      collections: {
        facts: defineCollection({ name: "fact", schema: { type: "object" } }),
      },
      databaseSchema: "public",
    });
    const call = (authority: AuthenticatedAuthority) =>
      f.run("read", {}, (_, c) =>
        evaluate(authority, {
          kind: "collection",
          resource: "records",
          operation: "get",
          input: {
            phase: "read",
            collection: { name: "record" },
            args: { id: "record" },
          },
        }, c));
    await call(f.authority);
    const next = await f.store.append({
      namespace: "space",
      type: "next",
      payload: {},
    }, ["agent"]);
    const id = next.deliveries[0].id;
    await f.store.claimDelivery({ id, owner: "worker", leaseMs: 60_000 });
    const authority: AuthenticatedAuthority = {
      ...f.authority,
      authorityBasis: { kind: "attempt", id },
      validity: {
        kind: "attempt",
        attempt: id,
        worker: "worker",
        epoch: String(f.owner.epoch),
      },
    };
    const decision = await call(authority);
    assertEquals(decision.authority, authority);
    assertEquals(f.phases, ["read"]);
    await f.store.succeedDelivery(f.deliveryId, "worker");
    await assertRejects(() => call(f.authority));
    await call(authority);
    assertEquals(f.phases, ["read"]);
    await f.store.succeedDelivery(id, "worker");
    await assertRejects(() => call(authority));
  } finally {
    await f.close();
  }
});

Deno.test("Untrackable policy views cannot retain a decision; detached audit reads remain compatible", async (t) => {
  for (const mode of ["signal", "mutation", "output", "late"] as const) {
    await t.step(mode, async () => {
      const f = await fixture();
      const views: AuthenticatedAuthority[] = [];
      try {
        const policy = f.registration.policies.fixture;
        f.registration.policies.fixture = {
          ...policy,
          async evaluate(context) {
            if (mode === "signal") void context.signal.aborted;
            if (mode === "mutation") {
              Reflect.set(context.authority.scope, "tenant", "forged");
            }
            if (mode === "late") views.push(context.authority);
            const result = await policy.evaluate(context);
            return mode === "output"
              ? {
                ...result,
                operations: { metadata: context.authority.scope.bindings },
              }
              : result;
          },
        };
        await f.get();
        for (const view of views) assertEquals(view.principal.id, "member");
        await f.get();
        assertEquals(f.phases.length, 4);
      } finally {
        await f.close();
      }
    });
  }
});
