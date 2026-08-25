import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";

import {
  type BoundCollection,
  type CollectionRecord,
  createCollectionRuntime,
  defineCollection,
  isCollectionNoop,
  relation,
  resolveCollectionEventBody,
} from "./index.ts";
import { createTestDatabase, type TestDatabase } from "../testing/ominipg.ts";
import { createTestProcessorContext } from "../testing/processor-context.ts";
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

const SECRET = "body-must-not-be-in-event";
const NOW = "2026-08-17T21:00:00.000Z";
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
      availableAt: { type: "string" },
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
  search: { enabled: true, fields: ["title"] },
  relations: {
    notes: relation.hasMany("job_note", "jobId", "job_notes"),
  },
  beforeCreate(data) {
    return {
      ...data,
      title: typeof data.title === "string" ? data.title.trim() : data.title,
    };
  },
  beforeUpdate(data) {
    return {
      ...data,
      title: typeof data.title === "string" ? data.title.trim() : data.title,
    };
  },
  commands: {
    claim: {
      input: {
        type: "object",
        additionalProperties: false,
        properties: { claimedBy: { type: "string" } },
        required: ["claimedBy"],
      },
      mutate({ current, input }) {
        assert(Object.isFrozen(current));
        const claimedBy = String(
          (input as { claimedBy?: unknown } | undefined)?.claimedBy ?? "",
        );
        if (current.status === "claimed" && current.claimedBy === claimedBy) {
          return;
        }
        if (current.status !== "open") {
          throw new Error("job is not claimable");
        }
        return { set: { status: "claimed", claimedBy } };
      },
    },
    prioritize: {
      event: "job.prioritized",
      input: {
        type: "object",
        additionalProperties: false,
        properties: { availableAt: { type: "string" } },
        required: ["availableAt"],
      },
      mutate({ input }) {
        const availableAt = String(
          (input as { availableAt?: unknown } | undefined)?.availableAt ?? "",
        );
        return { set: { availableAt } };
      },
    },
  },
  queries: {
    byExternalId: {
      filter({ input }) {
        return { externalId: input.externalId };
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
    required: [
      "id",
      "namespace",
      "jobId",
      "text",
      "createdAt",
      "updatedAt",
    ],
  } as const,
  relations: {
    job: relation.belongsTo("job", "jobId", "job_notes"),
  },
});

const projectionScaleDefinition = defineCollection({
  name: "projection_scale",
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      id: { type: "string" },
      namespace: { type: "string" },
      sequence: { type: "integer" },
      createdAt: { type: "string" },
      updatedAt: { type: "string" },
    },
    required: [
      "id",
      "namespace",
      "sequence",
      "createdAt",
      "updatedAt",
    ],
  } as const,
});

const timestampOrderDefinition = defineCollection({
  name: "timestamp_order",
  timestamps: { createdAt: "createdOn", updatedAt: "changedOn" },
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      id: { type: "string" },
      namespace: { type: "string" },
      label: { type: "string" },
      createdOn: { type: "string" },
      changedOn: { type: "string" },
    },
    required: [
      "id",
      "namespace",
      "label",
      "createdOn",
      "changedOn",
    ],
  } as const,
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
}>;

async function count(
  session: SqlSession,
  sql: string,
  params: unknown[] = [],
): Promise<number> {
  const result = await session.query<{ n: string | number }>(sql, params);
  return Number(result.rows[0]?.n ?? 0);
}

async function settle(
  write: {
    noop?: boolean;
    dispatch?: { handles: readonly { done: Promise<unknown> }[] };
  },
): Promise<void> {
  if (write.noop) return;
  await Promise.all(
    (write.dispatch?.handles ?? []).map((handle) => handle.done),
  );
}

async function createFixture(
  url: string,
  schema: string,
  now: () => Date = () => new Date(NOW),
): Promise<Fixture> {
  const db = await createTestDatabase({ url });
  const session = createSqlSession(db);
  for (const statement of createCoreSchemaStatements(schema)) {
    await session.query(statement);
  }
  const store = createEventStore({ session, schema });
  const processor = defineProcessor({
    id: "job.audit",
    on: [
      { eventType: "job.created" },
      { eventType: "job.updated" },
      { eventType: "job.deleted" },
      { eventType: "job_note.created" },
      { eventType: "job_note.updated" },
      { eventType: "job_note.deleted" },
    ],
    handle: () => undefined,
  });
  const registry = await createPluginRegistry({
    plugins: [definePlugin({
      id: "test.collection-kernel",
      version: "1.0.0",
      processors: { observeJobs: processor },
    })],
  });
  const executor = createDeliveryExecutor({
    store,
    registry,
    createContext: createTestProcessorContext,
    workerId: "collection-kernel-test",
  });
  const coordinator = createEventCoordinator({ store, registry, executor });
  let nextId = 0;
  const runtime = createCollectionRuntime({
    coordinator,
    session,
    eventStore: store,
    createId: () => `kernel-${++nextId}`,
    now,
  });
  return Object.freeze({
    db,
    session,
    store,
    coordinator,
    executor,
    runtime,
    jobs: runtime.bind(jobDefinition),
    notes: runtime.bind(jobNoteDefinition),
  }) as Fixture;
}

async function closeFixture(fixture: Fixture): Promise<void> {
  await fixture.executor.shutdown();
  await fixture.db.close();
}

Deno.test("defineCollection rejects names that cannot form events", () => {
  assertThrows(
    () =>
      defineCollection({
        name: "1job",
        schema: { type: "object", properties: {} },
      }),
    TypeError,
  );
  assertThrows(
    () =>
      defineCollection({
        name: "job",
        schema: { type: "object", properties: {} },
        commands: {
          create: {
            mutate: () => ({ set: {} }),
          },
        },
      }),
    TypeError,
    "collides with a kernel method",
  );
});

Deno.test("named queries validate schemas for direct invocation", async () => {
  const fixture = await createFixture(
    ":memory:",
    "copilotz_named_query_schemas",
  );
  let strictCalls = 0;
  const definition = defineCollection({
    name: "named_query_schema",
    schema: { type: "object", properties: {} },
    queries: {
      strict: {
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: { value: { type: "string" } },
          required: ["value"],
        },
        outputSchema: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: { value: { type: "string" } },
            required: ["value"],
          },
        },
        select({ input }) {
          strictCalls++;
          return [{ value: input.value }];
        },
      },
      invalidOutput: {
        outputSchema: {
          type: "array",
          items: {
            type: "object",
            required: ["value"],
            properties: { value: { type: "string" } },
          },
        },
        select: () => [{ other: true }],
      },
      legacy: {
        select: ({ input }) => [{ value: input.value }],
      },
    },
  });
  const queries = fixture.runtime.bind(definition).query;
  try {
    await assertRejects(
      () => queries.strict("tenant-a", {}),
      TypeError,
      "named_query_schema.strict input failed schema validation",
    );
    assertEquals(strictCalls, 0);

    assertEquals(
      await queries.strict("tenant-a", { value: "valid" }),
      [{ value: "valid" }] as never,
    );
    assertEquals(strictCalls, 1);

    await assertRejects(
      () => queries.invalidOutput("tenant-a"),
      TypeError,
      "named_query_schema.invalidOutput output failed schema validation",
    );
    assertEquals(
      await queries.legacy("tenant-a", { value: 42 }),
      [{ value: 42 }] as never,
    );
  } finally {
    await closeFixture(fixture);
  }
});

async function runKernelSuite(url: string, schema: string): Promise<void> {
  const fixture = await createFixture(url, schema);
  const { jobs, notes, store, session, runtime } = fixture;
  const tables = store.tables;
  try {
    await assertRejects(
      () =>
        jobs.create(
          { id: "job-invalid", externalId: "missing-title" } as never,
          {
            namespace: "tenant-a",
          },
        ),
      TypeError,
      "lossless JSON",
    );

    const created = await jobs.create({
      id: "job-a",
      externalId: "ext-a",
      title: `  ${SECRET}  `,
    }, {
      namespace: "tenant-a",
      identity: { deduplicationId: "job-a:create" },
    });
    await settle(created);
    assertEquals(created.event.eventType, "job.created");
    assertEquals(created.record.title, SECRET);
    assertEquals(created.record.status, "open");
    assertEquals(created.record.namespace, "tenant-a");
    assertEquals(created.record.createdAt, NOW);
    assertEquals(created.deduplicated, false);
    assertEquals(created.deliveries.length, 1);

    const storedEvent = await store.getEvent(created.event.id);
    assert(storedEvent);
    assertEquals(storedEvent.type, "job.created");
    assertEquals(
      Object.keys(storedEvent.payload as Record<string, unknown>).sort(),
      ["dataRef"],
    );
    assert(!JSON.stringify(storedEvent).includes(SECRET));
    assertEquals(
      created.event.dataRef.eventBodyId,
      (storedEvent.payload as {
        dataRef: { eventBodyId: string };
      }).dataRef.eventBodyId,
    );

    const body = await resolveCollectionEventBody(
      session,
      store,
      created.event,
    );
    assertEquals(body.operation, "create");
    if (body.operation === "create") {
      assertEquals(body.record.title, SECRET);
    }

    assertEquals(
      await count(
        session,
        `SELECT count(*)::int AS n FROM ${tables.events} WHERE type = 'asset.created'`,
      ),
      0,
    );
    assertEquals(
      await count(
        session,
        `SELECT count(*)::int AS n FROM ${tables.nodes} WHERE type = 'asset' AND namespace = $1`,
        ["tenant-a"],
      ),
      0,
    );
    assertEquals(
      await count(
        session,
        `SELECT count(*)::int AS n FROM ${tables.event_bodies} WHERE namespace = $1`,
        ["tenant-a"],
      ),
      1,
    );
    assertEquals(
      await count(
        session,
        `SELECT count(*)::int AS n FROM ${tables.nodes} WHERE type = 'job' AND namespace = $1`,
        ["tenant-a"],
      ),
      1,
    );

    const replayed = await jobs.create({
      id: "job-a",
      externalId: "ext-a",
      title: `  ${SECRET}  `,
    }, {
      namespace: "tenant-a",
      identity: { deduplicationId: "job-a:create" },
    });
    await settle(replayed);
    assertEquals(replayed.deduplicated, true);
    assertEquals(replayed.record.id, "job-a");
    assertEquals(
      await count(
        session,
        `SELECT count(*)::int AS n FROM ${tables.events} WHERE namespace = $1`,
        ["tenant-a"],
      ),
      1,
    );

    const byExternal = await jobs.query.byExternalId("tenant-a", {
      externalId: "ext-a",
    });
    assertEquals(byExternal.map((row) => row.id), ["job-a"]);

    const updated = await jobs.update("job-a", {
      set: { title: "Priority inbox" },
    }, { namespace: "tenant-a" });
    await settle(updated);
    assertEquals(isCollectionNoop(updated), false);
    if (!isCollectionNoop(updated)) {
      assertEquals(updated.event.eventType, "job.updated");
      assertEquals(updated.record.title, "Priority inbox");
    }

    const noopUpdate = await jobs.update("job-a", {
      set: { title: "Priority inbox" },
    }, { namespace: "tenant-a" });
    assertEquals(isCollectionNoop(noopUpdate), true);
    assertEquals(
      await count(
        session,
        `SELECT count(*)::int AS n FROM ${tables.events} WHERE namespace = $1 AND type = 'job.updated'`,
        ["tenant-a"],
      ),
      1,
    );

    const claimed = await jobs.mutate("job-a", "claim", {
      claimedBy: "agent-1",
    }, {
      namespace: "tenant-a",
    });
    await settle(claimed);
    assertEquals(isCollectionNoop(claimed), false);
    if (!isCollectionNoop(claimed)) {
      assertEquals(claimed.event.eventType, "job.updated");
      assertEquals(claimed.record.status, "claimed");
      assertEquals(claimed.record.claimedBy, "agent-1");
    }
    const eventTypes = (await store.listEvents({
      namespace: "tenant-a",
      limit: 100,
    })).map((event) => event.type);
    assertEquals(eventTypes.includes("job.claimed"), false);
    assertEquals(eventTypes.filter((type) => type === "job.updated").length, 2);

    const noopClaim = await jobs.mutate("job-a", "claim", {
      claimedBy: "agent-1",
    }, { namespace: "tenant-a" });
    assertEquals(isCollectionNoop(noopClaim), true);

    const prioritized = await jobs.mutate("job-a", "prioritize", {
      availableAt: "2026-08-18T00:00:00.000Z",
    }, { namespace: "tenant-a" });
    await settle(prioritized);
    assertEquals(isCollectionNoop(prioritized), false);
    if (!isCollectionNoop(prioritized)) {
      assertEquals(prioritized.event.eventType, "job.prioritized");
      assertEquals(
        prioritized.record.availableAt,
        "2026-08-18T00:00:00.000Z",
      );
    }
    assertEquals(
      (await store.listEvents({ namespace: "tenant-a", limit: 100 }))
        .filter((event) => event.type === "job.updated").length,
      2,
    );

    await assertRejects(
      () =>
        jobs.mutate("job-a", "claim", { claimedBy: "agent-2" }, {
          namespace: "tenant-a",
        }),
      Error,
      "not claimable",
    );

    const note = await notes.create({
      id: "note-a",
      jobId: "job-a",
      text: "first note",
    }, { namespace: "tenant-a" });
    await settle(note);
    assertEquals(note.event.eventType, "job_note.created");
    assertEquals(
      await count(
        session,
        `SELECT count(*)::int AS n FROM ${tables.edges} WHERE namespace = $1 AND type = 'job_notes'`,
        ["tenant-a"],
      ),
      1,
    );
    const relations = await runtime.withScope({ namespace: "tenant-a" }).job
      .relations.list({
        id: "job-a",
        direction: "out",
        types: ["job_notes"],
      });
    assertEquals(relations.length, 1);
    const { createdAt, ...relation } = relations[0];
    assertEquals(relation, {
      id: 'relation:["tenant-a","job_notes","job-a","note-a"]',
      namespace: "tenant-a",
      type: "job_notes",
      source: { type: "job", id: "job-a" },
      target: { type: "job_note", id: "note-a" },
      metadata: {},
      weight: 1,
    });
    assert(Number.isFinite(new Date(createdAt).getTime()));

    const withNotes = await jobs.query("tenant-a", {
      where: { id: "job-a" },
      include: ["notes"],
    });
    assertEquals(
      (withNotes[0].notes as readonly CollectionRecord[]).map((row) => row.id),
      ["note-a"],
    );
    const withJob = await notes.query("tenant-a", {
      where: { id: "note-a" },
      include: ["job"],
    });
    assertEquals((withJob[0].job as CollectionRecord).id, "job-a");

    await assertRejects(
      () =>
        notes.create({
          id: "note-missing",
          jobId: "missing-job",
          text: "should roll back",
        }, { namespace: "tenant-a" }),
      Error,
      "missing job",
    );
    assertEquals(await notes.get("note-missing", "tenant-a"), null);
    assertEquals(
      await store.getEventByDeduplicationId("tenant-a", "note-missing:create"),
      null,
    );
    assertEquals(
      await count(
        session,
        `SELECT count(*)::int AS n FROM ${tables.nodes} WHERE id = $1`,
        ["note-missing"],
      ),
      0,
    );

    const other = await jobs.create({
      id: "job-b",
      externalId: "ext-b",
      title: "Other tenant",
    }, { namespace: "tenant-b" });
    await settle(other);
    assertEquals((await jobs.list("tenant-a")).map((row) => row.id), ["job-a"]);
    assertEquals((await jobs.list("tenant-b")).map((row) => row.id), ["job-b"]);
    assertEquals(
      (await store.listEvents({ namespace: "tenant-a", limit: 100 }))
        .every((event) => event.namespace === "tenant-a"),
      true,
    );

    const found = await jobs.search("tenant-a", { text: "Priority" });
    assertEquals(found.map((row) => row.id), ["job-a"]);

    assertEquals(await runtime.verify(jobDefinition, "tenant-a"), { ok: true });
    await session.query(
      `UPDATE ${tables.nodes}
       SET data = jsonb_set(data, '{title}', '"tampered"')
       WHERE id = $1 AND type = 'job'`,
      ["job-a"],
    );
    const tampered = await runtime.verify(jobDefinition, "tenant-a");
    assertEquals(tampered.ok, false);
    await runtime.rebuild("tenant-a");
    assertEquals(await runtime.verify(jobDefinition, "tenant-a"), { ok: true });
    assertEquals(
      (await jobs.get("job-a", "tenant-a"))?.title,
      "Priority inbox",
    );
    assertEquals(await runtime.verify(jobNoteDefinition, "tenant-a"), {
      ok: true,
    });
    assertEquals(
      await count(
        session,
        `SELECT count(*)::int AS n FROM ${tables.edges} WHERE namespace = $1 AND type = 'job_notes'`,
        ["tenant-a"],
      ),
      1,
    );

    const deletedNote = await notes.delete("note-a", { namespace: "tenant-a" });
    await settle(deletedNote);
    assertEquals(deletedNote.event.eventType, "job_note.deleted");
    assertEquals(await notes.get("note-a", "tenant-a"), null);
    assertEquals(
      await count(
        session,
        `SELECT count(*)::int AS n FROM ${tables.edges} WHERE namespace = $1 AND type = 'job_notes'`,
        ["tenant-a"],
      ),
      0,
    );

    const deleted = await jobs.delete("job-a", { namespace: "tenant-a" });
    await settle(deleted);
    assertEquals(deleted.event.eventType, "job.deleted");
    assertEquals(await jobs.get("job-a", "tenant-a"), null);
    assertEquals(await runtime.verify(jobDefinition, "tenant-a"), { ok: true });
  } finally {
    await closeFixture(fixture);
  }
}

Deno.test("collection kernel on PGlite", async () => {
  await runKernelSuite(":memory:", "copilotz_collection_kernel");
});

Deno.test("namespace rebuild preserves durable Collection timestamp order", async () => {
  const times = [
    "2026-08-17T21:00:00.000Z",
    "2026-08-17T21:01:00.000Z",
    "2026-08-17T21:02:00.000Z",
    "2026-08-17T21:03:00.000Z",
  ];
  let clock = 0;
  const fixture = await createFixture(
    ":memory:",
    "copilotz_collection_timestamp_rebuild",
    () => new Date(times[Math.min(clock++, times.length - 1)]),
  );
  const records = fixture.runtime.bind(timestampOrderDefinition);
  const namespace = "tenant-timestamp-order";
  const orderedIds = async (field: "createdAt" | "updatedAt") =>
    (await records.list(namespace, {
      order: { field, direction: "asc" },
    })).map((record) => record.id);
  const storedTimes = async () => {
    const result = await fixture.session.query<{
      id: string;
      created_at: string | Date;
      updated_at: string | Date;
    }>(
      `SELECT id, created_at, updated_at
       FROM ${fixture.store.tables.nodes}
       WHERE namespace = $1 AND type = $2
       ORDER BY id`,
      [namespace, timestampOrderDefinition.name],
    );
    return result.rows.map((row) => ({
      id: row.id,
      createdAt: new Date(row.created_at).toISOString(),
      updatedAt: new Date(row.updated_at).toISOString(),
    }));
  };

  try {
    await records.create({ id: "z", label: "Z" }, { namespace });
    await records.create({ id: "a", label: "A" }, { namespace });
    await records.update("z", { set: { label: "Z updated" } }, {
      namespace,
    });
    await records.update("a", { set: { label: "A updated" } }, {
      namespace,
    });

    const expectedTimes = [
      { id: "a", createdAt: times[1], updatedAt: times[3] },
      { id: "z", createdAt: times[0], updatedAt: times[2] },
    ];
    assertEquals(await storedTimes(), expectedTimes);
    assertEquals(await orderedIds("createdAt"), ["z", "a"]);
    assertEquals(await orderedIds("updatedAt"), ["z", "a"]);

    await fixture.runtime.rebuild(namespace);

    assertEquals(await storedTimes(), expectedTimes);
    assertEquals(await orderedIds("createdAt"), ["z", "a"]);
    assertEquals(await orderedIds("updatedAt"), ["z", "a"]);
  } finally {
    await closeFixture(fixture);
  }
});

Deno.test("scoped collection calls own namespace and expose property commands and queries", async () => {
  const fixture = await createFixture(
    ":memory:",
    "copilotz_scoped_collection_calls",
  );
  try {
    const jobs = fixture.runtime.withScope({ namespace: "tenant-scoped" }).job;
    const created = await jobs.create({
      id: "job-scoped",
      externalId: "external-scoped",
      title: "Scoped",
    }, { operationKey: "job:create" });
    assertEquals(created.namespace, "tenant-scoped");

    const updated = await jobs.update({
      id: created.id,
      set: { title: "Updated" },
    });
    assertEquals(updated.title, "Updated");

    const found = await jobs.queries.byExternalId({
      externalId: "external-scoped",
    });
    assertEquals(found.map((record) => record.id), [created.id]);

    const claimed = await jobs.commands.claim({
      id: created.id,
      claimedBy: "agent-scoped",
    });
    assertEquals(claimed.status, "claimed");
    assertEquals(claimed.claimedBy, "agent-scoped");

    assertEquals(
      await fixture.runtime.withScope({ namespace: "tenant-other" }).job.get({
        id: created.id,
      }),
      null,
    );
    assertEquals(await jobs.delete({ id: created.id }), {
      id: created.id,
      deleted: true,
    });
  } finally {
    await closeFixture(fixture);
  }
});

Deno.test("collection verification scans every projection page", async () => {
  const fixture = await createFixture(
    ":memory:",
    "copilotz_collection_projection_pages",
  );
  fixture.runtime.bind(projectionScaleDefinition);
  try {
    await fixture.runtime.transaction({
      operationKey: "projection-scale:create",
      namespace: "tenant-scale",
      async execute({ collections }) {
        for (let sequence = 0; sequence < 1_001; sequence += 1) {
          await collections.projection_scale.create({
            id: `projection-${sequence.toString().padStart(4, "0")}`,
            sequence,
          });
        }
      },
    });

    assertEquals(
      await count(
        fixture.session,
        `SELECT count(*)::int AS n FROM ${fixture.store.tables.nodes}
         WHERE namespace = $1 AND type = $2`,
        ["tenant-scale", "projection_scale"],
      ),
      1_001,
    );
    assertEquals(
      await fixture.runtime.verify(projectionScaleDefinition, "tenant-scale"),
      { ok: true },
    );
  } finally {
    await closeFixture(fixture);
  }
});

Deno.test({
  name: "collection kernel on PostgreSQL",
  ignore: !POSTGRES_URL,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await runKernelSuite(
      POSTGRES_URL!,
      `v3_ck_${crypto.randomUUID().replaceAll("-", "")}`,
    );
  },
});
