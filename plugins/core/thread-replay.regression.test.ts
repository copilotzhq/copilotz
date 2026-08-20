import { assertEquals, assertExists } from "@std/assert";

import { createSqlSession } from "../../runtime/events/index.ts";
import { createCopilotzEngine } from "../../runtime/engine/index.ts";
import { createPluginRegistry } from "../../runtime/plugins/index.ts";
import { createTestDatabase } from "../../runtime/testing/ominipg.ts";
import { coreCollectionsPlugin } from "./plugin.ts";
import { threadCollection } from "./resources/collections/thread.ts";
import { createTestDomainContext } from "../../runtime/testing/domain-context.ts";

Deno.test("thread replay preserves activity cursors derived from thread-scoped events", async () => {
  const namespace = "tenant-thread-replay-cursor";
  const db = await createTestDatabase({ url: ":memory:" });
  const engine = await createCopilotzEngine({
    session: createSqlSession(db),
    registry: await createPluginRegistry({ plugins: [coreCollectionsPlugin] }),
    defaultDatabaseSchema: "copilotz_thread_replay_cursor",
  });
  try {
    const domain = createTestDomainContext(engine, namespace);
    await domain.features.thread.create({
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
    await domain.features.threadMessage.create({
      id: "message-a",
      threadId: "thread-a",
      sender: {
        id: "user-a",
        externalId: "user-a",
        participantType: "human",
      },
      content,
    });
    const messageEvent = (await engine.events.list({
      namespace,
      threadId: "thread-a",
      limit: 100,
    })).find((event) => event.subject?.id === "message-a");
    assertExists(messageEvent);
    const before = await domain.collections.thread.get({ id: "thread-a" });
    assertEquals(before?.lastEventId, messageEvent.id);
    assertEquals(before?.lastEventPosition, messageEvent.position);

    await engine.collectionRuntime.rebuild(threadCollection, namespace);

    const rebuilt = await domain.collections.thread.get({ id: "thread-a" });
    assertEquals(rebuilt?.lastEventId, messageEvent.id);
    assertEquals(rebuilt?.lastEventPosition, messageEvent.position);
  } finally {
    await engine.shutdown();
    await db.close();
  }
});
