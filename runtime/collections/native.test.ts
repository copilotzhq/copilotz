import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";

import { createCollectionsManager } from "@/database/collections/index.ts";
import { createDatabase } from "@/database/index.ts";
import messageCollection from "@/resources/collections/message.ts";
import participantCollection from "@/resources/collections/participant.ts";
import { createMessageService } from "@/runtime/collections/native.ts";

Deno.test("collection-backed message create does not write graph edges", async () => {
  const db = await createDatabase({ url: ":memory:" });
  const manager = createCollectionsManager(db, [
    participantCollection,
    messageCollection,
  ]);

  const participantCollectionScoped = manager.withNamespace("global")
    .participant as any;

  const messageService = createMessageService({
    collections: manager,
    ops: db.ops,
  });

  const participant = await participantCollectionScoped.upsertIdentity({
    externalId: "user-1",
    participantType: "human",
    name: "User 1",
  });

  const created = await messageService.create({
    threadId: "thread-1",
    senderId: participant.id,
    senderType: "user",
    content: "hello world",
    metadata: {},
  });

  assertEquals(created.threadId, "thread-1");
  assertEquals(created.senderId, participant.id);
  assertEquals(created.senderType, "user");
});

Deno.test("collection-backed message create uses the real participant node id when legacy data.id differs", async () => {
  const db = await createDatabase({ url: ":memory:" });
  const manager = createCollectionsManager(db, [
    participantCollection,
    messageCollection,
  ]);

  const messageService = createMessageService({
    collections: manager,
    ops: db.ops,
  });

  const participantNodeId = "01KPXLEGACYNODE000000000000";
  await db.query(
    `INSERT INTO "nodes" (
      "id", "namespace", "type", "name", "content", "data", "embedding", "created_at", "updated_at"
    ) VALUES (
      $1, $2, $3, $4, $5, $6, NULL, NOW(), NOW()
    )`,
    [
      participantNodeId,
      "global",
      "participant",
      "Legacy User",
      null,
      {
        id: "6762ca9364e2d4252a98dd97",
        externalId: "legacy-user",
        participantType: "human",
        name: "Legacy User",
      },
    ],
  );

  const created = await messageService.create({
    threadId: "thread-legacy",
    senderId: "legacy-user",
    senderType: "user",
    content: "hello from legacy participant",
    metadata: {},
  });

  const edges = await db.query<{
    source_node_id: string;
    target_node_id: string;
    type: string;
  }>(
    `SELECT "source_node_id", "target_node_id", "type"
       FROM "edges"
      WHERE "target_node_id" = $1
      ORDER BY "type" ASC`,
    [created.id],
  );

  const sentBy = edges.rows.find((edge) => edge.type === "SENT_BY");

  assertEquals(sentBy?.source_node_id, participantNodeId);
  assertEquals(sentBy?.target_node_id, created.id);
});
