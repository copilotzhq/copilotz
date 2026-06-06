import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { GRAPH_EDGE } from "@/runtime/graph/edges.ts";

import { createCollectionsManager } from "@/database/collections/index.ts";
import { createDatabase } from "@/database/index.ts";
import messageCollection from "@/resources/collections/message.ts";
import participantCollection from "@/resources/collections/participant.ts";
import { createMessageService } from "@/runtime/collections/native.ts";

Deno.test({
  name:
    "message create writes tenant-scoped thread and participant graph edges",
  sanitizeExit: false,
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const db = await createDatabase({ url: ":memory:" });
    const manager = createCollectionsManager(db, [
      participantCollection,
      messageCollection,
    ]);

    const namespace = "tenant-test";
    const threadId = crypto.randomUUID();
    await db.ops.findOrCreateThread(threadId, {
      namespace,
      name: "Test Thread",
      participants: ["user-1"],
    });
    await db.ops.createNode({
      namespace,
      type: "participant",
      name: "User 1",
      data: {
        externalId: "user-1",
        participantType: "human",
        name: "User 1",
      },
      sourceType: "user",
      sourceId: "user-1",
    });

    const messageService = createMessageService({
      collections: manager,
      ops: db.ops,
    });

    const created = await messageService.create({
      threadId,
      senderId: "user-1",
      senderType: "user",
      content: "hello world",
      metadata: {},
    }, namespace);

    assertEquals(created.threadId, threadId);
    assertEquals(created.senderId, "user-1");
    assertEquals(created.senderType, "user");
    assertEquals(created.content, "hello world");
    const node = await db.ops.getNodeById(created.id);
    assertEquals(node?.namespace, namespace);
    assertEquals(node?.sourceType, "thread");
    assertEquals(node?.sourceId, threadId);

    const edges = await db.query<{ type: string }>(
      `SELECT "type" FROM "edges" WHERE "target_node_id" = $1 ORDER BY "type" ASC`,
      [created.id],
    );
    assertEquals(edges.rows.map((edge) => edge.type), [
      GRAPH_EDGE.HAS_MESSAGE,
      GRAPH_EDGE.SENT_BY,
    ]);
  },
});

Deno.test({
  name:
    "message create uses the real participant node id when legacy data.id differs",
  sanitizeExit: false,
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const db = await createDatabase({ url: ":memory:" });
    const manager = createCollectionsManager(db, [
      participantCollection,
      messageCollection,
    ]);

    const messageService = createMessageService({
      collections: manager,
      ops: db.ops,
    });

    const namespace = "tenant-test";
    const threadId = crypto.randomUUID();
    await db.ops.findOrCreateThread(threadId, {
      namespace,
      name: "Legacy Thread",
      participants: ["legacy-user"],
    });

    const participantNodeId = crypto.randomUUID();
    await db.query(
      `INSERT INTO "nodes" (
      "id", "namespace", "type", "name", "content", "data", "embedding", "created_at", "updated_at"
    ) VALUES (
      $1, $2, $3, $4, $5, $6, NULL, NOW(), NOW()
    )`,
      [
        participantNodeId,
        namespace,
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
      threadId,
      senderId: "legacy-user",
      senderType: "user",
      content: "hello from legacy participant",
      metadata: {},
    }, namespace);

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

    const sentBy = edges.rows.find((edge) => edge.type === GRAPH_EDGE.SENT_BY);

    assertEquals(sentBy?.source_node_id, participantNodeId);
    assertEquals(sentBy?.target_node_id, created.id);
    assertEquals(created.content, "hello from legacy participant");
  },
});

Deno.test({
  name: "message edit creates an active revision branch in the same thread",
  sanitizeExit: false,
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const db = await createDatabase({ url: ":memory:" });
    const manager = createCollectionsManager(db, [
      participantCollection,
      messageCollection,
    ]);
    const messageService = createMessageService({
      collections: manager,
      ops: db.ops,
    });

    const namespace = "tenant-test";
    const threadId = crypto.randomUUID();
    await db.ops.findOrCreateThread(threadId, {
      namespace,
      name: "Edit Thread",
      participants: ["user-1", "assistant"],
    });
    await db.ops.createNode({
      namespace,
      type: "participant",
      name: "User 1",
      data: {
        externalId: "user-1",
        participantType: "human",
        name: "User 1",
      },
      sourceType: "user",
      sourceId: "user-1",
    });

    const original = await messageService.create({
      threadId,
      senderId: "user-1",
      senderType: "user",
      content: "original question",
      metadata: {},
    }, namespace);
    await messageService.create({
      threadId,
      senderId: "assistant",
      senderType: "agent",
      content: "old answer",
      metadata: {},
    }, namespace);

    const edit = await messageService.edit(
      threadId,
      original.id,
      "edited question",
    );
    const newAnswer = await messageService.create({
      threadId,
      senderId: "assistant",
      senderType: "agent",
      content: "new answer",
      metadata: {},
    }, namespace);

    const page = await messageService.listHistoryPage(threadId);

    assertEquals(page.data.map((message) => message.content), [
      "edited question",
      "new answer",
    ]);
    assertEquals(edit.rootMessageId, original.id);
    assertEquals(edit.revisionIndex, 1);
    const editMetadata = edit.message.metadata?.copilotzEdit as
      | Record<string, unknown>
      | undefined;
    assertEquals(editMetadata, {
      originalMessageId: original.id,
      rootMessageId: original.id,
      previousRevisionMessageId: original.id,
      revisionIndex: 1,
      editedAt: editMetadata?.editedAt,
    });
    assertEquals(page.pageInfo, {
      hasMoreBefore: false,
      oldestMessageId: edit.message.id,
      newestMessageId: newAnswer.id,
    });
  },
});
