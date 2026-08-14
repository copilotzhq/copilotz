import { assert, assertEquals, assertRejects } from "@std/assert";

import { createTestDatabase } from "../testing/ominipg.ts";
import {
  createCoreSchemaStatements,
  createEventStore,
  createSqlSession,
  quoteEventIdentifier,
} from "./index.ts";

const POSTGRES_URL = Deno.env.get("COPILOTZ_TEST_POSTGRES_URL")?.trim();

function schemaName(): string {
  return `v3_pg_${crypto.randomUUID().replaceAll("-", "")}`;
}

Deno.test({
  name:
    "PostgreSQL keeps the four-table baseline and atomic event/delivery semantics",
  ignore: !POSTGRES_URL,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const schema = schemaName();
    const db = await createTestDatabase({ url: POSTGRES_URL! });
    const session = createSqlSession(db);
    try {
      for (const statement of createCoreSchemaStatements(schema)) {
        await session.query(statement);
      }
      const tables = await session.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables
         WHERE table_schema = $1 AND table_type = 'BASE TABLE'
         ORDER BY table_name`,
        [schema],
      );
      assertEquals(
        tables.rows.map((row) => row.table_name),
        ["edges", "event_deliveries", "events", "nodes"],
      );

      const store = createEventStore({
        session,
        schema,
        random: () => 0,
      });
      await assertRejects(() =>
        store.commitMutation({
          draft: {
            type: "postgres.rollback",
            namespace: "tenant-a",
            payload: { rollback: true },
          },
          consumerIds: ["postgres.consumer"],
          mutate: async ({ transaction, tables }) => {
            await transaction.query(
              `INSERT INTO ${tables.nodes}
                 (id, namespace, type, name, data)
               VALUES ('rollback', 'tenant-a', 'fixture', 'Rollback', '{}')`,
            );
            throw new Error("synthetic rollback");
          },
        })
      );
      assertEquals(
        await store.listEvents({ namespace: "tenant-a" }),
        [],
      );

      const committed = await store.commitMutation({
        draft: {
          type: "widget.created",
          namespace: "tenant-a",
          threadId: "thread-a",
          subject: { type: "widget", id: "widget-a" },
          payload: { label: "PostgreSQL" },
          correlationId: "postgres-correlation-a",
          deduplicationId: "postgres-widget-a",
        },
        consumerIds: ["widget.index", "widget.audit", "widget.index"],
        mutate: async ({ transaction, tables }) => {
          await transaction.query(
            `INSERT INTO ${tables.nodes}
               (id, namespace, type, name, data)
             VALUES
               ('thread-a', 'tenant-a', 'thread', 'Thread', '{}'),
               ('widget-a', 'tenant-a', 'widget', 'Widget', '{}')`,
          );
          return { id: "widget-a" };
        },
      });
      assertEquals(committed.deliveries.length, 2);
      assertEquals(
        (await store.getEvent(committed.event.id))?.position,
        committed.event.position,
      );

      const delivery = committed.deliveries[0];
      const claims = await Promise.all([
        store.claimDelivery({ id: delivery.id, owner: "owner-a" }),
        store.claimDelivery({ id: delivery.id, owner: "owner-b" }),
      ]);
      assertEquals(claims.filter(Boolean).length, 1);
      const claimed = claims.find((value) => value !== null)!;
      assert(
        await store.succeedDelivery(delivery.id, claimed.leaseOwner!),
      );

      await assertRejects(() =>
        session.query(
          `UPDATE ${store.tables.events} SET type = 'widget.changed'
           WHERE id = $1`,
          [committed.event.id],
        )
      );
      assertEquals(
        (await store.getEvent(committed.event.id))?.type,
        "widget.created",
      );

      const old = "2020-01-01T00:00:00.000Z";
      const parent = await store.append({
        type: "old.parent",
        namespace: "tenant-a",
        payload: {},
        createdAt: old,
      });
      await store.append({
        type: "old.child",
        namespace: "tenant-a",
        payload: {},
        causationId: parent.event.id,
        createdAt: old,
      });
      const firstCompaction = await store.compact({
        retentionMs: 7 * 24 * 60 * 60 * 1_000,
        now: new Date("2021-01-01T00:00:00.000Z"),
        limit: 1,
      });
      assertEquals(firstCompaction.events, 1);
      assertEquals(await store.getEvent(parent.event.id) !== null, true);
      const secondCompaction = await store.compact({
        retentionMs: 7 * 24 * 60 * 60 * 1_000,
        now: new Date("2021-01-01T00:00:00.000Z"),
        limit: 1,
      });
      assertEquals(secondCompaction.events, 1);
      assertEquals(await store.getEvent(parent.event.id), null);
    } finally {
      await session.query(
        `DROP SCHEMA IF EXISTS ${quoteEventIdentifier(schema)} CASCADE`,
      ).catch(() => undefined);
      await db.close();
    }
  },
});
