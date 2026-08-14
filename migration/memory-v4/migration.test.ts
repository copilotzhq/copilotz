import { assertEquals, assertRejects } from "@std/assert";
import {
  provisionCopilotzSchema,
  quoteEventIdentifier,
} from "../../runtime/events/index.ts";
import {
  createTestDatabase,
  type TestDatabase,
} from "../../runtime/testing/ominipg.ts";
import { discoverMemoryV4Schemas, upgradeMemoryV4Schema } from "./index.ts";

function q(schema: string, table: string): string {
  return `${quoteEventIdentifier(schema)}.${quoteEventIdentifier(table)}`;
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value === "string") return object(JSON.parse(value));
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

async function seed(
  db: TestDatabase,
  schema: string,
  checkpointStatus: "ready" | "pending" = "ready",
) {
  await provisionCopilotzSchema(db.session, schema);
  const nodes = q(schema, "nodes");
  const edges = q(schema, "edges");
  const timestamp = "2026-08-13T00:00:00.000Z";
  const values = [
    ["thread-a", "thread", "Thread", {
      id: "thread-a",
      status: "active",
      metadata: {},
    }],
    ["space-a", "memory_space", "Memory", {
      id: "space-a",
      scopeType: "thread",
      scopeId: "thread-a",
      threadId: "thread-a",
      access: "read_write",
      defaultWrite: true,
    }],
    ["checkpoint-a", "long_term_memory", "Checkpoint", {
      id: "checkpoint-a",
      threadId: "thread-a",
      schemaVersion: "3",
      strategy: "checkpointed_graph",
      status: checkpointStatus,
      memorySpaceId: "space-a",
      readMemorySpaceIds: ["space-a"],
      writeMemorySpaceIds: ["space-a"],
      defaultWriteMemorySpaceId: "space-a",
      sequence: 1,
      agentId: "north",
      sourceStartMessageId: "message-a",
      sourceEndMessageId: "message-b",
      metadata: {
        continuityVersion: "1",
        continuity: {
          state: {
            nextActions: {
              value: ["Ship the migration."],
              sourceMessageIds: ["message-b"],
            },
          },
        },
      },
    }],
    ["brain-a", "brain_node", "Compass state", {
      id: "brain-a",
      memorySpaceId: "space-a",
      checkpointId: "checkpoint-a",
      createdByAgentId: "north",
      originThreadId: "thread-a",
      layer: "working",
      status: "active",
      kind: "current_state",
      name: "Compass state",
      content: "Compass migration is active.",
      confidence: 0.9,
      sourceMessageIds: ["message-a"],
      sourceField: "state.currentState",
      metadata: {},
    }],
    ["brain-b", "brain_node", "Decision", {
      id: "brain-b",
      memorySpaceId: "space-a",
      checkpointId: "checkpoint-a",
      createdByAgentId: "north",
      originThreadId: "thread-a",
      layer: "knowledge",
      status: "superseded",
      kind: "decision",
      name: "Decision",
      content: "Use event-native memory.",
      sourceMessageIds: ["message-b"],
      supersedesNodeId: "brain-old",
      metadata: {},
    }],
  ] as const;
  for (const [id, type, name, data] of values) {
    await db.query(
      `INSERT INTO ${nodes} (
         id, namespace, type, name, content, data, embedding,
         created_at, updated_at
       ) VALUES ($1, 'tenant-a', $2, $3, NULL, $4::jsonb, NULL,
         $5::timestamptz, $5::timestamptz)`,
      [id, type, name, JSON.stringify(data), timestamp],
    );
  }
  for (
    const [id, source, target, type] of [
      ["edge-space", "space-a", "brain-a", "has_brain_node"],
      ["edge-checkpoint", "checkpoint-a", "brain-a", "includes_brain_node"],
      ["edge-memory", "brain-a", "brain-b", "related_to"],
      ["edge-unrelated", "thread-a", "space-a", "related_to"],
    ] as const
  ) {
    await db.query(
      `INSERT INTO ${edges} (
         id, namespace, source_node_id, target_node_id, type, data, weight
       ) VALUES ($1, 'tenant-a', $2, $3, $4, '{}'::jsonb, 1)`,
      [id, source, target, type],
    );
  }
}

Deno.test("memory-v4 migration preserves IDs, provenance, temporal history, and memory relations", async () => {
  const db = await createTestDatabase({ url: ":memory:" });
  const schema = "memory_v4_upgrade";
  try {
    await seed(db, schema);
    assertEquals(await discoverMemoryV4Schemas(db.session), [schema]);
    const result = await upgradeMemoryV4Schema(db.session, schema);
    assertEquals(result, {
      schema,
      recordsMigrated: 3,
      checkpointsMigrated: 1,
      relationsMigrated: 5,
      alreadyUpgraded: false,
    });

    const records = await db.query<{
      id: string;
      type: string;
      data: unknown;
    }>(
      `SELECT id, type, data FROM ${q(schema, "nodes")}
       WHERE id IN ('brain-a', 'brain-b') ORDER BY id`,
    );
    assertEquals(records.rows.map((row) => [row.id, row.type]), [
      ["brain-a", "memory_record"],
      ["brain-b", "memory_record"],
    ]);
    const state = object(records.rows[0].data);
    assertEquals(state.form, "assertion");
    assertEquals(state.kind, "assertion.state");
    assertEquals(state.status, "current");
    assertEquals(object(state.temporal).recordedAt, "2026-08-13T00:00:00.000Z");
    assertEquals(
      (object(state.provenance).sources as Array<Record<string, unknown>>)[0],
      { type: "message", id: "message-a" },
    );
    const decision = object(records.rows[1].data);
    assertEquals(decision.form, "intent");
    assertEquals(decision.kind, "intent.decision");
    assertEquals(decision.status, "superseded");
    const continuity = await db.query<{ data: unknown }>(
      `SELECT data FROM ${q(schema, "nodes")}
       WHERE type = 'memory_record'
         AND data -> 'metadata' -> 'migratedFromMemoryV3'
           ->> 'continuityOnly' = 'true'`,
    );
    assertEquals(continuity.rows.length, 1);
    assertEquals(object(continuity.rows[0].data).kind, "intent.action");
    assertEquals(
      object(continuity.rows[0].data).summary,
      "Ship the migration.",
    );

    const checkpoint = await db.query<{ data: unknown }>(
      `SELECT data FROM ${q(schema, "nodes")} WHERE id = 'checkpoint-a'`,
    );
    const checkpointData = object(checkpoint.rows[0].data);
    assertEquals(checkpointData.schemaVersion, "4");
    assertEquals(checkpointData.strategy, "semantic_graph");
    assertEquals("continuity" in object(checkpointData.metadata), false);
    assertEquals(
      object(object(checkpointData.metadata).migratedFromMemoryV3)
        .continuityWasDerived,
      true,
    );

    const edges = await db.query<{ id: string; type: string; data: unknown }>(
      `SELECT id, type, data FROM ${q(schema, "edges")} ORDER BY id`,
    );
    assertEquals(
      edges.rows.filter((edge) => !edge.id.startsWith("memory-v4-edge:")).map(
        ({ id, type }) => ({ id, type }),
      ),
      [
        { id: "edge-checkpoint", type: "includes_memory_record" },
        { id: "edge-memory", type: "about" },
        { id: "edge-space", type: "has_memory_record" },
        { id: "edge-unrelated", type: "related_to" },
      ],
    );
    assertEquals(
      edges.rows.filter((edge) => edge.id.startsWith("memory-v4-edge:"))
        .map((edge) => edge.type).sort(),
      ["has_memory_record", "includes_memory_record"],
    );
    const memoryEdge = edges.rows.find((edge) => edge.id === "edge-memory");
    assertEquals(object(memoryEdge?.data).sourceType, "memory_record");
    assertEquals(object(memoryEdge?.data).targetType, "memory_record");
    const unrelatedEdge = edges.rows.find((edge) =>
      edge.id === "edge-unrelated"
    );
    assertEquals(object(unrelatedEdge?.data), {});

    assertEquals(await upgradeMemoryV4Schema(db.session, schema), {
      schema,
      recordsMigrated: 0,
      checkpointsMigrated: 0,
      relationsMigrated: 0,
      alreadyUpgraded: true,
    });
  } finally {
    await db.close();
  }
});

Deno.test("memory-v4 migration refuses pending checkpoints without partial writes", async () => {
  const db = await createTestDatabase({ url: ":memory:" });
  const schema = "memory_v4_pending";
  try {
    await seed(db, schema, "pending");
    await assertRejects(
      () => upgradeMemoryV4Schema(db.session, schema),
      Error,
      "requires pending checkpoint",
    );
    const legacy = await db.query<{ type: string }>(
      `SELECT type FROM ${q(schema, "nodes")} WHERE id = 'brain-a'`,
    );
    assertEquals(legacy.rows[0].type, "brain_node");
  } finally {
    await db.close();
  }
});
