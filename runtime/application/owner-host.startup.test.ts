import { provisionOperationCatalog } from "../streams/catalog.ts";
import { provisionOwnerCommandSchema } from "../owner/schema.ts";
import { provisionOwnerAssignments } from "../owner/assignments.ts";
import { insertTestOwnerStream } from "../testing/owner-catalog.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { defineAction } from "../actions/define.ts";
import { defineCollection } from "../collections/definition.ts";
import { validateCollectionIndexes } from "../collections/indexes.ts";
import { createPluginRegistry } from "../plugins/registry.ts";
import { createTestDatabase } from "../testing/ominipg.ts";
import { createOwnerHost, type OwnerHostOptions } from "./owner-host.ts";
import { provisionCopilotzSchema } from "../events/schema.ts";
import { encodeEventBody } from "../events/body-store.ts";
import type { SqlSession } from "../events/session.ts";

const indexed = defineCollection({
  name: "unique_note",
  schema: {
    type: "object",
    properties: { id: { type: "string" }, code: { type: "string" } },
    required: ["id", "code"],
  } as const,
  indexes: [{ fields: "code", unique: true }],
});
function registry() {
  return createPluginRegistry({
    collections: { notes: indexed },
    actions: {
      work: defineAction({
        id: "work",
        inputSchema: { type: "string" } as const,
        outputSchema: { type: "string" } as const,
        execute: (value: string) => value,
      }),
    },
  });
}
function options(
  session: SqlSession,
  extra: Partial<OwnerHostOptions> = {},
): OwnerHostOptions {
  return {
    ownerId: "owner",
    holderId: "first",
    schema: "public",
    session,
    initialization: "fresh",
    registry: registry(),
    policy: {
      ingress: () => undefined,
      worker: () => ({ ctx: true, settlement: true }),
      input() {},
      collections: () => ({}),
      effectOutcome: () => true,
      effectNotStarted: () => false,
    },
    transport: { transports: [] },
    createTransport() {
      return {
        prepare() {},
        snapshot: () => ({}),
        shutdown: () => Promise.resolve(),
      } as never;
    },
    ...extra,
  };
}
test("owner startup provisions declared fresh indexes before serving and enforces namespace uniqueness", async () => {
  const db = await createTestDatabase({ pgliteMemoryProfile: "low-memory" });
  let host: Awaited<ReturnType<typeof createOwnerHost>> | undefined;
  try {
    host = await createOwnerHost(options(db));
    await validateCollectionIndexes(db, "public", [indexed]);
    assert.equal(host.snapshot().ready, true);
    await db.query(
      `INSERT INTO nodes(id,namespace,type,name,data) VALUES('one','space','unique_note','fixture','{"id":"one","code":"same"}')`,
    );
    await assert.rejects(
      db.query(
        `INSERT INTO nodes(id,namespace,type,name,data) VALUES('two','space','unique_note','fixture','{"id":"two","code":"same"}')`,
      ),
      /unique|duplicate/i,
    );
    await db.query(
      `INSERT INTO nodes(id,namespace,type,name,data) VALUES('three','other','unique_note','fixture','{"id":"three","code":"same"}')`,
    );
  } finally {
    await host?.close();
    await db.close();
  }
});

test("owner startup validates every resume option before SQL or transport", async () => {
  let sql = 0, transports = 0;
  const db: SqlSession = {
    query() {
      sql++;
      throw new Error("unexpected SQL");
    },
    transaction() {
      sql++;
      throw new Error("unexpected SQL");
    },
  };
  for (
    const initialization of [
      undefined,
      null,
      [],
      "resume",
      {},
      { mode: "resume", expectedEpoch: 0 },
      { mode: "resume", expectedEpoch: Number.MAX_SAFE_INTEGER },
      { mode: "resume", expectedEpoch: 1.5 },
      { mode: "resume", expectedEpoch: 1, maxItems: 0 },
      { mode: "resume", expectedEpoch: 1, maxItems: 10001 },
      { mode: "resume", expectedEpoch: 1, maxBytes: 0 },
      { mode: "resume", expectedEpoch: 1, maxBytes: 32 * 1024 * 1024 + 1 },
      { mode: "resume", expectedEpoch: 1, maxPasses: 0 },
      { mode: "resume", expectedEpoch: 1, maxPasses: 17 },
      { mode: "resume", expectedEpoch: 1, ready: true },
      ...["maxItems", "maxBytes", "maxPasses"].flatMap((field) =>
        [null, undefined, "1", true, NaN].map((value) => ({
          mode: "resume",
          expectedEpoch: 1,
          [field]: value,
        }))
      ),
    ]
  ) {
    await assert.rejects(createOwnerHost(options(db, {
      initialization: initialization as never,
      createTransport() {
        transports++;
        throw new Error("unexpected transport");
      },
    })));
  }
  assert.equal(sql, 0);
  assert.equal(transports, 0);
});

test("owner startup refuses a missing fresh index after commit and closes a constructed transport after revalidation fails", async () => {
  const db = await createTestDatabase({ pgliteMemoryProfile: "low-memory" });
  let transportCount = 0, shutdowns = 0, dropBeforeProof = false;
  const session: SqlSession = {
    query: db.query,
    async transaction(run) {
      if (dropBeforeProof) {
        dropBeforeProof = false;
        const row = (await db.query<{ indexname: string }>(
          "SELECT indexname FROM pg_indexes WHERE schemaname='public' AND indexname LIKE 'collection_idx_%' LIMIT 1",
        )).rows[0];
        await db.query(`DROP INDEX "${row.indexname}"`);
      }
      return await db.transaction(run);
    },
  };
  try {
    await assert.rejects(
      createOwnerHost(options(session, {
        createTransport() {
          transportCount++;
          dropBeforeProof = true;
          return {
            prepare() {},
            snapshot: () => ({}),
            shutdown() {
              shutdowns++;
              return Promise.resolve();
            },
          } as never;
        },
      })),
      /indexes missing/i,
    );
    assert.equal(transportCount, 1);
    assert.equal(shutdowns, 1);
  } finally {
    await db.close();
  }
});

test("owner startup proves orphan body emptiness before declared-index DDL", async () => {
  const db = await createTestDatabase({ pgliteMemoryProfile: "low-memory" });
  await provisionCopilotzSchema(db, "public");
  const body = await encodeEventBody({ ordinary: "orphan" });
  await db.query(
    "INSERT INTO event_bodies(namespace,event_body_id,schema_version,body,digest) VALUES('space','orphan',1,$1::jsonb,$2)",
    [body.body, body.digest],
  );
  let injected = false, transports = 0, indexes = 0;
  const session: SqlSession = {
    query: db.query,
    transaction: (run) =>
      db.transaction((tx) =>
        run({
          async query(sql, params) {
            if (sql.startsWith('SELECT 1 FROM "public"."event_bodies" LIMIT')) {
              injected = true;
              // Deliberate orphan evidence returned by the actual fenced read.
              return { rows: [{ present: true }] } as never;
            }
            if (
              /^CREATE (UNIQUE )?INDEX/.test(sql) &&
              sql.includes("collection_idx_")
            ) indexes++;
            return await tx.query(sql, params);
          },
        })
      ),
  };
  try {
    await assert.rejects(
      createOwnerHost(options(session, {
        createTransport() {
          transports++;
          throw new Error("unexpected");
        },
      })),
      { code: "owner_content_catalog_schema_incompatible" },
    );
    assert.equal(injected, true);
    assert.equal(indexes, 0);
    assert.equal(transports, 0);
  } finally {
    await db.close();
  }
});

test("owner resume never provisions missing indexes or schemas and preserves the prior epoch on validation refusal", async () => {
  const db = await createTestDatabase({ pgliteMemoryProfile: "low-memory" });
  const host = await createOwnerHost(options(db));
  await host.close();
  let ddl = 0, transports = 0;
  const session: SqlSession = {
    async query(sql, params) {
      if (/^(CREATE|ALTER)/.test(sql)) ddl++;
      return await db.query(sql, params);
    },
    transaction: (run) =>
      db.transaction((tx) =>
        run({
          async query(sql, params) {
            if (/^(CREATE|ALTER)/.test(sql)) ddl++;
            return await tx.query(sql, params);
          },
        })
      ),
  };
  try {
    const row = (await db.query<{ indexname: string }>(
      "SELECT indexname FROM pg_indexes WHERE schemaname='public' AND indexname LIKE 'collection_idx_%' LIMIT 1",
    )).rows[0];
    await db.query(`DROP INDEX "${row.indexname}"`);
    const resumed = options(session, {
      initialization: { mode: "resume", expectedEpoch: 1 },
      createTransport() {
        transports++;
        throw new Error("unexpected");
      },
    });
    await assert.rejects(createOwnerHost(resumed), /indexes missing/i);
    await db.query("DROP TABLE owner_receipt_readers");
    await assert.rejects(createOwnerHost(resumed), /schema|column|principal/i);
    assert.equal(ddl, 0);
    assert.equal(transports, 0);
    assert.equal(
      Number((await db.query("SELECT epoch FROM owner_epochs")).rows[0].epoch),
      1,
    );
  } finally {
    await db.close();
  }
});

test("owner resume retains unsupported graph blockers without constructing transport", async () => {
  const db = await createTestDatabase({ pgliteMemoryProfile: "low-memory" });
  const host = await createOwnerHost(options(db));
  await host.close();
  let transports = 0;
  try {
    await db.query(
      `INSERT INTO nodes(id,namespace,type,name,data) VALUES('old','space','unique_note','fixture','{"id":"old","code":"old"}')`,
    );
    await assert.rejects(
      createOwnerHost(
        options(db, {
          initialization: { mode: "resume", expectedEpoch: 1 },
          createTransport() {
            transports++;
            throw new Error("unexpected");
          },
        }),
      ),
      /startup blockers/,
    );
    assert.equal(transports, 0);
    assert.equal(
      Number((await db.query("SELECT epoch FROM owner_epochs")).rows[0].epoch),
      2,
    );
    assert.match(
      JSON.stringify((await db.query("SELECT name FROM owner_alarms")).rows),
      /startup.nodes/,
    );
  } finally {
    await db.close();
  }
});

test("owner resume keeps ingress denied before its second proof and closes on newly unresolved alarms", async () => {
  const db = await createTestDatabase({ pgliteMemoryProfile: "low-memory" });
  const host = await createOwnerHost(options(db));
  await host.close();
  let inject = false, shutdowns = 0;
  let ingress: Promise<unknown> | undefined;
  const session: SqlSession = {
    query: db.query,
    async transaction(run) {
      if (inject) {
        inject = false;
        await db.query(
          `INSERT INTO owner_alarms(owner,name,due_at) VALUES('owner','["unknown","space","late"]',now())`,
        );
      }
      return await db.transaction(run);
    },
  };
  try {
    await assert.rejects(
      createOwnerHost(options(session, {
        holderId: "second",
        initialization: { mode: "resume", expectedEpoch: 1 },
        createTransport(config) {
          inject = true;
          ingress = Promise.resolve(config.workerCalls.admitUnassigned!({
            workload: "copilotz.owner.action-call",
            metadata: { ownerId: "owner" },
            signal: new AbortController().signal,
            fence: {
              identity: { workerId: "ingress", attemptId: "attempt", epoch: 1 },
              connectionId: "session",
              sessionGeneration: 1,
            },
          }));
          return {
            prepare() {},
            snapshot: () => ({}),
            shutdown() {
              shutdowns++;
              return Promise.resolve();
            },
          } as never;
        },
      })),
      /startup|alarm/i,
    );
    assert.equal(await ingress, undefined);
    assert.equal(shutdowns, 1);
    assert.equal(
      (await db.query(
        "SELECT name FROM owner_alarms WHERE name LIKE '%unknown%'",
      )).rows.length,
      1,
    );
  } finally {
    await db.close();
  }
});

test("owner startup stops on unknown initialization commit without constructing transport", async () => {
  const db = await createTestDatabase({ pgliteMemoryProfile: "low-memory" });
  let transports = 0;
  const session: SqlSession = {
    query: db.query,
    async transaction(run) {
      let initialization = false;
      const result = await db.transaction((tx) =>
        run({
          async query(sql, params) {
            if (
              sql.startsWith("INSERT INTO") && sql.includes("owner_receipts") &&
              params?.includes("host.initialize-fresh")
            ) initialization = true;
            return await tx.query(sql, params);
          },
        })
      );
      if (initialization) {
        throw new Error("fixture lost initialize COMMIT reply");
      }
      return result;
    },
  };
  try {
    await assert.rejects(
      createOwnerHost(options(session, {
        createTransport() {
          transports++;
          throw new Error("unexpected");
        },
      })),
      /commit|unknown/i,
    );
    assert.equal(transports, 0);
    await validateCollectionIndexes(db, "public", [indexed]);
    assert.equal(
      (await db.query(
        "SELECT 1 FROM owner_receipts WHERE kind='host.initialize-fresh'",
      )).rows.length,
      1,
    );
  } finally {
    await db.close();
  }
});

async function within<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_yes, no) => {
        timer = setTimeout(
          () => no(new Error("startup transport fixture timed out")),
          12000,
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
const sourceRoot = process.env.COPILOTZ_OXIAN_SOURCE_ROOT;
for (const mode of ["in-process", "websocket"] as const) {
  test(
    `owner resume ${mode}: pending work executes once and canonical terminals replay across a second takeover`,
    { skip: !sourceRoot, timeout: 45000 },
    async () => {
      const { resolveOxianSource } = await import(
        "../../scripts/test-owner-connected.mjs"
      );
      const { createOwnerConnection } = await import("../owner/connection.ts");
      const { encodeOwnerMetadataConstraints } = await import(
        "../owner/metadata-constraints.ts"
      );
      const { createOwnerConnectedWorker } = await import("./owner-worker.ts");
      const { entrypoints } = await resolveOxianSource(sourceRoot!);
      const { createHypervisor } = await import(entrypoints["./hypervisor"]);
      const { createWorker } = await import(entrypoints["./worker"]);
      const { serve } = await import(entrypoints["./adapters/node"]);
      const db = await createTestDatabase({
        pgliteMemoryProfile: "low-memory",
      });
      let executions = 0;
      const app = createPluginRegistry({
        actions: {
          work: defineAction({
            id: "work",
            inputSchema: { type: "string" } as const,
            outputSchema: { type: "string" } as const,
            execute(value: string) {
              executions++;
              return `done:${value}`;
            },
          }),
        },
      });
      const closers: (() => Promise<void>)[] = [];
      async function start(epoch: number, execute: boolean) {
        const local = {
          type: "in-process" as const,
          config: { topic: crypto.randomUUID() },
        };
        const host = await createOwnerHost(options(db, {
          registry: app,
          holderId: `holder:${epoch + 1}`,
          initialization: epoch === 0
            ? "fresh"
            : { mode: "resume", expectedEpoch: epoch },
          maxActive: 1,
          maxPending: 16,

          policy: {
            ...options(db).policy,
            ingress: (_tx, context) =>
              context.fence.identity.workerId === "ingress"
                ? {
                  namespace: "space",
                  principalKey: "api",
                  principal: { kind: "developer", actorId: "api" },
                  route: { kind: "wrapper", id: "fixture" },
                  allowedActions: ["work"],
                  actionMetadata: {},
                  operationMetadata: {},
                  metadataConstraints: encodeOwnerMetadataConstraints({
                    actorId: "api",
                    httpAdmissionKey: "group",
                  }),
                  group: { key: "group", actorId: "api" },
                }
                : undefined,
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
                expiresAtMs: Date.now() + 60000,
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
        const config = (id: string) => ({
          id,
          transport: url
            ? {
              type: "websocket",
              config: { url, allowInsecureLoopback: true },
            }
            : local,
          capacity: 1,
          hostCalls: { maxConcurrent: 8, timeoutMs: 10000 },
          activate: () => ({
            workerId: id,
            attemptId: crypto.randomUUID(),
            epoch: 1,
          }),
          register: () => ({
            credential: { kind: "registration", capability: "fixture" },
            expiresAtMs: Date.now() + 60000,
          }),
          reconnectDelay: false,
        });
        const ingress = createWorker({
          ...config("ingress"),
          workloads: { unused: () => new Uint8Array() },
        });
        const worker = execute
          ? createOwnerConnectedWorker({
            registry: app,
            ownerId: "owner",
            namespace: "space",
            worker: config("action") as never,
            createCapabilities: () => ({ resources: {}, adapters: {} }),
          }, createWorker)
          : undefined;
        let closed = false;
        const close = async () => {
          if (closed) return;
          closed = true;
          await ingress.stop("done");
          await worker?.close("done");
          await within(host.close());
          await listener?.shutdown();
        };
        closers.push(close);
        await within(Promise.all([ingress.ready, worker?.ready]));
        assert.equal(host.snapshot().ready, true);
        assert.equal(host.snapshot().epoch, epoch + 1);
        return {
          host,
          close,
          connection: createOwnerConnection({
            ownerId: "owner",
            callHost: ingress.callHost,
          }),
        };
      }
      try {
        const first = await start(0, false);
        const request = {
          actionAlias: "work",
          input: "pending",
          operationKey: "stable",
        };
        const admitted = await first.connection.callAction(request);
        assert.equal(executions, 0);
        assert.deepEqual(
          (await db.query("SELECT status,attempts FROM event_deliveries")).rows,
          [{ status: "pending", attempts: 0 }],
        );
        await first.close();
        const second = await start(1, true);
        const replay = await second.connection.callAction(request);
        assert.deepEqual(replay.result, admitted.result);
        await eventually(async () =>
          (await second.connection.actionResult(admitted.result) as {
            status: string;
          }).status === "completed"
        );
        assert.deepEqual(
          await second.connection.actionResult(admitted.result),
          { status: "completed", output: "done:pending" },
        );
        await eventually(async () =>
          (await db.query(
              "SELECT 1 FROM copilotz_operations WHERE state NOT IN ('completed','failed','cancelled')",
            )).rows.length === 0 && second.host.snapshot().active === 0
        );
        assert.equal(executions, 1);
        await second.close();
        const third = await start(2, false);
        assert.deepEqual(
          (await third.connection.callAction(request)).result,
          admitted.result,
        );
        assert.deepEqual(await third.connection.actionResult(admitted.result), {
          status: "completed",
          output: "done:pending",
        });
        assert.equal(executions, 1);
        assert.equal(
          (await db.query(
            "SELECT 1 FROM owner_receipts WHERE kind='execution.claim'",
          )).rows.length,
          1,
        );
        assert.equal(
          (await db.query("SELECT 1 FROM owner_alarms")).rows.length,
          0,
        );
      } finally {
        for (const close of closers.reverse()) await close();
        await db.close();
      }
    },
  );
}

test("owner resume stops on unknown acquisition, repair and final proof commits without publishing readiness", async () => {
  const db = await createTestDatabase({ pgliteMemoryProfile: "low-memory" });
  try {
    for (const stage of ["acquire", "repair", "proof"] as const) {
      const schema = `unknown_${stage}`;
      const host = await createOwnerHost(options(db, { schema }));
      await host.close();
      let constructed = 0, shutdowns = 0, fired = false;
      const session: SqlSession = {
        query: db.query,
        async transaction(run) {
          let selected = false;
          const result = await db.transaction((tx) =>
            run({
              async query(sql, params) {
                if (
                  (stage === "acquire" && sql.includes("SET epoch=epoch+1")) ||
                  (stage === "repair" && sql.startsWith("INSERT INTO") &&
                    sql.includes("owner_receipts") &&
                    params?.includes("startup.repair")) ||
                  (stage === "proof" && constructed === 1 &&
                    sql.startsWith("SELECT count(*)::int AS count,COALESCE"))
                ) selected = true;
                return await tx.query(sql, params);
              },
            })
          );
          if (selected && !fired) {
            fired = true;
            throw new Error(`fixture lost ${stage} COMMIT reply`);
          }
          return result;
        },
      };
      await assert.rejects(
        createOwnerHost(options(session, {
          schema,
          holderId: "second",
          initialization: { mode: "resume", expectedEpoch: 1 },
          createTransport() {
            constructed++;
            return {
              prepare() {},
              snapshot: () => ({}),
              shutdown() {
                shutdowns++;
                return Promise.reject(new Error("fixture cleanup rejection"));
              },
            } as never;
          },
        })),
        (error: unknown) => {
          assert.match(String((error as Error).message), /unknown|commit/i);
          assert.doesNotMatch(
            String((error as Error).message),
            /cleanup rejection/,
          );
          return true;
        },
      );
      assert.equal(fired, true, stage);
      assert.equal(constructed, stage === "proof" ? 1 : 0);
      assert.equal(shutdowns, constructed);
      assert.equal(
        Number(
          (await db.query(`SELECT epoch FROM "${schema}".owner_epochs`)).rows[0]
            .epoch,
        ),
        2,
      );
    }
  } finally {
    await db.close();
  }
});

test("actual owner host refuses complete legacy formats before transport or epoch mutation", async () => {
  for (
    const initialization of ["fresh", {
      mode: "resume",
      expectedEpoch: 1,
    }] as const
  ) {
    const db = await createTestDatabase({ pgliteMemoryProfile: "low-memory" });
    try {
      await provisionCopilotzSchema(db, "public");
      await provisionOperationCatalog(db, "public");
      await provisionOwnerCommandSchema(db, "public");
      await provisionOwnerAssignments(db, "public");
      await db.query(
        "INSERT INTO owner_epochs(owner,epoch,holder) VALUES('owner',1,'legacy')",
      );
      const before = (await db.query("SELECT * FROM owner_epochs")).rows;
      let transport = 0;
      await assert.rejects(
        createOwnerHost(options(db, {
          initialization,
          createTransport() {
            transport++;
            throw new Error("unexpected transport");
          },
        })),
        /catalog|format/i,
      );
      assert.equal(transport, 0);
      assert.deepEqual(
        (await db.query("SELECT * FROM owner_epochs")).rows,
        before,
      );
      assert.equal(
        (await db.query(
          "SELECT fingerprint FROM copilotz_operation_catalog_metadata",
        )).rows[0].fingerprint,
        "action-obligations-v1",
      );
    } finally {
      await db.close();
    }
  }
});

test("actual owner resume retains hidden active and revoked stream blockers without serving", async () => {
  for (const revocation of ["active", "revoked"] as const) {
    const db = await createTestDatabase({ pgliteMemoryProfile: "low-memory" });
    let first: Awaited<ReturnType<typeof createOwnerHost>> | undefined;
    try {
      first = await createOwnerHost(options(db));
      await first.close();
      first = undefined;
      await insertTestOwnerStream(db, {
        namespace: "space",
        operationId: "retained-operation",
      }, { revocation });
      const before =
        (await db.query("SELECT * FROM copilotz_operation_streams")).rows;
      let transport = 0;
      await assert.rejects(
        createOwnerHost(
          options(db, {
            holderId: "second",
            initialization: { mode: "resume", expectedEpoch: 1 },
            createTransport() {
              transport++;
              throw new Error("unexpected transport");
            },
          }),
        ),
        /startup|unresolved|unsupported|blocked/i,
      );
      assert.equal(transport, 0);
      assert.deepEqual(
        (await db.query("SELECT * FROM copilotz_operation_streams")).rows,
        before,
      );
      assert.ok(
        (await db.query(
          "SELECT 1 FROM owner_alarms WHERE name LIKE '%reconciliation%'",
        )).rows.length,
      );
    } finally {
      await first?.close();
      await db.close();
    }
  }
});

test("owner fresh setup rolls every provisioning stage back as one unit", async () => {
  for (const stage of ["core", "catalog", "owner", "assignments"] as const) {
    const db = await createTestDatabase({ pgliteMemoryProfile: "low-memory" });
    let host: Awaited<ReturnType<typeof createOwnerHost>> | undefined;
    let injected = false, transports = 0;
    const inventory = () =>
      db.query(
        "SELECT c.relname,c.relkind::text FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' ORDER BY c.relname",
      );
    const session: SqlSession = {
      query: db.query,
      transaction: (run) =>
        db.transaction(async (tx) => {
          const result = await run({
            async query<
              TRow extends Record<string, unknown> = Record<string, unknown>,
            >(sql: string, params?: unknown[]) {
              const value = await tx.query<TRow>(sql, params);
              const hit = stage === "core"
                ? sql.startsWith("INSERT INTO") &&
                  sql.includes('"copilotz_schema_metadata"')
                : stage === "catalog"
                ? sql.startsWith("INSERT INTO") &&
                  sql.includes('"copilotz_operation_catalog_metadata"')
                : stage === "owner"
                ? sql.includes("SELECT 1 FROM information_schema.tables") &&
                  sql.includes("table_name='owner_assignments'")
                : sql.includes("CREATE INDEX") &&
                  sql.includes("owner_assignments_delivery_history");
              if (!injected && hit) {
                injected = true;
                throw new Error(`injected setup ${stage}`);
              }
              return value;
            },
          });
          return result;
        }),
    };
    try {
      const before = (await inventory()).rows;
      await assert.rejects(
        createOwnerHost(options(session, {
          createTransport() {
            transports++;
            throw new Error("unexpected transport");
          },
        })),
        new RegExp(`injected setup ${stage}`),
      );
      assert.equal(injected, true);
      assert.equal(transports, 0);
      assert.deepEqual((await inventory()).rows, before);
      host = await createOwnerHost(options(db));
      assert.equal(host.snapshot().ready, true);
    } finally {
      await host?.close();
      await db.close();
    }
  }
});

test("owner fresh retry validates committed setup after lost acknowledgement without reprovisioning", async () => {
  const db = await createTestDatabase({ pgliteMemoryProfile: "low-memory" });
  let host: Awaited<ReturnType<typeof createOwnerHost>> | undefined;
  let injected = false, transports = 0;
  const session: SqlSession = {
    query: db.query,
    transaction: async (run) => {
      let setup = false;
      const result = await db.transaction((tx) =>
        run({
          async query<
            TRow extends Record<string, unknown> = Record<string, unknown>,
          >(sql: string, params?: unknown[]) {
            const value = await tx.query<TRow>(sql, params);
            if (
              sql.startsWith("INSERT INTO") &&
              sql.includes('"copilotz_operation_catalog_metadata"')
            ) setup = true;
            return value;
          },
        })
      );
      if (setup && !injected) {
        injected = true;
        throw new Error("lost setup COMMIT acknowledgement");
      }
      return result;
    },
  };
  try {
    await assert.rejects(
      createOwnerHost(options(session, {
        createTransport() {
          transports++;
          throw new Error("unexpected transport");
        },
      })),
      /lost setup COMMIT/,
    );
    assert.equal(injected, true);
    assert.equal(transports, 0);
    assert.equal((await db.query("SELECT * FROM owner_epochs")).rows.length, 0);
    let ddl = 0;
    const retry: SqlSession = {
      query: db.query,
      transaction: (run) =>
        db.transaction((tx) =>
          run({
            query: (sql, params) => {
              if (/^\s*(CREATE|ALTER|DROP)\b/.test(sql)) ddl++;
              return tx.query(sql, params);
            },
          })
        ),
    };
    // No declared Collection indexes here: this proves schema re-entry itself is validation-only.
    const empty = createPluginRegistry({ actions: {} });
    host = await createOwnerHost(options(retry, { registry: empty }));
    assert.equal(host.snapshot().ready, true);
    assert.equal(ddl, 0);
    assert.equal(
      Number((await db.query("SELECT epoch FROM owner_epochs")).rows[0].epoch),
      1,
    );
  } finally {
    await host?.close();
    await db.close();
  }
});

test("concurrent fresh owner hosts admit at most one epoch and transport", async () => {
  const db = await createTestDatabase({ pgliteMemoryProfile: "low-memory" });
  const hosts: Awaited<ReturnType<typeof createOwnerHost>>[] = [];
  let transports = 0;
  try {
    const base = options(db);
    const results = await Promise.allSettled(
      ["one", "two"].map((holderId) =>
        createOwnerHost({
          ...base,
          holderId,
          createTransport(config, lifecycle) {
            transports++;
            return base.createTransport(config, lifecycle);
          },
        })
      ),
    );
    for (const result of results) {
      if (result.status === "fulfilled") hosts.push(result.value);
    }
    assert.equal(hosts.length, 1);
    assert.equal(transports, 1);
    assert.equal((await db.query("SELECT * FROM owner_epochs")).rows.length, 1);
    assert.equal(
      Number((await db.query("SELECT epoch FROM owner_epochs")).rows[0].epoch),
      1,
    );
  } finally {
    await Promise.all(hosts.map((host) => host.close()));
    await db.close();
  }
});

test("owner catalog reopen refuses physical coexistence and incomplete setup without repair", async () => {
  for (
    const damage of [
      "content_bodies",
      "content_body_parts",
      "missing-marker",
      "missing-assignments",
    ] as const
  ) {
    const db = await createTestDatabase({ pgliteMemoryProfile: "low-memory" });
    let first: Awaited<ReturnType<typeof createOwnerHost>> | undefined;
    try {
      first = await createOwnerHost(options(db));
      await first.close();
      first = undefined;
      if (damage === "missing-marker") {
        await db.query("DELETE FROM copilotz_operation_catalog_metadata");
      } else if (damage === "missing-assignments") {
        await db.query("DROP TABLE owner_assignments");
      } else {
        await db.query(`CREATE TABLE ${damage}(id TEXT)`);
        await db.query(`INSERT INTO ${damage} VALUES('retained')`);
      }
      const before = (await db.query(
        "SELECT c.relname,c.relkind::text FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' ORDER BY c.relname",
      )).rows;
      const epoch = (await db.query("SELECT * FROM owner_epochs")).rows;
      let ddl = 0, transports = 0;
      const session: SqlSession = {
        query: db.query,
        transaction: (run) =>
          db.transaction((tx) =>
            run({
              query: (sql, params) => {
                if (/^\s*(CREATE|ALTER|DROP)\b/.test(sql)) ddl++;
                return tx.query(sql, params);
              },
            })
          ),
      };
      for (
        const initialization of ["fresh", {
          mode: "resume",
          expectedEpoch: 1,
        }] as const
      ) {
        await assert.rejects(
          createOwnerHost(options(session, {
            initialization,
            createTransport() {
              transports++;
              throw new Error("unexpected transport");
            },
          })),
          /catalog|schema|assignment/i,
        );
      }
      assert.equal(ddl, 0);
      assert.equal(transports, 0);
      assert.deepEqual(
        (await db.query(
          "SELECT c.relname,c.relkind::text FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' ORDER BY c.relname",
        )).rows,
        before,
      );
      assert.deepEqual(
        (await db.query("SELECT * FROM owner_epochs")).rows,
        epoch,
      );
      if (damage === "missing-marker") {
        assert.equal(
          (await db.query("SELECT * FROM copilotz_operation_catalog_metadata"))
            .rows.length,
          0,
        );
      } else if (damage !== "missing-assignments") {
        assert.deepEqual((await db.query(`SELECT * FROM ${damage}`)).rows, [{
          id: "retained",
        }]);
      }
    } finally {
      await first?.close();
      await db.close();
    }
  }
});
