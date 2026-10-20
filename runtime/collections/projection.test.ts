import { assert, assertEquals, assertRejects } from "@std/assert";

import {
  type BoundCollection,
  type CollectionTransactionCollections,
  createCollectionKernel,
} from "./kernel.ts";
import { defineCollection, relation } from "./index.ts";
import { createTestDatabase, type TestDatabase } from "../testing/ominipg.ts";
import { createTestProcessorContext } from "../testing/processor-context.ts";
import {
  createEventCoordinator,
  createEventStore,
  createSqlSession,
  type EventStore,
  provisionCopilotzSchema,
  type SqlExecutor,
  type SqlSession,
} from "../events/index.ts";
import {
  createDeliveryExecutor,
  type DeliveryExecutor,
} from "../execution/index.ts";
import { createPluginRegistry } from "../plugins/index.ts";

const POSTGRES_URL = Deno.env.get("COPILOTZ_TEST_POSTGRES_URL")?.trim();

const recordFields = {
  id: { type: "string" },
  namespace: { type: "string" },
  title: { type: "string" },
  createdAt: { type: "string" },
  updatedAt: { type: "string" },
} as const;
const required = ["id", "namespace", "title", "createdAt", "updatedAt"];

const folderDefinition = defineCollection({
  name: "projection_folder",
  schema: {
    type: "object",
    additionalProperties: false,
    properties: recordFields,
    required,
  } as const,
});

const tagDefinition = defineCollection({
  name: "projection_tag",
  schema: {
    type: "object",
    additionalProperties: false,
    properties: recordFields,
    required,
  } as const,
});

const docDefinition = defineCollection({
  name: "projection_doc",
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      ...recordFields,
      folderId: { type: "string" },
      previousId: { type: "string" },
      ownerTagId: { type: "string" },
      tagIds: { type: "array", items: { type: "string" } },
    },
    required,
  } as const,
  relations: {
    folder: relation.belongsTo("projection_folder", "folderId"),
    previous: relation.belongsTo(
      "projection_doc",
      "previousId",
      "follows",
      "child-to-parent",
    ),
    owner: relation.hasOne("projection_tag", "ownerTagId", "owned_by"),
    tags: relation.hasMany(
      "projection_tag",
      "tagIds",
      "tagged",
      "child-to-parent",
    ),
  },
});

type Fixture = Readonly<{
  db: TestDatabase;
  store: EventStore;
  executor: DeliveryExecutor;
  runtime: ReturnType<typeof createCollectionKernel>;
  folders: BoundCollection;
  tags: BoundCollection;
  docs: BoundCollection;
  sql: { statements: string[]; transactions: number };
}>;

async function createFixture(url: string, schema: string): Promise<Fixture> {
  const db = await createTestDatabase({ url });
  const base = createSqlSession(db);
  await provisionCopilotzSchema(base, schema);
  const sql = { statements: [] as string[], transactions: 0 };
  const recorded = (executor: SqlExecutor): SqlExecutor => ({
    query: <TRow extends Record<string, unknown>>(
      text: string,
      params?: unknown[],
    ) => {
      sql.statements.push(text);
      return executor.query<TRow>(text, params);
    },
  });
  const session: SqlSession = {
    ...recorded(base),
    transaction: (operation) => {
      sql.transactions++;
      return base.transaction((transaction) =>
        operation(recorded(transaction))
      );
    },
  };
  const store = createEventStore({ session, schema });
  const registry = await createPluginRegistry();
  const executor = createDeliveryExecutor({
    store,
    registry,
    workerId: "collection-projection-test",
    createContext: createTestProcessorContext,
  });
  const coordinator = createEventCoordinator({ store, registry, executor });
  const runtime = createCollectionKernel({
    coordinator,
    session,
    eventStore: store,
    now: () => new Date("2026-09-28T12:00:00.000Z"),
  });
  return {
    db,
    store,
    executor,
    runtime,
    folders: runtime.bind(folderDefinition),
    tags: runtime.bind(tagDefinition),
    docs: runtime.bind(docDefinition),
    sql,
  };
}

function graph(fixture: Fixture, namespace: string) {
  const { nodes, edges } = fixture.store.tables;
  return Promise.all([
    fixture.db.query(
      `SELECT id, type, name, data FROM ${nodes}
       WHERE namespace = $1 ORDER BY id`,
      [namespace],
    ).then((result) => result.rows),
    fixture.db.query(
      `SELECT source_node_id AS source, target_node_id AS target, type
       FROM ${edges} WHERE namespace = $1
       ORDER BY source_node_id, target_node_id, type`,
      [namespace],
    ).then((result) => result.rows),
  ]);
}

async function seed(fixture: Fixture, namespace: string) {
  for (const id of ["f1", "f2"]) {
    await fixture.folders.create({ id, title: id }, { namespace });
  }
  for (const id of ["t1", "t2", "t3"]) {
    await fixture.tags.create({ id, title: id }, { namespace });
  }
}

Deno.test("collection writes atomically project their relations", async () => {
  const fixture = await createFixture(":memory:", "copilotz_projection");
  const namespace = "tenant-projection";
  const docs = fixture.docs;
  const measured = async (write: () => Promise<unknown>) => {
    fixture.sql.statements.length = 0;
    fixture.sql.transactions = 0;
    await write();
    assert(
      fixture.sql.statements.find((sql) =>
        /^\s*(UPDATE|INSERT|DELETE)\b/.test(sql)
      )?.includes("owner_epochs"),
      "the fence precedes the projection",
    );
    return {
      statements:
        fixture.sql.statements.filter((sql) =>
          !/^\s*(SAVEPOINT|RELEASE)\b/.test(sql) &&
          !sql.includes("SET holder=holder")
        ).length,
      transactions: fixture.sql.transactions,
    };
  };
  try {
    await seed(fixture, namespace);

    assertEquals(
      await measured(() =>
        docs.create({
          id: "d1",
          title: "First",
          folderId: "f1",
          ownerTagId: "t3",
          tagIds: ["t1", "t2"],
        }, { namespace })
      ),
      { statements: 1, transactions: 1 },
    );
    const move = {
      namespace,
      identity: { deduplicationId: "d1:move" },
    } as const;
    const patch = { set: { folderId: "f2", tagIds: ["t2"] } } as const;
    // Planning reads the record; its checks and writes are the second.
    assertEquals(
      await measured(() => docs.update("d1", patch, move)),
      { statements: 2, transactions: 1 },
    );
    const retried = await docs.update("d1", patch, move);
    assert(!("noop" in retried && retried.noop));
    assertEquals(retried.deduplicated, true);

    await docs.create({
      id: "d2",
      title: "Second",
      folderId: "f1",
      previousId: "d1",
      tagIds: [],
    }, { namespace });
    await docs.create({
      id: "d3",
      title: "Self",
      folderId: "f1",
      previousId: "d3",
    }, { namespace });

    const [, edges] = await graph(fixture, namespace);
    assertEquals(edges, [
      { source: "d1", target: "t3", type: "owned_by" },
      { source: "d2", target: "d1", type: "follows" },
      { source: "d3", target: "d3", type: "follows" },
      { source: "f1", target: "d2", type: "has_projection_doc" },
      { source: "f1", target: "d3", type: "has_projection_doc" },
      { source: "f2", target: "d1", type: "has_projection_doc" },
      { source: "t2", target: "d1", type: "tagged" },
    ]);

    // Single and paired plans each commit through one transaction.
    assertEquals(
      await measured(() =>
        fixture.runtime.transaction({
          operationKey: "lone-write",
          namespace,
          execute: ({ collections }) =>
            collections.projection_doc.create({ id: "d4", title: "Lone" }),
        })
      ),
      { statements: 2, transactions: 1 },
    );
    assertEquals(
      await measured(() =>
        fixture.runtime.transaction({
          operationKey: "paired-writes",
          namespace,
          execute: async ({ collections }) => {
            await collections.projection_doc.create({ id: "d5", title: "A" });
            await collections.projection_doc.create({ id: "d6", title: "B" });
          },
        })
      ),
      { statements: 4, transactions: 1 },
    );

    assertEquals(
      await measured(() => docs.delete("d1", { namespace })),
      { statements: 2, transactions: 1 },
    );
    const projected = await graph(fixture, namespace);
    assertEquals(projected[1], [
      { source: "d3", target: "d3", type: "follows" },
      { source: "f1", target: "d2", type: "has_projection_doc" },
      { source: "f1", target: "d3", type: "has_projection_doc" },
    ]);
  } finally {
    await fixture.executor.shutdown();
    await fixture.db.close();
  }
});

Deno.test("a refused collection write leaves neither its event nor its projection", async () => {
  const fixture = await createFixture(
    ":memory:",
    "copilotz_projection_refused",
  );
  const namespace = "tenant-refused";
  const docs = fixture.docs;
  try {
    await seed(fixture, namespace);
    const before = await graph(fixture, namespace);
    const events = () =>
      fixture.db.query(
        `SELECT count(*) AS count FROM ${fixture.store.tables.events}`,
      )
        .then((result) => Number(result.rows[0].count));
    const eventCount = await events();

    await assertRejects(
      () =>
        docs.create({
          id: "d-missing",
          title: "Missing",
          folderId: "f1",
          tagIds: ["t1", "t-missing"],
        }, { namespace }),
      Error,
      "Relation 'tags' references missing projection_tag 't-missing'.",
    );
    await docs.create({ id: "d1", title: "First" }, { namespace });
    await assertRejects(
      () => docs.create({ id: "d1", title: "Again" }, { namespace }),
      Error,
      "Collection 'projection_doc' 'd1' was created while its mutation was prepared.",
    );
    await assertRejects(
      () =>
        docs.update("d1", { set: { title: "Out of scope" } }, {
          namespace,
          condition: { current: { where: { title: "Other" } } },
        }),
      Error,
      "Collection mutation is outside its authorized scope.",
    );
    await assertRejects(
      () =>
        docs.update("d-unknown", { set: { title: "Unknown" } }, { namespace }),
      Error,
      "Unknown projection_doc 'd-unknown'.",
    );

    const [nodes, edges] = await graph(fixture, namespace);
    assertEquals(edges, before[1]);
    assertEquals(
      nodes.map((node) => node.id),
      [...before[0].map((node) => node.id), "d1"].sort(),
    );
    assertEquals(await events(), eventCount + 1);
    assertEquals((await docs.get("d1", namespace))?.title, "First");
  } finally {
    await fixture.executor.shutdown();
    await fixture.db.close();
  }
});

Deno.test({
  name:
    "concurrent collection writes on PostgreSQL commit one per planned state",
  ignore: !POSTGRES_URL,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const schema = `projection_${crypto.randomUUID().replaceAll("-", "")}`;
    const fixture = await createFixture(POSTGRES_URL!, schema);
    const namespace = "tenant-race";
    const docs = fixture.docs;
    // Both writers use the schema owner. Hold the losing plan before admission,
    // commit the winner, then require its current state to refuse the stale plan.
    const afterPlanned = async (
      operationKey: string,
      plan: (collections: CollectionTransactionCollections) => Promise<unknown>,
      win: () => Promise<unknown>,
    ) => {
      const planned = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      fixture.sql.statements.length = 0;
      fixture.sql.transactions = 0;
      const settled = fixture.runtime.transaction({
        operationKey,
        namespace,
        async execute({ collections }) {
          try {
            await plan(collections);
            planned.resolve();
          } catch (error) {
            planned.reject(error);
            throw error;
          }
          await release.promise;
        },
      }).then(() => undefined, (error: unknown) => error);
      try {
        await planned.promise;
        await win();
      } finally {
        release.resolve();
        await settled;
      }
      assertEquals(
        fixture.sql.statements.filter((sql) =>
          sql.includes("SET holder=holder")
        )
          .length,
        2,
        "both writers commit through the owner fence",
      );
      return { error: await settled, transactions: fixture.sql.transactions };
    };
    const eventCount = async () =>
      Number(
        (await fixture.db.query<{ count: string }>(
          `SELECT count(*) AS count FROM ${fixture.store.tables.events}
         WHERE namespace = $1`,
          [namespace],
        )).rows[0].count,
      );
    try {
      await seed(fixture, namespace);
      await docs.create({ id: "d1", title: "Race", folderId: "f1" }, {
        namespace,
      });

      const updates = await Promise.allSettled(
        Array.from({ length: 8 }, (_, index) =>
          docs.update("d1", {
            set: { title: `writer-${index}`, folderId: `f${1 + index % 2}` },
          }, { namespace })),
      );
      assert(updates.some((outcome) => outcome.status === "fulfilled"));
      for (const outcome of updates) {
        if (outcome.status === "rejected") {
          assert(
            String(outcome.reason?.message).includes(
              "changed while its mutation was prepared",
            ),
            String(outcome.reason),
          );
        }
      }
      const current = await docs.get("d1", namespace);
      const [, edges] = await graph(fixture, namespace);
      assertEquals(
        edges.filter((edge) => edge.target === "d1"),
        [{
          source: current?.folderId,
          target: "d1",
          type: "has_projection_doc",
        }],
      );

      // Planning is concurrent, but each commit rechecks the planned state
      // inside its serialized owner command. The loser's relation must not move.
      const moved = current?.folderId === "f2" ? "f1" : "f2";
      const beforeUpdate = await eventCount();
      const stale = await afterPlanned(
        "stale-update",
        (collections) =>
          collections.projection_doc.update({
            id: "d1",
            set: { folderId: moved },
          }),
        () => docs.update("d1", { set: { title: "held" } }, { namespace }),
      );
      assert(stale.error instanceof Error);
      assertEquals(
        stale.error.message,
        "Collection 'projection_doc' 'd1' changed while its mutation was prepared.",
      );
      assertEquals((await docs.get("d1", namespace))?.title, "held");
      assertEquals(
        (await docs.get("d1", namespace))?.folderId,
        current?.folderId,
      );
      assertEquals((await graph(fixture, namespace))[1], edges);
      assertEquals(await eventCount(), beforeUpdate + 1);

      // Both creators plan the same absent id. Only the first owner's commit
      // persists a record and event; the later plan must report the conflict.
      const beforeCreate = await eventCount();
      const raced = await afterPlanned(
        "stale-create",
        (collections) =>
          collections.projection_doc.create({ id: "d-race", title: "late" }),
        () => docs.create({ id: "d-race", title: "held" }, { namespace }),
      );
      assert(raced.error instanceof Error);
      assertEquals(
        raced.error.message,
        "Collection 'projection_doc' 'd-race' was created while its mutation was prepared.",
      );
      assertEquals(raced.transactions, 2);
      assertEquals((await docs.get("d-race", namespace))?.title, "held");
      assertEquals(await eventCount(), beforeCreate + 1);
    } finally {
      await fixture.executor.shutdown();
      await fixture.db.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await fixture.db.close();
    }
  },
});
