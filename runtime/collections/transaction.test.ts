import { assert, assertEquals, assertRejects } from "@std/assert";

import {
  type BoundCollection,
  type CollectionRecord,
  createCollectionRuntime,
  defineCollection,
  relation,
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
    relationNamedEvent: {
      event: "relation.upserted",
      mutate({ input }) {
        return { set: { title: String(input) } };
      },
    },
    assetNamedEvent: {
      event: "asset.created",
      mutate({ input }) {
        return { set: { title: String(input) } };
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
      processors: { observeJob: processor },
    })],
  });
  const executor = createDeliveryExecutor({
    store,
    registry,
    createContext: createTestProcessorContext,
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
        });
        assertEquals("get" in collections.job, false);
        const unchanged = await collections.job.update({
          id: "job-a",
          set: { title: "Scoped job" },
        });
        const note = await collections.job_note.create({
          id: "note-a",
          jobId: "job-a",
          text: "first note",
        });
        return { job, note, unchanged };
      },
    });
    await Promise.all(created.dispatch.handles.map((handle) => handle.done));

    assertEquals(created.writes.length, 3);
    assertEquals(
      created.writes.map((write) =>
        write.noop ? "noop" : write.event.eventType
      ),
      ["job.created", "job.updated", "job_note.created"],
    );
    assertEquals(
      (await store.listEvents({ namespace: "tenant-a", limit: 100 })).map(
        (event) => event.type,
      ),
      ["job.created", "job.updated", "job_note.created"],
    );
    assertEquals(
      created.writes.every((write) =>
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
        });
        await collections.job.update({
          id: "job-a",
          set: { title: "Scoped job" },
        });
        await collections.job_note.create({
          id: "note-a",
          jobId: "job-a",
          text: "first note",
        });
        return "ok";
      },
    });
    assertEquals(retried.value, "ok");
    assertEquals(
      retried.writes.every((write) => !write.noop && write.deduplicated),
      true,
    );
    assertEquals(
      (await store.listEvents({ namespace: "tenant-a", limit: 100 })).length,
      3,
    );

    await assertRejects(
      () =>
        runtime.transaction({
          operationKey: "job:nested",
          namespace: "tenant-a",
          async execute({ collections }) {
            await collections.job.create({
              id: "job-nested",
              externalId: "ext-nested",
              title: "Nested parent",
            });
            await runtime.transaction({
              operationKey: "note:nested",
              namespace: "tenant-a",
              execute: ({ collections: inner }) =>
                inner.job_note.create({
                  id: "note-nested",
                  jobId: "job-nested",
                  text: "nested note",
                }),
            });
          },
        }),
      Error,
      "Nested Collection transactions are not supported",
    );
    assertEquals(await jobs.get("job-nested", "tenant-a"), null);
    assertEquals(await notes.get("note-nested", "tenant-a"), null);

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
            });
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
        return await collections.job.commands.claim({
          id: "job-a",
          claimedBy: "agent-1",
        });
      },
    });
    await Promise.all(claimed.dispatch.handles.map((handle) => handle.done));
    assertEquals(claimed.value, { id: "job-a" });
    assertEquals((await jobs.get("job-a", "tenant-a"))?.status, "claimed");

    const drained = await runtime.transaction({
      operationKey: "job:unawaited",
      namespace: "tenant-a",
      execute({ collections }) {
        void collections.job.create({
          id: "job-unawaited",
          externalId: "ext-unawaited",
          title: "Drained before commit",
        });
        return Promise.resolve("callback-finished");
      },
    });
    assertEquals(drained.value, "callback-finished");
    assertEquals(
      (await jobs.get("job-unawaited", "tenant-a"))?.title,
      "Drained before commit",
    );

    await assertRejects(
      () =>
        runtime.transaction({
          operationKey: "job:caught-plan-failure",
          namespace: "tenant-a",
          async execute({ collections }) {
            try {
              await collections.job.create({
                id: "job-invalid-caught",
                externalId: "ext-invalid-caught",
              });
            } catch {
              // A caught mutation failure still poisons the root plan.
            }
          },
        }),
      TypeError,
      "schema validation",
    );
    assertEquals(await jobs.get("job-invalid-caught", "tenant-a"), null);

    await assertRejects(() =>
      runtime.transaction({
        operationKey: "job:caught-registration-failure",
        namespace: "tenant-a",
        async execute({ collections }) {
          try {
            await collections.job.create({
              id: "job-uncloneable",
              externalId: "ext-uncloneable",
              title: "Uncloneable",
              callback: () => undefined,
            });
          } catch {
            // Snapshot failures are still registered root failures.
          }
          await collections.job.create({
            id: "job-after-uncloneable",
            externalId: "ext-after-uncloneable",
            title: "Must roll back",
          });
        },
      })
    );
    assertEquals(await jobs.get("job-after-uncloneable", "tenant-a"), null);

    await assertRejects(
      () =>
        runtime.transaction({
          operationKey: "job:caught-invalid-id",
          namespace: "tenant-a",
          async execute({ collections }) {
            try {
              await collections.job.update({
                id: " ",
                set: { title: "Invalid" },
              });
            } catch {
              // Required-field failures cannot escape root poisoning.
            }
            await collections.job.create({
              id: "job-after-invalid-id",
              externalId: "ext-after-invalid-id",
              title: "Must roll back",
            });
          },
        }),
      TypeError,
      "job id must be non-empty",
    );
    assertEquals(await jobs.get("job-after-invalid-id", "tenant-a"), null);

    await assertRejects(
      () =>
        runtime.transaction({
          operationKey: "relation:caught-invalid-json",
          namespace: "tenant-a",
          async execute({ collections, relations }) {
            try {
              await relations.upsert({
                id: "relation-invalid-json",
                type: "related_to",
                source: { type: "job", id: "job-a" },
                target: { type: "job", id: "job-unawaited" },
                metadata: { score: Number.POSITIVE_INFINITY },
              });
            } catch {
              // Lossless-JSON failures poison the same root plan.
            }
            await collections.job.create({
              id: "job-after-invalid-relation",
              externalId: "ext-after-invalid-relation",
              title: "Must roll back",
            });
          },
        }),
      TypeError,
      "lossless JSON numbers",
    );
    assertEquals(
      await jobs.get("job-after-invalid-relation", "tenant-a"),
      null,
    );

    let rejectedWithUndefined = false;
    try {
      await runtime.transaction({
        operationKey: "job:undefined-rejection",
        namespace: "tenant-a",
        async execute({ collections }) {
          await collections.job.create({
            id: "job-undefined-rejection",
            externalId: "ext-undefined-rejection",
            title: "Must not commit",
          });
          return await Promise.reject(undefined);
        },
      });
    } catch (error) {
      rejectedWithUndefined = true;
      assertEquals(error, undefined);
    }
    assert(rejectedWithUndefined);
    assertEquals(await jobs.get("job-undefined-rejection", "tenant-a"), null);

    await jobs.create({
      id: "job-parallel",
      externalId: "ext-parallel",
      title: "Initial",
    }, { namespace: "tenant-a" });
    await runtime.transaction({
      operationKey: "job:parallel-updates",
      namespace: "tenant-a",
      async execute({ collections }) {
        await Promise.all([
          collections.job.update({
            id: "job-parallel",
            set: { title: "First" },
          }),
          collections.job.update({
            id: "job-parallel",
            set: { title: "Second" },
          }),
        ]);
      },
    });
    assertEquals((await jobs.get("job-parallel", "tenant-a"))?.title, "Second");

    const mutableInput = {
      id: "job-snapshot",
      externalId: "ext-snapshot",
      title: "Original",
    };
    const mutableOptions = {
      operationKey: "create-snapshot",
      identity: { metadata: { nested: { value: "original" } } },
    };
    await runtime.transaction({
      operationKey: "job:snapshot",
      namespace: "tenant-a",
      async execute({ collections }) {
        const planned = collections.job.create(mutableInput, mutableOptions);
        mutableInput.title = "Mutated after invocation";
        mutableOptions.identity.metadata.nested.value = "mutated";
        await planned;
      },
    });
    assertEquals(
      (await jobs.get("job-snapshot", "tenant-a"))?.title,
      "Original",
    );
    const snapshotEvent = (await store.listEvents({
      namespace: "tenant-a",
      limit: 100,
    })).find((event) => event.subject?.id === "job-snapshot");
    assertEquals(snapshotEvent?.metadata, {
      nested: { value: "original" },
    });

    await jobs.create({
      id: "job-conditional",
      externalId: "ext-conditional",
      title: "Initial",
    }, { namespace: "tenant-a" });
    await runtime.transaction({
      operationKey: "job:conditional-retry",
      namespace: "tenant-a",
      async execute({ collections }) {
        await collections.job.update({
          id: "job-conditional",
          set: { title: "Intermediate" },
        });
        await collections.job.update({
          id: "job-conditional",
          set: { title: "Final" },
        });
      },
    });
    const conditionalRetry = await runtime.transaction({
      operationKey: "job:conditional-retry",
      namespace: "tenant-a",
      execute: ({ collections }) =>
        collections.job.update({
          id: "job-conditional",
          set: { title: "Final" },
        }),
    });
    assertEquals(conditionalRetry.writes.length, 1);
    assert(!conditionalRetry.writes[0].noop);
    assertEquals(conditionalRetry.writes[0].deduplicated, true);
    assertEquals(
      (await jobs.get("job-conditional", "tenant-a"))?.title,
      "Final",
    );

    await jobs.create({
      id: "job-delete-retry",
      externalId: "ext-delete-retry",
      title: "Delete me",
    }, { namespace: "tenant-a" });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const deletion = await runtime.transaction({
        operationKey: "job:delete-retry",
        namespace: "tenant-a",
        execute: ({ collections }) =>
          collections.job.delete({ id: "job-delete-retry" }),
      });
      assert(!deletion.writes[0].noop);
      assertEquals(deletion.writes[0].deduplicated, attempt === 1);
    }
    assertEquals(await jobs.get("job-delete-retry", "tenant-a"), null);

    await jobs.create({
      id: "relation-source",
      externalId: "ext-relation-source",
      title: "Relation source",
    }, { namespace: "tenant-a" });
    await jobs.create({
      id: "relation-target",
      externalId: "ext-relation-target",
      title: "Relation target",
    }, { namespace: "tenant-a" });
    const relationCreate = await runtime.transaction({
      operationKey: "relation:create",
      namespace: "tenant-a",
      execute: ({ relations }) =>
        relations.upsert({
          id: "relation-generic",
          type: "related_to",
          source: { type: "job", id: "relation-source" },
          target: { type: "job", id: "relation-target" },
          metadata: { version: 1 },
        }),
    });
    assertEquals(relationCreate.value, { id: "relation-generic" });

    await runtime.transaction({
      operationKey: "relation:replace-endpoint",
      namespace: "tenant-a",
      async execute({ collections, relations }) {
        await collections.job.delete({ id: "relation-target" });
        await collections.job.create({
          id: "relation-target",
          externalId: "ext-relation-target-recreated",
          title: "Recreated target",
        });
        await relations.upsert({
          id: "relation-generic",
          type: "related_to",
          source: { type: "job", id: "relation-source" },
          target: { type: "job", id: "relation-target" },
          metadata: { version: 2 },
        });
      },
    });
    assertEquals(
      await count(
        session,
        `SELECT count(*)::int AS n FROM ${tables.edges}
         WHERE namespace = $1 AND id = $2`,
        ["tenant-a", "relation-generic"],
      ),
      1,
    );
    await session.query(
      `DELETE FROM ${tables.edges} WHERE namespace = $1 AND id = $2`,
      ["tenant-a", "relation-generic"],
    );
    await runtime.rebuild("tenant-a");
    const rebuiltRelation = await session.query<{ metadata: unknown }>(
      `SELECT data -> 'metadata' AS metadata FROM ${tables.edges}
       WHERE namespace = $1 AND id = $2`,
      ["tenant-a", "relation-generic"],
    );
    assertEquals(rebuiltRelation.rows[0]?.metadata, { version: 2 });

    await assertRejects(
      () =>
        runtime.transaction({
          operationKey: "relation:deleted-endpoint",
          namespace: "tenant-a",
          async execute({ collections, relations }) {
            await collections.job.delete({ id: "relation-target" });
            await relations.upsert({
              id: "relation-after-delete",
              type: "related_to",
              source: { type: "job", id: "relation-source" },
              target: { type: "job", id: "relation-target" },
            });
          },
        }),
      Error,
      "was deleted in this transaction",
    );
    assert(await jobs.get("relation-target", "tenant-a"));

    await jobs.delete("relation-target", { namespace: "tenant-a" });
    await jobs.create({
      id: "relation-target",
      externalId: "ext-relation-target-third",
      title: "Third target lifecycle",
    }, { namespace: "tenant-a" });
    await runtime.rebuild("tenant-a");
    assertEquals(
      await count(
        session,
        `SELECT count(*)::int AS n FROM ${tables.edges}
         WHERE namespace = $1 AND id = $2`,
        ["tenant-a", "relation-generic"],
      ),
      0,
    );
    const revivedRelation = await runtime.transaction({
      operationKey: "relation:revive",
      namespace: "tenant-a",
      execute: ({ relations }) =>
        relations.upsert({
          id: "relation-generic",
          type: "related_to",
          source: { type: "job", id: "relation-source" },
          target: { type: "job", id: "relation-target" },
          metadata: { version: 3 },
        }),
    });
    assertEquals(revivedRelation.value, { id: "relation-generic" });
    await runtime.rebuild("tenant-a");
    assertEquals(
      await count(
        session,
        `SELECT count(*)::int AS n FROM ${tables.edges}
         WHERE namespace = $1 AND id = $2`,
        ["tenant-a", "relation-generic"],
      ),
      1,
    );

    const keyedNoChange = await jobs.update("job-a", {
      set: { title: "Priority inbox" },
    }, {
      namespace: "tenant-a",
      identity: { deduplicationId: "job-a:keyed-no-change" },
    });
    assertEquals(keyedNoChange.noop, undefined);
    const unkeyedNoChange = await jobs.update("job-a", {
      set: { title: "Priority inbox" },
    }, { namespace: "tenant-a" });
    assertEquals(unkeyedNoChange.noop, true);
    await jobs.update("job-a", { set: { title: "Later title" } }, {
      namespace: "tenant-a",
    });
    const keyedRetry = await jobs.update("job-a", {
      set: { title: "Priority inbox" },
    }, {
      namespace: "tenant-a",
      identity: { deduplicationId: "job-a:keyed-no-change" },
    });
    assertEquals(keyedRetry.noop, undefined);
    assertEquals((await jobs.get("job-a", "tenant-a"))?.title, "Later title");

    await assertRejects(
      () =>
        runtime.transaction({
          operationKey: "job:bound-write-bypass",
          namespace: "tenant-a",
          execute: async () => {
            await jobs.create({
              id: "job-bound-bypass",
              externalId: "ext-bound-bypass",
              title: "Must reject",
            }, { namespace: "tenant-a" });
          },
        }),
      Error,
      "Use transaction.collections.job",
    );
    assertEquals(await jobs.get("job-bound-bypass", "tenant-a"), null);

    await jobs.create({
      id: "job-reserved-event-names",
      externalId: "ext-reserved-event-names",
      title: "Initial reserved name",
    }, { namespace: "tenant-a" });
    await jobs.mutate(
      "job-reserved-event-names",
      "relationNamedEvent",
      "After relation-named command",
      { namespace: "tenant-a" },
    );
    await jobs.mutate(
      "job-reserved-event-names",
      "assetNamedEvent",
      "After asset-named command",
      { namespace: "tenant-a" },
    );
    await runtime.rebuild("tenant-a");
    assertEquals(
      (await jobs.get("job-reserved-event-names", "tenant-a"))?.title,
      "After asset-named command",
    );
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
