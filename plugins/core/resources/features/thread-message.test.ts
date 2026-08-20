import { assertEquals } from "@std/assert";
import { THREAD_MESSAGE_FEATURE_ID } from "./thread-message.ts";
import { createTestDomainContext } from "../../../../runtime/testing/domain-context.ts";
import { createCopilotzApplication } from "../../../../runtime/application/index.ts";
import { createFeatureContext } from "../../../../runtime/features/index.ts";
import { createTestDatabase } from "../../../../runtime/testing/ominipg.ts";
import { coreCollectionsPlugin } from "../../plugin.ts";

const NAMESPACE = "tenant-thread-message";

Deno.test("thread-message feature ensures participant, membership, and message in one invoke", async () => {
  const db = await createTestDatabase({ url: ":memory:" });
  const application = await createCopilotzApplication({
    database: db,
    namespace: NAMESPACE,
    databaseSchema: "copilotz_thread_message_feature",
    core: false,
    canonicalCore: [coreCollectionsPlugin],
    engine: { retryBaseMs: 0, random: () => 0 },
  });
  try {
    await createTestDomainContext(application, NAMESPACE).features.thread
      .create({
        id: "thread-a",
        participants: [{
          id: "human-a",
          externalId: "human-a",
          participantType: "human",
        }],
      }, { identity: { deduplicationId: "thread-a:create" } });
    const context = createFeatureContext({
      namespace: NAMESPACE,
      plugins: application.plugins,
      collectionRuntime: application.collectionRuntime,
      contentResolver: application.content.resolver,
      events: application.events,
      deliveries: application.deliveries,
      relations: application.relations,
    });
    assertEquals("transaction" in context, false);
    const created = await context.features.threadMessage.create(
      {
        id: "message-job",
        threadId: "thread-a",
        sender: {
          externalId: "copilotz.knowledge",
          participantType: "job",
          name: "RAG",
        },
        recipientIds: ["human-a"],
        content: [],
        metadata: { kind: "fixture" },
      },
      { operationKey: "thread-message:create" },
    ) as { id: string; senderId: string; threadId: string };
    assertEquals(created.id, "message-job");
    assertEquals(created.threadId, "thread-a");

    const collections = application.collectionRuntime.withScope({
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
  } finally {
    await application.shutdown();
    await db.close();
  }
});
