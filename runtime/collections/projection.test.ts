import { assert, assertEquals, assertRejects } from "@std/assert";

import { type BoundCollection, createCollectionKernel } from "./kernel.ts";
import { defineCollection, relation } from "./index.ts";
import { createTestDatabase, type TestDatabase } from "../testing/ominipg.ts";
import { createTestProcessorContext } from "../testing/processor-context.ts";
import {
  createCoreSchemaStatements,
  createEventCoordinator,
  createEventStore,
  createSqlSession,
  type EventStore,
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
  for (const statement of createCoreSchemaStatements(schema)) {
    await base.query(statement);
  }
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

Deno.test("each collection write is one statement that projects its relations", async () => {
  const fixture = await createFixture(":memory:", "copilotz_projection");
  const namespace = "tenant-projection";
  const docs = fixture.docs;
  const measured = async (write: () => Promise<unknown>) => {
    fixture.sql.statements.length = 0;
    fixture.sql.transactions = 0;
    await write();
    return {
      statements: fixture.sql.statements.length,
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
      { statements: 1, transactions: 0 },
    );
    const move = {
      namespace,
      identity: { deduplicationId: "d1:move" },
    } as const;
    const patch = { set: { folderId: "f2", tagIds: ["t2"] } } as const;
    // Planning reads the record; its checks and writes are the second.
    assertEquals(
      await measured(() => docs.update("d1", patch, move)),
      { statements: 2, transactions: 0 },
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

    // A transaction needs BEGIN/COMMIT only once it holds a second write.
    assertEquals(
      await measured(() =>
        fixture.runtime.transaction({
          operationKey: "lone-write",
          namespace,
          execute: ({ collections }) =>
            collections.projection_doc.create({ id: "d4", title: "Lone" }),
        })
      ),
      { statements: 2, transactions: 0 },
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
      { statements: 2, transactions: 0 },
    );
    const projected = await graph(fixture, namespace);
    assertEquals(projected[1], [
      { source: "d3", target: "d3", type: "follows" },
      { source: "f1", target: "d2", type: "has_projection_doc" },
      { source: "f1", target: "d3", type: "has_projection_doc" },
    ]);

    // Rebuild replays the same events through the same projector.
    await fixture.runtime.rebuild(namespace);
    assertEquals(await graph(fixture, namespace), projected);
    assertEquals(await fixture.runtime.verify(docDefinition, namespace), {
      ok: true,
    });
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
    // Runs `contend` against a row another connection holds, and commits that
    // hold only once `contend` waits on it.
    const whileHeld = async (
      hold: (transaction: SqlExecutor) => Promise<unknown>,
      contend: () => Promise<unknown>,
    ) => {
      const blocker = await createTestDatabase({ url: POSTGRES_URL! });
      try {
        let settled: Promise<unknown> = Promise.resolve();
        fixture.sql.transactions = 0;
        await blocker.transaction(async (transaction) => {
          await hold(transaction);
          const [{ xid }] = (await transaction.query<{ xid: string }>(
            "SELECT (txid_current() % 4294967296)::text AS xid",
          )).rows;
          settled = contend().then(() => undefined, (error: unknown) => error);
          for (let attempt = 0; attempt < 500; attempt++) {
            const [{ waiting }] = (await transaction.query<
              { waiting: boolean }
            >(
              `SELECT EXISTS (
                 SELECT 1 FROM pg_locks
                 WHERE NOT granted AND locktype = 'transactionid'
                   AND transactionid::text = $1
               ) AS waiting`,
              [xid],
            )).rows;
            if (waiting) return;
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
          throw new Error("The contending write never waited on the hold.");
        });
        return { error: await settled, transactions: fixture.sql.transactions };
      } finally {
        await blocker.close();
      }
    };
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
      assertEquals(await fixture.runtime.verify(docDefinition, namespace), {
        ok: true,
      });

      const { nodes } = fixture.store.tables;
      // The update plans against the committed record, then waits on the row
      // a concurrent writer holds, and must see that writer's change.
      const stale = await whileHeld(
        (transaction) =>
          transaction.query(
            `UPDATE ${nodes} SET data = data || '{"title":"held"}'::jsonb
             WHERE namespace = $1 AND id = 'd1'`,
            [namespace],
          ),
        () => docs.update("d1", { set: { folderId: "f2" } }, { namespace }),
      );
      assert(stale.error instanceof Error);
      assertEquals(
        stale.error.message,
        "Collection 'projection_doc' 'd1' changed while its mutation was prepared.",
      );
      assertEquals((await docs.get("d1", namespace))?.title, "held");

      // A concurrent creator holds the id; the create's unique violation is
      // retried against the committed record.
      const raced = await whileHeld(
        (transaction) =>
          transaction.query(
            `INSERT INTO ${nodes} (id, namespace, type, name, data)
             VALUES ('d-race', $1, 'projection_doc', 'd-race', $2::jsonb)`,
            [namespace, JSON.stringify({ title: "held" })],
          ),
        () => docs.create({ id: "d-race", title: "late" }, { namespace }),
      );
      assert(raced.error instanceof Error);
      assertEquals(
        raced.error.message,
        "Collection 'projection_doc' 'd-race' was created while its mutation was prepared.",
      );
      assertEquals(raced.transactions, 1);
    } finally {
      await fixture.executor.shutdown();
      await fixture.db.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await fixture.db.close();
    }
  },
});
