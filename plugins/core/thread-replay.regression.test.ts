import { assertEquals, assertExists } from "@std/assert";

import { createSqlSession } from "../../runtime/events/index.ts";
import { createCopilotzEngine } from "../../runtime/engine/index.ts";
import { createPluginRegistry } from "../../runtime/plugins/index.ts";
import { createTestDatabase } from "../../runtime/testing/ominipg.ts";
import { coreCollectionsPlugin } from "./plugin.ts";
import { threadCollection } from "./resources/collections/thread.ts";

Deno.test("thread replay preserves activity cursors derived from thread-scoped events", async () => {
  const namespace = "tenant-thread-replay-cursor";
  const db = await createTestDatabase({ url: ":memory:" });
  const engine = await createCopilotzEngine({
    session: createSqlSession(db),
    registry: await createPluginRegistry({ plugins: [coreCollectionsPlugin] }),
    defaultDatabaseSchema: "copilotz_thread_replay_cursor",
  });
  try {
    await engine.conversation.createThread({
      namespace,
      id: "thread-a",
      participants: [{
        id: "user-a",
        externalId: "user-a",
        participantType: "human",
      }],
    });
    const content = await engine.content.preparer.prepare("hello", {
      namespace,
      idempotencyKey: "thread-replay-message-content",
    });
    const message = await engine.conversation.createMessage({
      namespace,
      id: "message-a",
      threadId: "thread-a",
      sender: {
        id: "user-a",
        externalId: "user-a",
        participantType: "human",
      },
      content,
    });
    const threads = engine.collectionRuntime.get("thread");
    assertExists(threads);
    const before = await threads.get("thread-a", namespace);
    assertEquals(before?.lastEventId, message.event.id);
    assertEquals(before?.lastEventPosition, message.event.position);

    await engine.collectionRuntime.rebuild(threadCollection, namespace);

    const rebuilt = await threads.get("thread-a", namespace);
    assertEquals(rebuilt?.lastEventId, message.event.id);
    assertEquals(rebuilt?.lastEventPosition, message.event.position);
  } finally {
    await engine.shutdown();
    await db.close();
  }
});
