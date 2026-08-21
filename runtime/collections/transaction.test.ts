import { assert, assertEquals, assertRejects } from "@std/assert";

import {
  type BoundCollection,
  type CollectionRecord,
  createCollectionRuntime,
  defineCollection,
  isCollectionNoop,
  relation,
} from "./index.ts";
import { createTestDatabase, type TestDatabase } from "../testing/ominipg.ts";
import {
  createCoreSchemaStatements,
  createEventCoordinator,
  createEventStore,
  createSqlSession,
  type EventCoordinator,
  type EventStore,
  type SqlSession,
} from "../events/index.ts";
import {
  createDeliveryExecutor,
  type DeliveryExecutor,
} from "../execution/index.ts";
import {
  createPluginRegistry,
  definePlugin,
  defineProcessor,
} from "../plugins/index.ts";

const NOW = "2026-08-17T22:00:00.000Z";
const POSTGRES_URL = Deno.env.get("COPILOTZ_TEST_POSTGRES_URL")?.trim();

const jobDefinition = defineCollection({
  name: "job",
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      id: { type: "string" },
      namespace: { type: "string" },
      status: { type: "string" },
      claimedBy: { type: "string" },
      externalId: { type: "string" },
      title: { type: "string" },
      createdAt: { type: "string" },
      updatedAt: { type: "string" },
    },
    required: [
      "id",
      "namespace",
      "status",
      "externalId",
      "title",
      "createdAt",
      "updatedAt",
    ],
  } as const,
  defaults: { status: "open" },
  commands: {
    claim: {
      mutate({ current, input }) {
        const claimedBy = String(
          (input as { claimedBy?: unknown } | undefined)?.claimedBy ?? "",
        );
        if (current.status === "claimed" && current.claimedBy === claimedBy) {
          return;
        }
        if (current.status !== "open") throw new Error("job is not claimable");
        return { set: { status: "claimed", claimedBy } };
      },
    },
  },
});

const jobNoteDefinition = defineCollection({
  name: "job_note",
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      id: { type: "string" },
      namespace: { type: "string" },
      jobId: { type: "string" },
      text: { type: "string" },
      createdAt: { type: "string" },
      updatedAt: { type: "string" },
    },
    required: ["id", "namespace", "jobId", "text", "createdAt", "updatedAt"],
  } as const,
  relations: {
    job: relation.belongsTo("job", "jobId", "job_notes"),
  },
});

type Fixture = Readonly<{
  db: TestDatabase;
  session: SqlSession;
  store: EventStore;
  coordinator: EventCoordinator;
  executor: DeliveryExecutor;
  runtime: ReturnType<typeof createCollectionRuntime>;
  jobs: BoundCollection<CollectionRecord>;
  notes: BoundCollection<CollectionRecord>;
  observed: { noteAtJobCreated: CollectionRecord | null };
}>;

async function count(
  session: SqlSession,
  sql: string,
  params: unknown[] = [],
): Promise<number> {
  const result = await session.query<{ n: string | number }>(sql, params);
  return Number(result.rows[0]?.n ?? 0);
}

async function createFixture(url: string, schema: string): Promise<Fixture> {
  const db = await createTestDatabase({ url });
  const session = createSqlSession(db);
  for (const statement of createCoreSchemaStatements(schema)) {
    await session.query(statement);
  }
  const store = createEventStore({ session, schema });
  const observed: Fixture["observed"] = { noteAtJobCreated: null };
  let notes: BoundCollection<CollectionRecord> | undefined;
  const processor = defineProcessor({
    id: "job.created.observe-sibling",
    on: [{ eventType: "job.created" }],
    async handle(event) {
      observed.noteAtJobCreated = await notes!.get("note-a", event.namespace);
    },
  });
  const registry = await createPluginRegistry({
    plugins: [definePlugin({
      id: "test.collection-transaction",
      version: "1.0.0",
      processors: [processor],
    })],
  });
  const executor = createDeliveryExecutor({
    store,
    registry,
    workerId: "collection-transaction-test",
  });
  const coordinator = createEventCoordinator({ store, registry, executor });
  let nextId = 0;
  const runtime = createCollectionRuntime({
    coordinator,
    session,
    eventStore: store,
    createId: () => `scope-${++nextId}`,
    now: () => new Date(NOW),
  });
  const jobs = runtime.bind(jobDefinition);
  notes = runtime.bind(jobNoteDefinition);
  return Object.freeze({
    db,
    session,
    store,
    coordinator,
    executor,
    runtime,
    jobs,
    notes,
    observed,
  });
}

async function closeFixture(fixture: Fixture): Promise<void> {
  await fixture.executor.shutdown();
  await fixture.db.close();
}

async function runSuite(url: string, schema: string): Promise<void> {
  const fixture = await createFixture(url, schema);
  const { runtime, jobs, notes, store, session, observed } = fixture;
  const tables = store.tables;
  try {
    const created = await runtime.transaction({
      operationKey: "job:with-note",
      namespace: "tenant-a",
      async execute({ collections }) {
        const job = await collections.job.create({
          id: "job-a",
          externalId: "ext-a",
          title: "Scoped job",
        }, { namespace: "tenant-a" });
        assertEquals(
          await collections.job.get("job-a", "tenant-a"),
          job.record,
        );
        const noop = await collections.job.update("job-a", {
          set: { title: "Scoped job" },
        }, { namespace: "tenant-a" });
        assertEquals(isCollectionNoop(noop), true);
        const note = await collections.job_note.create({
          id: "note-a",
          jobId: "job-a",
          text: "first note",
        }, { namespace: "tenant-a" });
        return { job, note, noop };
      },
    });
    await Promise.all(created.dispatch.handles.map((handle) => handle.done));

    assertEquals(created.writes.length, 3);
    assertEquals(isCollectionNoop(created.writes[1]), true);
    assertEquals(
      created.writes.filter((write) => !write.noop).map((write) =>
        !write.noop ? write.event.eventType : undefined
      ),
      ["job.created", "job_note.created"],
    );
    assertEquals(
      (await store.listEvents({ namespace: "tenant-a", limit: 100 })).map(
        (event) => event.type,
      ),
      ["job.created", "job_note.created"],
    );
    const mutations = created.writes.filter((write) => !write.noop);
    assertEquals(
      mutations.every((write) =>
        !write.noop &&
        write.settlementScopeId === created.settlementScopeId &&
        write.event.correlationId === created.correlationId
      ),
      true,
    );
    assertEquals(observed.noteAtJobCreated?.id, "note-a");
    assertEquals(await notes.get("note-a", "tenant-a") !== null, true);
    assertEquals(
      await count(
        session,
        `SELECT count(*)::int AS n FROM ${tables.edges} WHERE type = 'job_notes'`,
      ),
      1,
    );
    assertEquals(await runtime.verify(jobDefinition, "tenant-a"), { ok: true });
    assertEquals(await runtime.verify(jobNoteDefinition, "tenant-a"), {
      ok: true,
    });

    const retried = await runtime.transaction({
      operationKey: "job:with-note",
      namespace: "tenant-a",
      async execute({ collections }) {
        await collections.job.create({
          id: "job-a",
          externalId: "ext-a",
          title: "Scoped job",
        }, { namespace: "tenant-a" });
        await collections.job.update("job-a", {
          set: { title: "Scoped job" },
        }, { namespace: "tenant-a" });
        await collections.job_note.create({
          id: "note-a",
          jobId: "job-a",
          text: "first note",
        }, { namespace: "tenant-a" });
        return "ok";
      },
    });
    assertEquals(retried.value, "ok");
    assertEquals(
      retried.writes.filter((write) => !write.noop).every((write) =>
        !write.noop && write.deduplicated
      ),
      true,
    );
    assertEquals(
      (await store.listEvents({ namespace: "tenant-a", limit: 100 })).length,
      2,
    );

    const nested = await runtime.transaction({
      operationKey: "job:nested",
      namespace: "tenant-a",
      async execute({ collections }) {
        await collections.job.create({
          id: "job-nested",
          externalId: "ext-nested",
          title: "Nested parent",
        }, { namespace: "tenant-a" });
        return await runtime.transaction({
          operationKey: "note:nested",
          namespace: "tenant-a",
          execute: ({ collections: inner }) =>
            inner.job_note.create({
              id: "note-nested",
              jobId: "job-nested",
              text: "nested note",
            }, { namespace: "tenant-a" }),
        });
      },
    });
    await Promise.all(nested.dispatch.handles.map((handle) => handle.done));
    assertEquals(
      nested.writes.map((write) => write.noop ? "noop" : write.event.eventType),
      ["job.created", "job_note.created"],
    );
    assertEquals(await notes.get("note-nested", "tenant-a") !== null, true);

    await assertRejects(
      () =>
        runtime.transaction({
          operationKey: "job:other-ns",
          namespace: "tenant-a",
          execute: ({ collections }) =>
            collections.job.create({
              id: "job-b",
              externalId: "ext-b",
              title: "Wrong ns",
            }, { namespace: "tenant-b" }),
        }),
      TypeError,
      "does not match transaction namespace",
    );

    await assertRejects(
      () =>
        runtime.transaction({
          operationKey: "job:upload-fail",
          namespace: "tenant-a",
          async execute({ collections }) {
            await collections.job.create({
              id: "job-fail",
              externalId: "ext-fail",
              title: "Will roll back",
            }, { namespace: "tenant-a" });
            throw new Error("synthetic body upload failure");
          },
        }),
      Error,
      "synthetic body upload failure",
    );
    assertEquals(await jobs.get("job-fail", "tenant-a"), null);
    assertEquals(
      await count(
        session,
        `SELECT count(*)::int AS n FROM ${tables.events} WHERE subject_id = $1`,
        ["job-fail"],
      ),
      0,
    );
    assertEquals(
      await count(
        session,
        `SELECT count(*)::int AS n FROM ${tables.nodes} WHERE id = $1`,
        ["job-fail"],
      ),
      0,
    );

    const claimed = await runtime.transaction({
      operationKey: "job:claim",
      namespace: "tenant-a",
      async execute({ collections }) {
        return await collections.job.mutate("job-a", "claim", {
          claimedBy: "agent-1",
        }, { namespace: "tenant-a" });
      },
    });
    await Promise.all(claimed.dispatch.handles.map((handle) => handle.done));
    assertEquals(isCollectionNoop(claimed.value), false);
    if (!isCollectionNoop(claimed.value)) {
      assertEquals(claimed.value.event.eventType, "job.updated");
      assertEquals(claimed.value.record.status, "claimed");
    }
  } finally {
    await closeFixture(fixture);
  }
}

Deno.test("collection transaction on PGlite", async () => {
  await runSuite(":memory:", "copilotz_collection_tx");
});

Deno.test({
  name: "collection transaction on PostgreSQL",
  ignore: !POSTGRES_URL,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await runSuite(
      POSTGRES_URL!,
      `v3_tx_${crypto.randomUUID().replaceAll("-", "")}`,
    );
  },
});
