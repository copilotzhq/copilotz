import { coreFeatureAliases } from "@copilotz/copilotz/plugins/core";
import { assert, assertEquals, assertRejects } from "@std/assert";

import { coreCollectionsPlugin } from "../../plugins/core/plugin.ts";
import { createSqlSession } from "../events/index.ts";
import { createPluginRegistry, definePlugin } from "../plugins/index.ts";
import { createTestDatabase } from "../testing/ominipg.ts";
import { createCopilotzEngine } from "./index.ts";
import { createTestDomainContext } from "../../runtime/testing/domain-context.ts";
import {
  projectLlmAttempts,
  projectMessageById,
  projectMessages,
  projectParticipants,
  projectThreadByExternalId,
  projectThreadById,
  projectThreads,
  projectToolExecutionById,
  projectToolExecutions,
} from "../../runtime/testing/projections.ts";

const NAMESPACE = "tenant-collection-ingress-slice-2";

Deno.test("engine conversation factories are gone; messages still use the thread-message feature", async () => {
  await assertRejects(
    () => Deno.stat(new URL("./core-records.ts", import.meta.url)),
    Deno.errors.NotFound,
  );
  const attachment = await Deno.readTextFile(
    new URL("../attachments/attachment.ts", import.meta.url),
  );
  assertEquals(
    attachment.includes("requireFeatureActions"),
    true,
  );
  assertEquals(
    attachment.includes("copilotz.core.thread-message"),
    true,
  );
});

Deno.test("createMessage ensures a new sender through the thread-message feature", async () => {
  const db = await createTestDatabase({ url: ":memory:" });
  const engine = await createCopilotzEngine({
    session: createSqlSession(db),
    registry: await createPluginRegistry({
      plugins: [coreCollectionsPlugin],
    }),
    defaultDatabaseSchema: "copilotz_collection_ingress_slice2",
    retryBaseMs: 0,
    random: () => 0,
  });
  try {
    const domain = createTestDomainContext(
      engine,
      NAMESPACE,
      coreFeatureAliases,
    );
    await domain.features.thread.create({
      id: "thread-a",
      participants: [{
        id: "human-a",
        externalId: "human-a",
        participantType: "human",
      }],
    }, { identity: { deduplicationId: "thread-a:create" } });
    const content = await engine.content.preparer.prepare("slice two", {
      namespace: NAMESPACE,
      idempotencyKey: "message-job:content",
    });
    const created = await domain.features.threadMessage.create({
      id: "message-job",
      threadId: "thread-a",
      sender: {
        externalId: "copilotz.knowledge",
        participantType: "job",
        name: "RAG",
      },
      recipientIds: ["human-a"],
      content,
    }, { identity: { deduplicationId: "message-job:create" } }) as {
      id: string;
      senderId: string;
      content: readonly unknown[];
    };
    const [createdEvent] = (await engine.events.list({
      namespace: NAMESPACE,
      threadId: "thread-a",
      limit: 100,
    })).filter((event) => event.subject?.id === "message-job");
    assertEquals(createdEvent.type, "message.created");
    assertEquals(created.id, "message-job");
    assert(Object.isFrozen(createdEvent));
    assert(Object.isFrozen(createdEvent.payload));

    const sender = await domain.collections.participant.queries.byExternalId({
      externalId: "copilotz.knowledge",
    });
    assertEquals(sender?.[0]?.participantType, "job");
    assertEquals(created.senderId, sender?.[0]?.id);

    const thread = await projectThreadById(engine, NAMESPACE, "thread-a");
    const participantIds = (thread?.participants ?? []).map((item) => item.id);
    assertEquals(participantIds.includes("human-a"), true);
    assertEquals(participantIds.includes(created.senderId), true);

    const replay = await domain.features.threadMessage.create({
      id: "message-job",
      threadId: "thread-a",
      sender: {
        externalId: "copilotz.knowledge",
        participantType: "job",
        name: "RAG",
      },
      recipientIds: ["human-a"],
      content,
    }, { identity: { deduplicationId: "message-job:create" } }) as {
      id: string;
    };
    const replayEvents = (await engine.events.list({
      namespace: NAMESPACE,
      threadId: "thread-a",
      limit: 100,
    })).filter((event) => event.subject?.id === "message-job");
    assertEquals(replayEvents.length, 1);
    assertEquals(replayEvents[0].id, createdEvent.id);
    assertEquals(replay.id, created.id);

    const conflictingContent = await engine.content.preparer.prepare(
      "different slice two content",
      {
        namespace: NAMESPACE,
        idempotencyKey: "message-job:conflicting-content",
      },
    );
    await assertRejects(
      () =>
        domain.features.threadMessage.create({
          id: "message-job",
          threadId: "thread-a",
          sender: {
            externalId: "copilotz.knowledge",
            participantType: "job",
            name: "RAG",
          },
          recipientIds: ["human-a"],
          content: conflictingContent,
        }, { identity: { deduplicationId: "message-job:create" } }),
      Error,
      "different collection mutation",
    );
    assertEquals(
      (await projectMessageById(engine, NAMESPACE, "message-job"))
        ?.content,
      created.content,
    );
  } finally {
    await engine.shutdown();
    await db.close();
  }
});

Deno.test("createMessage fails when the thread-message feature is not bound", async () => {
  const collectionsOnly = definePlugin({
    id: "test.core-collections-without-thread-message",
    version: coreCollectionsPlugin.manifest.version,
    collections: coreCollectionsPlugin.resources.collections,
    features: [],
  });
  const db = await createTestDatabase({ url: ":memory:" });
  const engine = await createCopilotzEngine({
    session: createSqlSession(db),
    registry: await createPluginRegistry({
      plugins: [collectionsOnly],
    }),
    defaultDatabaseSchema: "copilotz_collection_ingress_slice2_unbound",
    retryBaseMs: 0,
    random: () => 0,
  });
  try {
    const domain = createTestDomainContext(
      engine,
      NAMESPACE,
    );
    await domain.collections.participant.create({
      id: "human-a",
      externalId: "human-a",
      participantType: "human",
    });
    await domain.collections.thread.create({
      id: "thread-a",
      participantIds: ["human-a"],
    });
    const content = await engine.content.preparer.prepare("unbound", {
      namespace: NAMESPACE,
      idempotencyKey: "unbound:content",
    });
    await assertRejects(
      async () =>
        await domain.features.threadMessage.create({
          id: "message-unbound",
          threadId: "thread-a",
          sender: {
            id: "human-a",
            externalId: "human-a",
            participantType: "human",
          },
          content,
        }),
      Error,
    );
  } finally {
    await engine.shutdown();
    await db.close();
  }
});
