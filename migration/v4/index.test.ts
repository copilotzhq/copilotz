import { assertEquals, assertRejects } from "@std/assert";
import { createTestDatabase } from "../../runtime/testing/ominipg.ts";
import type { SqlExecutor, SqlSession } from "../../runtime/events/session.ts";
import { quoteEventIdentifier } from "../../runtime/events/schema.ts";
import { migrateToV4 } from "./index.ts";
import { provisionLegacyGraphV1Fixture } from "./fixture.test.ts";
import { coreCollectionsPlugin } from "../../plugins/core/plugin.ts";

async function seed(
  session: SqlSession,
  status = "completed",
  schema = "public",
): Promise<void> {
  const q = quoteEventIdentifier(schema);
  await session.query(
    `INSERT INTO ${q}.threads (id, name) VALUES ('thread-1', 'Thread')`,
  );
  await session.query(
    `INSERT INTO ${q}.nodes (id, namespace, type, name, content, data)
      VALUES ('p1', 'ns', 'participant', 'User', NULL, $1::jsonb),
             ('thread-1', 'ns', 'thread', 'Thread', NULL, '{"metadata":{}}'::jsonb),
             ('node-1', 'ns', 'message', 'Message', NULL, $2::jsonb),
             ('asset-1', 'ns', 'asset', 'Asset', NULL, $3::jsonb)`,
    [
      JSON.stringify({
        externalId: "p1",
        participantType: "human",
        metadata: {},
      }),
      JSON.stringify({
        threadId: "thread-1",
        senderId: "p1",
        content: "See \`asset://asset-1\`.",
        metadata: {
          attachments: [{
            assetRef: "asset://asset-1",
            kind: "file",
            mimeType: "application/octet-stream",
            fileName: "proof.bin",
          }],
        },
      }),
      JSON.stringify({ ref: "asset://asset-1" }),
    ],
  );
  await session.query(
    `INSERT INTO ${q}.edges (id, source_node_id, target_node_id, type)
      VALUES ('edge-1', 'node-1', 'asset-1', 'has_asset'),
             ('edge-derived', 'node-1', 'node-1', 'derived_from')`,
  );
  await session.query(
    `INSERT INTO ${q}.events (id, "threadId", "eventType", payload, status)
      VALUES ('event-1', 'thread-1', 'message.created', '{}'::jsonb, $1)`,
    [status],
  );
}

async function publicTables(
  session: Awaited<ReturnType<typeof createTestDatabase>>["session"],
): Promise<string[]> {
  const result = await session.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name`,
  );
  return result.rows.map((row) => row.table_name);
}

Deno.test("legacy v4 cut refuses pending work without writing archive state", async () => {
  const db = await createTestDatabase({ url: ":memory:" });
  try {
    await provisionLegacyGraphV1Fixture(db.session);
    await seed(db.session, "pending");
    const before = await publicTables(db.session);
    await assertRejects(
      () =>
        migrateToV4({
          session: db.session,
          plugins: [coreCollectionsPlugin],
          resolveLegacyAsset() {
            return { bytes: new Uint8Array() };
          },
        }),
      Error,
      "actionable legacy events",
    );
    assertEquals(await publicTables(db.session), before);
    assertEquals(
      (await db.session.query<{ n: string | number }>(
        "SELECT count(*) AS n FROM information_schema.schemata WHERE schema_name LIKE '%copilotz_v4_legacy%'",
      )).rows[0]?.n,
      0,
    );
  } finally {
    await db.close();
  }
});

Deno.test("legacy v4 cut atomically archives exact tables and reruns from immutable state", async () => {
  const db = await createTestDatabase({ url: ":memory:" });
  try {
    await provisionLegacyGraphV1Fixture(db.session);
    await seed(db.session);
    const seen: string[] = [];
    const options = {
      session: db.session,
      plugins: [coreCollectionsPlugin],
      config: { bodyStore: "fixture" },
      resolveLegacyAsset(asset: { ref: string }) {
        seen.push(asset.ref);
        return { bytes: new TextEncoder().encode(asset.ref) };
      },
    } as const;
    const cut = await migrateToV4(options);
    assertEquals(cut.stage, "complete");
    assertEquals(cut.counts, {
      retained: 3,
      retired: 0,
      sourceEvents: 6,
      assets: 2,
    });
    assertEquals(seen, [
      "asset://asset-1",
      "asset://asset-1",
      "asset://asset-1",
      "asset://asset-1",
      "asset://asset-1",
    ]);
    assertEquals(
      (await db.session.query<{ n: string | number }>(
        `SELECT count(*) AS n FROM "${cut.archiveSchema}".nodes`,
      )).rows[0]?.n,
      4,
    );
    const marker = await db.session.query<{ n: string | number }>(
      "SELECT count(*) AS n FROM public.copilotz_schema_metadata",
    );
    assertEquals(marker.rows[0]?.n, 1);
    const migratedMessage = await db.session.query<{ data: unknown }>(
      "SELECT data FROM public.nodes WHERE id = 'node-1' AND type = 'message'",
    );
    const content = (typeof migratedMessage.rows[0]?.data === "string"
      ? JSON.parse(migratedMessage.rows[0]!.data as string)
      : migratedMessage.rows[0]?.data) as {
        content: Array<{ assetId: string; role: string; mediaType: string }>;
      };
    assertEquals(
      content.content.map((ref) => [ref.assetId, ref.role, ref.mediaType]),
      [
        ["migration-content:node-1", "body", "text/plain; charset=utf-8"],
        ["asset-1", "attachment", "application/octet-stream"],
      ],
    );
    assertEquals(
      (await db.session.query<{ stage: string }>(
        "SELECT stage FROM public.copilotz_v4_migration_state WHERE singleton = TRUE",
      )).rows[0]?.stage,
      "complete",
    );
    const rerun = await migrateToV4(options);
    assertEquals(rerun.stage, "complete");
    await assertRejects(
      () =>
        migrateToV4({ ...options, config: { bodyStore: "changed" } }),
      Error,
      "configuration does not match",
    );
    await db.session.query(
      `UPDATE public.nodes
          SET data = jsonb_set(data, '{externalId}', '"corrupt"'::jsonb)
        WHERE id = 'p1' AND type = 'participant'`,
    );
    await assertRejects(
      () => migrateToV4(options),
      Error,
      "does not match replayed record",
    );
  } finally {
    await db.close();
  }
});

Deno.test("legacy v4 cut rolls every table move back when final DDL fails", async () => {
  const db = await createTestDatabase({ url: ":memory:" });
  try {
    await provisionLegacyGraphV1Fixture(db.session);
    await seed(db.session);
    const wrap = (executor: SqlExecutor): SqlExecutor => ({
      query: (sql, params) => {
        if (sql.includes('CREATE TABLE IF NOT EXISTS "public"."nodes"')) {
          return Promise.reject(new Error("injected final-ddl failure"));
        }
        return executor.query(sql, params);
      },
    });
    const failing: SqlSession = {
      query: db.session.query,
      transaction: (operation) =>
        db.session.transaction((transaction) => operation(wrap(transaction))),
    };
    await assertRejects(
      () =>
        migrateToV4({
          session: failing,
          plugins: [coreCollectionsPlugin],
          resolveLegacyAsset() {
            return { bytes: new Uint8Array() };
          },
        }),
      Error,
      "injected final-ddl failure",
    );
    assertEquals(await publicTables(db.session), [
      "edges",
      "events",
      "nodes",
      "threads",
    ]);
    assertEquals(
      (await db.session.query<{ n: string | number }>(
        "SELECT count(*) AS n FROM information_schema.schemata WHERE schema_name LIKE '%copilotz_v4_legacy%'",
      )).rows[0]?.n,
      0,
    );
  } finally {
    await db.close();
  }
});

Deno.test("legacy v4 cut supports a non-public source schema", async () => {
  const db = await createTestDatabase({ url: ":memory:" });
  try {
    await provisionLegacyGraphV1Fixture(db.session, "tenant_a");
    await seed(db.session, "completed", "tenant_a");
    const cut = await migrateToV4({
      session: db.session,
      plugins: [coreCollectionsPlugin],
      schema: "tenant_a",
      resolveLegacyAsset() {
        return { bytes: new Uint8Array([1]) };
      },
    });
    assertEquals(cut.schema, "tenant_a");
    assertEquals(
      (await db.session.query<{ n: string | number }>(
        `SELECT count(*) AS n FROM ${
          quoteEventIdentifier(cut.archiveSchema)
        }.events`,
      )).rows[0]?.n,
      1,
    );
  } finally {
    await db.close();
  }
});

Deno.test("released namespaced Asset refs preserve encoded namespaces and slash IDs", async () => {
  const db = await createTestDatabase({ url: ":memory:" });
  try {
    await provisionLegacyGraphV1Fixture(db.session);
    await db.session.query(
      `INSERT INTO public.threads (id, namespace, name)
        VALUES ('thread-path', 'tenant x', 'Path thread')`,
    );
    await db.session.query(
      `INSERT INTO public.nodes (id, namespace, type, name, content, data)
        VALUES
          ('participant-path', 'tenant x', 'participant', 'User', NULL, $1::jsonb),
          ('thread-path', 'tenant x', 'thread', 'Path thread', NULL, '{"metadata":{}}'::jsonb),
          ('message-path', 'tenant x', 'message', 'Message', 'body', $2::jsonb),
          ('legacy-asset-path', 'tenant x', 'asset', 'Asset', NULL, $3::jsonb)`,
      [
        JSON.stringify({
          externalId: "path-user",
          participantType: "human",
          metadata: {},
        }),
        JSON.stringify({
          threadId: "thread-path",
          senderId: "path-user",
          metadata: {
            attachments: [{
              assetRef: "asset://tenant%20x/folder/file.bin",
              kind: "file",
            }],
          },
        }),
        JSON.stringify({
          ref: "asset://tenant%20x/folder/file.bin",
          mime: "application/octet-stream",
        }),
      ],
    );
    await db.session.query(
      `INSERT INTO public.events (id, "threadId", "eventType", payload, status)
        VALUES ('event-path', 'thread-path', 'message.created', '{}'::jsonb, 'completed')`,
    );
    await migrateToV4({
      session: db.session,
      plugins: [coreCollectionsPlugin],
      resolveLegacyAsset() {
        return {
          bytes: new Uint8Array([1, 2, 3]),
          mediaType: "application/octet-stream",
        };
      },
    });
    const message = await db.session.query<{ data: unknown }>(
      "SELECT data FROM public.nodes WHERE id = 'message-path'",
    );
    const data = typeof message.rows[0]?.data === "string"
      ? JSON.parse(message.rows[0].data)
      : message.rows[0]?.data as { content: Array<{ assetId: string }> };
    assertEquals(data.content[1]?.assetId, "folder/file.bin");
  } finally {
    await db.close();
  }
});

Deno.test("message content source interruption does not advance the owning message cursor", async () => {
  const db = await createTestDatabase({ url: ":memory:" });
  try {
    await provisionLegacyGraphV1Fixture(db.session);
    await seed(db.session);
    const wrap = (executor: SqlExecutor): SqlExecutor => ({
      query: (sql, params) => {
        if (
          sql.includes("INSERT INTO") && params?.includes("message.created")
        ) {
          return Promise.reject(
            new Error("injected message-source interruption"),
          );
        }
        return executor.query(sql, params);
      },
    });
    const failing: SqlSession = {
      query: db.session.query,
      transaction: (operation) =>
        db.session.transaction((transaction) => operation(wrap(transaction))),
    };
    const migration = {
      plugins: [coreCollectionsPlugin],
      resolveLegacyAsset() {
        return { bytes: new Uint8Array([1]) };
      },
    } as const;
    await assertRejects(
      () => migrateToV4({ ...migration, session: failing }),
      Error,
      "injected message-source interruption",
    );
    const cursor = await db.session.query<{ source_cursor: unknown }>(
      "SELECT source_cursor FROM public.copilotz_v4_migration_state WHERE singleton = TRUE",
    );
    assertEquals(cursor.rows[0]?.source_cursor, {
      stage: "messages",
      lastId: "",
    });
    await migrateToV4({ ...migration, session: db.session });
    assertEquals(
      (await db.session.query<{ n: string | number }>(
        "SELECT count(*) AS n FROM public.events WHERE type = 'message.created'",
      )).rows[0]?.n,
      1,
    );
  } finally {
    await db.close();
  }
});

Deno.test("unknown retained custom type refuses before any source event is written", async () => {
  const db = await createTestDatabase({ url: ":memory:" });
  try {
    await provisionLegacyGraphV1Fixture(db.session);
    await seed(db.session);
    await db.session.query(
      `INSERT INTO public.nodes (id, namespace, type, name, data)
        VALUES ('custom-1', 'ns', 'custom', 'Custom', '{}'::jsonb)`,
    );
    await assertRejects(
      () =>
        migrateToV4({
          session: db.session,
          plugins: [coreCollectionsPlugin],
          resolveLegacyAsset() {
            return { bytes: new Uint8Array([1]) };
          },
        }),
      Error,
      "retained legacy type 'custom'",
    );
    assertEquals(await publicTables(db.session), [
      "edges",
      "events",
      "nodes",
      "threads",
    ]);
  } finally {
    await db.close();
  }
});

Deno.test("crash immediately before completion marker leaves migration resumable", async () => {
  const db = await createTestDatabase({ url: ":memory:" });
  try {
    await provisionLegacyGraphV1Fixture(db.session);
    await seed(db.session);
    const wrap = (executor: SqlExecutor): SqlExecutor => ({
      query(sql, params) {
        if (
          sql.includes("INSERT INTO") &&
          sql.includes("copilotz_schema_metadata")
        ) {
          return Promise.reject(new Error("injected marker write failure"));
        }
        return executor.query(sql, params);
      },
    });
    const failing: SqlSession = {
      query: db.session.query,
      transaction: (operation) =>
        db.session.transaction((transaction) => operation(wrap(transaction))),
    };
    const base = {
      plugins: [coreCollectionsPlugin],
      resolveLegacyAsset() {
        return { bytes: new Uint8Array([7]) };
      },
    } as const;
    await assertRejects(
      () => migrateToV4({ ...base, session: failing }),
      Error,
      "injected marker write failure",
    );
    assertEquals(
      (await db.session.query<{ n: string | number }>(
        "SELECT count(*) AS n FROM public.copilotz_schema_metadata",
      )).rows[0]?.n,
      0,
    );
    assertEquals(
      (await db.session.query<{ stage: string }>(
        "SELECT stage FROM public.copilotz_v4_migration_state WHERE singleton = TRUE",
      )).rows[0]?.stage,
      "sources",
    );
    assertEquals(
      (await migrateToV4({ ...base, session: db.session })).stage,
      "complete",
    );
  } finally {
    await db.close();
  }
});

Deno.test("participant aliases are namespace-scoped and missing tool senders become deterministic participants", async () => {
  const db = await createTestDatabase({ url: ":memory:" });
  try {
    await provisionLegacyGraphV1Fixture(db.session);
    await db.session.query(
      `INSERT INTO public.threads (id, namespace, name) VALUES ('ta', 'a', 'A'), ('tb', 'b', 'B'), ('tc', 'a', 'C')`,
    );
    await db.session.query(
      `INSERT INTO public.nodes (id, namespace, type, name, content, data) VALUES
      ('pa', 'a', 'participant', 'A user', NULL, $1::jsonb),
      ('pb', 'b', 'participant', 'B user', NULL, $2::jsonb),
      ('pt', 'a', 'participant', 'Existing tool', NULL, $6::jsonb),
      ('ta', 'a', 'thread', 'A', NULL, '{"metadata":{}}'::jsonb),
      ('tb', 'b', 'thread', 'B', NULL, '{"metadata":{}}'::jsonb),
      ('tc', 'a', 'thread', 'C', NULL, '{"metadata":{}}'::jsonb),
      ('ma', 'a', 'message', 'A message', 'a', $3::jsonb),
      ('mb', 'b', 'message', 'B message', 'b', $4::jsonb),
      ('mt', 'a', 'message', 'Tool result', 'ok', $5::jsonb),
      ('mt2', 'a', 'message', 'Tool result again', 'ok', $7::jsonb),
      ('me', 'a', 'message', 'Existing tool result', 'ok', $8::jsonb),
      ('tx-only', 'b', 'tool_execution', 'Execution-only tool', NULL, $9::jsonb)`,
      [
        JSON.stringify({
          externalId: "same",
          participantType: "human",
          metadata: {},
        }),
        JSON.stringify({
          externalId: "same",
          participantType: "human",
          metadata: {},
        }),
        JSON.stringify({ threadId: "ta", senderId: "same", metadata: {} }),
        JSON.stringify({ threadId: "tb", senderId: "same", metadata: {} }),
        JSON.stringify({
          threadId: "ta",
          senderId: "same",
          senderType: "tool",
          toolCallId: "call-1",
          metadata: {
            toolCalls: [{ tool: { id: "tool-x" }, visibility: "public" }],
          },
        }),
        JSON.stringify({
          externalId: "tool-existing",
          participantType: "tool",
          metadata: {},
        }),
        JSON.stringify({
          threadId: "tc",
          senderId: "same",
          senderType: "tool",
          toolCallId: "call-2",
          metadata: {
            toolCalls: [{ tool: { id: "tool-x" }, visibility: "public" }],
          },
        }),
        JSON.stringify({
          threadId: "ta",
          senderId: "same",
          senderType: "tool",
          toolCallId: "call-3",
          metadata: {
            toolCalls: [{
              tool: { id: "tool-existing" },
              visibility: "public",
            }],
          },
        }),
        JSON.stringify({
          threadId: "tb",
          toolCallId: "call-only",
          tool: { id: "tool-only" },
          status: "completed",
        }),
      ],
    );
    await db.session.query(
      `INSERT INTO public.events (id, "threadId", "eventType", payload, status) VALUES
      ('ea', 'ta', 'message.created', '{}'::jsonb, 'completed'), ('eb', 'tb', 'message.created', '{}'::jsonb, 'completed')`,
    );
    await migrateToV4({
      session: db.session,
      plugins: [coreCollectionsPlugin],
      resolveLegacyAsset() {
        return { bytes: new Uint8Array() };
      },
    });
    const rows = await db.session.query<{ id: string; data: unknown }>(
      `SELECT id, data FROM public.nodes WHERE id IN ('ma', 'mb', 'mt', 'mt2', 'me', 'ta', 'tb', 'tc', 'migration-tool:a:tool-x', 'migration-tool:b:tool-only') ORDER BY id`,
    );
    const data = new Map(
      rows.rows.map((
        row,
      ) => [
        row.id,
        typeof row.data === "string" ? JSON.parse(row.data) : row.data,
      ]),
    );
    assertEquals((data.get("ma") as { senderId: string }).senderId, "pa");
    assertEquals((data.get("mb") as { senderId: string }).senderId, "pb");
    assertEquals(
      (data.get("mt") as { senderId: string }).senderId,
      "migration-tool:a:tool-x",
    );
    assertEquals(
      (data.get("mt2") as { senderId: string }).senderId,
      "migration-tool:a:tool-x",
    );
    assertEquals((data.get("me") as { senderId: string }).senderId, "pt");
    assertEquals(
      (data.get("ta") as { participantIds: string[] }).participantIds.includes(
        "migration-tool:a:tool-x",
      ),
      true,
    );
    assertEquals(
      (data.get("tc") as { participantIds: string[] }).participantIds.includes(
        "migration-tool:a:tool-x",
      ),
      true,
    );
    assertEquals(
      (data.get("ta") as { participantIds: string[] }).participantIds.includes(
        "pt",
      ),
      true,
    );
    assertEquals(
      (data.get("tb") as { participantIds: string[] }).participantIds.includes(
        "migration-tool:b:tool-only",
      ),
      true,
    );
  } finally {
    await db.close();
  }
});

Deno.test("drained legacy events remain immutable only in the archive, not copied into live replay", async () => {
  const db = await createTestDatabase({ url: ":memory:" });
  try {
    await provisionLegacyGraphV1Fixture(db.session);
    await seed(db.session);
    const result = await migrateToV4({
      session: db.session,
      plugins: [coreCollectionsPlugin],
      resolveLegacyAsset() {
        return { bytes: new Uint8Array([1]) };
      },
    });
    assertEquals(
      (await db.session.query<{ n: string | number }>(
        `SELECT count(*) AS n FROM ${
          quoteEventIdentifier(result.archiveSchema)
        }.events WHERE id = 'event-1' AND payload = '{}'::jsonb AND status = 'completed'`,
      )).rows[0]?.n,
      1,
    );
    assertEquals(
      (await db.session.query<{ n: string | number }>(
        "SELECT count(*) AS n FROM public.events WHERE payload = '{}'::jsonb",
      )).rows[0]?.n,
      0,
    );
    assertEquals(
      Number(
        (await db.session.query<{ n: string | number }>(
          "SELECT count(*) AS n FROM public.events WHERE metadata -> 'migration' IS NOT NULL",
        )).rows[0]?.n ?? 0,
      ) > 0,
      true,
    );
  } finally {
    await db.close();
  }
});
