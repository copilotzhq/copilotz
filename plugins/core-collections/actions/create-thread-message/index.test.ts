import { assertEquals } from "@std/assert";
import { createTestDomainContext } from "../../../core/internal/testing/context.ts";
import { createCopilotzApplication } from "../../../../runtime/application/index.ts";
import { createTestDatabase } from "../../../../runtime/testing/ominipg.ts";
import { coreCollectionsPlugin } from "../../plugin.ts";

const NAMESPACE = "tenant-thread-message";

Deno.test("createThreadMessage ensures participant, membership, and message atomically", async () => {
  const db = await createTestDatabase({ url: ":memory:" });
  const application = await createCopilotzApplication({
    database: db,
    namespace: NAMESPACE,
    databaseSchema: "copilotz_thread_message_action",
    plugins: [coreCollectionsPlugin],
    engine: { retryBaseMs: 0, random: () => 0 },
  });
  try {
    const context = createTestDomainContext(application, NAMESPACE);
    await context.actions.createThread({
      id: "thread-a",
      participants: [{
        id: "human-a",
        externalId: "human-a",
        participantType: "human",
      }],
    }, { identity: { deduplicationId: "thread-a:create" } });
    assertEquals(typeof context.transaction, "function");

    await context.actions.createThreadMessage(
      {
        id: "message-human",
        threadId: "thread-a",
        sender: {
          id: "human-a",
          externalId: "human-a",
          participantType: "human",
        },
        content: "Already a member",
      },
      { operationKey: "thread-message:existing-member" },
    );
    assertEquals(
      (await application.events.list({ namespace: NAMESPACE, limit: 100 }))
        .filter((event) => event.type === "thread.updated").length,
      0,
    );

    const created = await context.actions.createThreadMessage(
      {
        id: "message-job",
        threadId: "thread-a",
        sender: {
          externalId: "copilotz.knowledge",
          participantType: "job",
          name: "RAG",
        },
        recipientIds: ["human-a"],
        content: "Action-owned content",
        metadata: { kind: "fixture" },
      },
      { operationKey: "thread-message:create" },
    ) as { id: string; senderId: string; threadId: string };
    assertEquals(created.id, "message-job");
    assertEquals(created.threadId, "thread-a");

    const collections = application.collections.withScope({
      namespace: NAMESPACE,
    });
    const sender = await collections.participant.queries.byExternalId({
      externalId: "copilotz.knowledge",
    });
    assertEquals(sender?.[0]?.id, created.senderId);
    assertEquals(sender?.[0]?.participantType, "job");

    const thread = await collections.thread.get({ id: "thread-a" });
    const participantIds = Array.isArray(thread?.participantIds)
      ? thread.participantIds
      : [];
    assertEquals(participantIds.includes("human-a"), true);
    assertEquals(participantIds.includes(created.senderId), true);

    const message = await collections.message.get({ id: "message-job" });
    assertEquals(message?.senderId, created.senderId);
    assertEquals(message?.metadata, { kind: "fixture" });
    assertEquals(
      (await application.events.list({ namespace: NAMESPACE, limit: 100 }))
        .filter((event) => event.type === "thread.updated").length,
      1,
    );
  } finally {
    await application.shutdown();
    await db.close();
  }
});
