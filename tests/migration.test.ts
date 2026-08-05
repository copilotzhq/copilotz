import { assert, assertEquals, assertRejects } from "@std/assert";
import { Ominipg } from "omnipg";
import { resolveAutoProviders } from "omnipg/auto";
import { createDatabase } from "../database/database.ts";
import { DatabaseSession } from "../database/session.ts";
import { upgradeV1Schema } from "../migration/v1/index.ts";

const LEGACY_SCHEMA = `
  CREATE SCHEMA legacy;
  CREATE TABLE legacy.nodes (
    id TEXT PRIMARY KEY,
    namespace TEXT,
    type TEXT NOT NULL,
    name TEXT NOT NULL,
    embedding JSONB,
    content TEXT,
    data JSONB,
    "sourceType" TEXT,
    "sourceId" TEXT,
    "createdAt" TIMESTAMPTZ,
    "updatedAt" TIMESTAMPTZ
  );
  CREATE TABLE legacy.edges (
    id TEXT PRIMARY KEY,
    "sourceNodeId" TEXT NOT NULL REFERENCES legacy.nodes(id),
    "targetNodeId" TEXT NOT NULL REFERENCES legacy.nodes(id),
    type TEXT NOT NULL,
    data JSONB,
    weight DOUBLE PRECISION,
    "createdAt" TIMESTAMPTZ
  );
  CREATE TABLE legacy.threads (
    id TEXT PRIMARY KEY,
    namespace TEXT,
    name TEXT NOT NULL,
    "externalId" TEXT,
    description TEXT,
    participants JSONB,
    mode TEXT NOT NULL,
    status TEXT NOT NULL,
    summary TEXT,
    "parentThreadId" TEXT,
    "rootThreadId" TEXT,
    "lastEventId" TEXT,
    "lastEventAt" TIMESTAMPTZ,
    "runGeneration" INTEGER,
    "workerLockedBy" TEXT,
    "workerLeaseExpiresAt" TIMESTAMPTZ,
    "createdAt" TIMESTAMPTZ,
    "updatedAt" TIMESTAMPTZ
  );
  CREATE TABLE legacy.events (
    id TEXT PRIMARY KEY,
    "threadId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    payload JSONB NOT NULL,
    "parentEventId" TEXT,
    "traceId" TEXT,
    "runGeneration" INTEGER,
    priority INTEGER,
    "ttlMs" INTEGER,
    "expiresAt" TIMESTAMPTZ,
    namespace TEXT,
    status TEXT NOT NULL,
    metadata JSONB,
    "subjectType" TEXT,
    "subjectId" TEXT,
    operation TEXT,
    "causationId" TEXT,
    "correlationId" TEXT,
    "dedupeKey" TEXT,
    input JSONB,
    before JSONB,
    after JSONB,
    patch JSONB,
    "createdAt" TIMESTAMPTZ,
    "updatedAt" TIMESTAMPTZ
  )
`;

Deno.test("v1 upgrade refuses active state and preserves settled graph semantics", async () => {
  const instance = await Ominipg.connect({
    url: ":memory:",
    ...resolveAutoProviders({ url: ":memory:" }),
  });
  const session = new DatabaseSession(instance);
  try {
    for (
      const statement of LEGACY_SCHEMA.split(";").map((value) => value.trim())
    ) {
      if (statement) await session.query(statement);
    }
    await session.query(
      `INSERT INTO legacy.nodes VALUES
       ('thread-parent', 'tenant', 'thread', 'Parent', NULL, NULL,
        '{"existing":true}', 'thread', 'thread-parent', NOW(), NOW()),
       ('thread-child', 'tenant', 'thread', 'Old child', NULL, NULL,
        '{"existing":true}', 'thread', 'thread-child', NOW(), NOW()),
       ('participant-alice', 'tenant', 'participant', 'Alice', NULL, NULL,
        '{"externalId":"alice","participantType":"human"}',
        'user', 'alice', NOW(), NOW())`,
    );
    await session.query(
      `INSERT INTO legacy.edges VALUES
       ('edge-preserved', 'thread-child', 'participant-alice',
        'legacy_member', '{"preserved":true}', 1, NOW())`,
    );
    await session.query(
      `INSERT INTO legacy.threads VALUES
       ('thread-parent', 'tenant', 'Parent', 'parent', NULL, '[]',
        'immediate', 'active', NULL, NULL, 'thread-parent', NULL, NULL,
        0, NULL, NULL, NOW(), NOW()),
       ('thread-child', 'tenant', 'Child', 'child', 'description',
        '["alice","bob"]', 'immediate', 'active', 'summary',
        'thread-parent', 'thread-parent', 'semantic-event', NOW(),
        0, 'legacy-worker', NOW() + INTERVAL '1 hour', NOW(), NOW())`,
    );
    await session.query(
      `INSERT INTO legacy.events VALUES
       ('pending-event', 'thread-child', 'NEW_MESSAGE', '{"content":"pending"}',
        NULL, 'trace-pending', 0, 0, NULL, NULL, 'tenant', 'pending', '{}',
        'message', 'pending-message', 'create', NULL, 'corr-pending',
        'dedupe-pending', NULL, NULL, NULL, NULL, NOW(), NOW()),
       ('semantic-event', 'thread-child', 'NEW_MESSAGE', '{"content":"kept"}',
        NULL, 'trace-semantic', 0, 0, NULL, NULL, 'tenant', 'completed', '{}',
        'message', 'message-kept', 'create', NULL, 'corr-semantic',
        'dedupe-semantic', '{}', NULL, '{}', '{}', NOW(), NOW()),
       ('token-event', 'thread-child', 'TOKEN', '{"token":"discarded"}',
        NULL, 'trace-token', 0, 0, NULL, NULL, 'tenant', 'completed', '{}',
        NULL, NULL, NULL, NULL, 'corr-token', NULL,
        NULL, NULL, NULL, NULL, NOW(), NOW())`,
    );

    await assertRejects(
      () => upgradeV1Schema(session, "legacy"),
      Error,
      "pending or processing",
    );
    await session.query(
      `UPDATE legacy.events SET status = 'completed' WHERE id = 'pending-event'`,
    );
    await assertRejects(
      () => upgradeV1Schema(session, "legacy"),
      Error,
      "thread leases are active",
    );
    await session.query(
      `UPDATE legacy.threads SET "workerLockedBy" = NULL,
       "workerLeaseExpiresAt" = NULL`,
    );

    const result = await upgradeV1Schema(session, "legacy");
    assertEquals(result, {
      schema: "legacy",
      threads: 2,
      participants: 1,
      events: 2,
    });

    const tables = await session.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'legacy' ORDER BY table_name`,
    );
    assertEquals(tables.rows.map((row) => row.table_name), [
      "edges",
      "event_deliveries",
      "events",
      "nodes",
    ]);
    const child = await session.query<{ data: Record<string, unknown> }>(
      `SELECT data FROM legacy.nodes WHERE id = 'thread-child'`,
    );
    assertEquals(child.rows[0].data.existing, true);
    assertEquals(child.rows[0].data.description, "description");
    const preserved = await session.query<{ count: string | number }>(
      `SELECT COUNT(*) AS count FROM legacy.edges
       WHERE id = 'edge-preserved' AND data ->> 'preserved' = 'true'`,
    );
    assertEquals(Number(preserved.rows[0].count), 1);
    const relationships = await session.query<{ external_id: string }>(
      `SELECT participant.data ->> 'externalId' AS external_id
       FROM legacy.edges relation
       JOIN legacy.nodes participant ON participant.id = relation.target_node_id
       WHERE relation.source_node_id = 'thread-child'
         AND relation.type = 'participates_in'
       ORDER BY external_id`,
    );
    assertEquals(relationships.rows.map((row) => row.external_id), [
      "alice",
      "bob",
    ]);
    const events = await session.query<{
      id: string;
      type: string;
      position: string | number;
    }>(`SELECT id, type, position FROM legacy.events ORDER BY position`);
    assertEquals(events.rows.map(({ id, type }) => ({ id, type })), [
      { id: "pending-event", type: "message.created" },
      { id: "semantic-event", type: "message.created" },
    ]);
    assert(events.rows.every((event) => Number(event.position) > 0));
    assertEquals(
      Number(
        (await session.query<{ count: string | number }>(
          `SELECT COUNT(*) AS count FROM legacy.event_deliveries`,
        )).rows[0].count,
      ),
      0,
    );

    const runtime = await createDatabase({ instance, schema: "legacy" });
    await runtime.close();
    assertEquals(
      Number(
        (await session.query<{ count: string | number }>(
          `SELECT COUNT(*) AS count FROM legacy.nodes`,
        )).rows[0].count,
      ) >= 4,
      true,
    );
  } finally {
    await session.close();
  }
});
