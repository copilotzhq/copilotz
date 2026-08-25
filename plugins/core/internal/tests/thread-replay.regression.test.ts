import { assertEquals, assertExists } from "@std/assert";

import { createSqlSession } from "../../../../runtime/events/index.ts";
import { createCopilotzEngine } from "../../../../runtime/engine/index.ts";
import { createPluginRegistry } from "../../../../runtime/plugins/index.ts";
import { createTestDatabase } from "../../../../runtime/testing/ominipg.ts";
import { coreCollectionsPlugin } from "../../../core-collections/plugin.ts";
import { createTestDomainContext } from "../testing/context.ts";

Deno.test("thread replay does not derive mutable state from related Events", async () => {
  const namespace = "tenant-thread-replay-cursor";
  const db = await createTestDatabase({ url: ":memory:" });
  const engine = await createCopilotzEngine({
    session: createSqlSession(db),
    registry: await createPluginRegistry({ plugins: [coreCollectionsPlugin] }),
    defaultDatabaseSchema: "copilotz_thread_replay_cursor",
  });
  try {
    const domain = createTestDomainContext(engine, namespace);
    await domain.actions.createThread({
      id: "thread-a",
      participants: [{
        id: "user-a",
        externalId: "user-a",
        participantType: "human",
      }],
    });
    await domain.actions.createThreadMessage({
      id: "message-a",
      threadId: "thread-a",
      sender: {
        id: "user-a",
        externalId: "user-a",
        participantType: "human",
      },
      content: "hello",
    });
    const messageEvent = (await engine.events.list({
      namespace,
      threadId: "thread-a",
      limit: 100,
    })).find((event) => event.subject?.id === "message-a");
    assertExists(messageEvent);
    const before = await domain.collections.thread.get({ id: "thread-a" });
    assertEquals(before?.lastEventId, undefined);
    assertEquals(before?.lastEventPosition, undefined);

    await engine.collections.rebuild(namespace);

    const rebuilt = await domain.collections.thread.get({ id: "thread-a" });
    assertEquals(rebuilt?.lastEventId, undefined);
    assertEquals(rebuilt?.lastEventPosition, undefined);
  } finally {
    await engine.shutdown();
    await db.close();
  }
});
