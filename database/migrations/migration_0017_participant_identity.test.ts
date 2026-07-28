import {
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.208.0/assert/mod.ts";

import { createDatabase } from "@/database/index.ts";
import { splitSQLStatements } from "./utils.ts";
import { generateParticipantIdentityMigrations } from "./migration_0017_participant_identity.ts";

Deno.test("participant identity migration consolidates nodes and memberships before enforcing uniqueness", async () => {
  const tempDir = await Deno.makeTempDir();
  const db = await createDatabase({
    url: `file://${tempDir}/participant-identity.db`,
  });

  try {
    await db.query(`DROP INDEX IF EXISTS "uidx_edges_participates_in"`);
    await db.query(`DROP INDEX IF EXISTS "uidx_nodes_participant_identity"`);

    await db.ops.unsafeGraph.createNode({
      id: "participant-old",
      namespace: "tenant-a",
      type: "participant",
      name: "Old Agent",
      content: null,
      data: {
        externalId: "agent-1",
        participantType: "agent",
        name: "Old Agent",
        metadata: {
          profile: { locale: "pt-BR", preferences: ["aisle"] },
          _private: { accessToken: "keep-me" },
        },
      },
      sourceType: "agent",
      sourceId: "agent-1",
    });
    await db.ops.unsafeGraph.createNode({
      id: "participant-new",
      namespace: "tenant-a",
      type: "participant",
      name: "New Agent",
      content: null,
      data: {
        externalId: "agent-1",
        participantType: "agent",
        name: "New Agent",
        metadata: {
          profile: {
            timezone: "America/Sao_Paulo",
            preferences: ["window"],
          },
        },
      },
      sourceType: "agent",
      sourceId: "agent-1",
    });
    await db.ops.unsafeGraph.createNode({
      id: "thread-1",
      namespace: "tenant-a",
      type: "thread",
      name: "Thread",
      content: null,
      data: {},
      sourceType: "thread",
      sourceId: "thread-1",
    });
    await db.ops.unsafeGraph.createNode({
      id: "message-1",
      namespace: "tenant-a",
      type: "message",
      name: "Message",
      content: null,
      data: {},
      sourceType: "message",
      sourceId: "message-1",
    });

    for (const sourceNodeId of ["participant-old", "participant-new"]) {
      await db.ops.unsafeGraph.createEdge({
        sourceNodeId,
        targetNodeId: "thread-1",
        type: "participates_in",
      });
    }
    await db.ops.unsafeGraph.createEdge({
      sourceNodeId: "message-1",
      targetNodeId: "participant-old",
      type: "sent_by",
    });

    for (
      const statement of splitSQLStatements(
        generateParticipantIdentityMigrations(),
      )
    ) {
      await db.query(statement);
    }

    const participants = await db.query<{
      id: string;
      data: Record<string, unknown>;
    }>(
      `SELECT "id", "data"
       FROM "nodes"
       WHERE "namespace" = 'tenant-a'
         AND "type" = 'participant'
         AND "data" ->> 'externalId' = 'agent-1'`,
    );
    assertEquals(participants.rows.length, 1);
    assertEquals(participants.rows[0]?.id, "participant-new");
    assertEquals(participants.rows[0]?.data.metadata, {
      profile: {
        locale: "pt-BR",
        preferences: ["window"],
        timezone: "America/Sao_Paulo",
      },
      _private: { accessToken: "keep-me" },
    });

    const memberships = await db.query<{
      source_node_id: string;
      target_node_id: string;
    }>(
      `SELECT "source_node_id", "target_node_id"
       FROM "edges"
       WHERE "type" = 'participates_in'`,
    );
    assertEquals(memberships.rows, [{
      source_node_id: "participant-new",
      target_node_id: "thread-1",
    }]);

    const incoming = await db.query<{ target_node_id: string }>(
      `SELECT "target_node_id"
       FROM "edges"
       WHERE "type" = 'sent_by'`,
    );
    assertEquals(incoming.rows[0]?.target_node_id, "participant-new");

    await assertRejects(() =>
      db.ops.unsafeGraph.createNode({
        id: "participant-duplicate",
        namespace: "tenant-a",
        type: "participant",
        name: "Duplicate",
        content: null,
        data: {
          externalId: "agent-1",
          participantType: "agent",
        },
        sourceType: "agent",
        sourceId: "agent-1",
      })
    );
    await assertRejects(() =>
      db.ops.unsafeGraph.createEdge({
        sourceNodeId: "participant-new",
        targetNodeId: "thread-1",
        type: "participates_in",
      })
    );
  } finally {
    await db.close();
    await Deno.remove(tempDir, { recursive: true });
  }
});
