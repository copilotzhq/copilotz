import { storageFixture } from "../../shared/testing/storage-plugin.ts";
import { assertEquals, assertRejects } from "@std/assert";
import { createTestDomainContext } from "../../shared/testing/context.ts";
import { createCopilotzApplication } from "../../../../runtime/application/index.ts";
import { createTestDatabase } from "../../../../runtime/testing/ominipg.ts";
import {} from "../../plugin.ts";
import { listThreadMessageRecords } from "../../shared/projections.ts";

const NAMESPACE = "tenant-thread-message";

Deno.test("createThreadMessage ensures participant, membership, and message atomically", async () => {
  const db = await createTestDatabase({ url: ":memory:" });
  const application = await createCopilotzApplication({
    database: db,
    namespace: NAMESPACE,
    databaseSchema: "copilotz_thread_message_action",
    plugins: [storageFixture],
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
    const idOnlySender = await context.actions.createThreadMessage({
      id: "message-id-only-sender",
      threadId: "thread-a",
      sender: { id: "human-a" },
      content: "Existing sender by ID",
    }, { operationKey: "thread-message:id-only-sender" }) as {
      id: string;
      senderId: string;
    };
    assertEquals(idOnlySender.senderId, "human-a");
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

    const membershipMessage = await context.actions.createThreadMessage({
      id: "message-membership",
      threadId: "thread-a",
      sender: {
        externalId: "copilotz.batch",
        participantType: "job",
      },
      membership: {
        participants: [{
          externalId: " north ",
          participantType: "agent",
          agentId: "north",
          name: "North",
        }],
        recipients: [
          { externalId: "north" },
          { participantId: "human-a" },
        ],
      },
      content: "Batch membership",
    }, { operationKey: "thread-message:membership" }) as {
      id: string;
      senderId: string;
    };
    const north = await collections.participant.queries.byExternalId({
      externalId: "north",
    });
    assertEquals(north.length, 1);
    const membershipRecord = await collections.message.get({
      id: membershipMessage.id,
    });
    assertEquals(membershipRecord?.recipientIds, [north[0].id, "human-a"]);
    const membershipThread = await collections.thread.get({ id: "thread-a" });
    assertEquals(
      (membershipThread?.participantIds as string[]).includes(north[0].id),
      true,
    );

    const sharedSender = await context.actions.createThreadMessage({
      id: "message-shared-membership-sender",
      threadId: "thread-a",
      sender: {
        externalId: "shared-external",
        participantType: "job",
        name: "Shared",
      },
      membership: {
        participants: [{
          externalId: " shared-external ",
          participantType: "job",
          name: "Shared",
        }],
        recipients: [{ externalId: "shared-external" }],
      },
      content: "Sender is also a member",
    }, { operationKey: "thread-message:shared-membership-sender" }) as {
      id: string;
      senderId: string;
    };
    const sharedParticipants = await collections.participant.queries
      .byExternalId({ externalId: "shared-external" });
    assertEquals(sharedParticipants.length, 1);
    assertEquals(sharedSender.senderId, sharedParticipants[0].id);
    assertEquals(
      (await collections.message.get({ id: sharedSender.id }))?.recipientIds,
      [sharedParticipants[0].id],
    );

    const membershipIds = [north[0].id];
    await context.transaction(async (tx) => {
      await tx.collections.thread.commands.ensureMembership({
        id: "thread-a",
        participantIds: membershipIds,
      }, { operationKey: "membership:retry-receipt" });
    }, { operationKey: "membership:retry-workflow" });
    const beforeRemoval = await collections.thread.get({ id: "thread-a" });
    const withoutNorth = (beforeRemoval?.participantIds as string[]).filter(
      (participantId) => participantId !== north[0].id,
    );
    await collections.thread.update({
      id: "thread-a",
      set: { participantIds: withoutNorth },
    }, { operationKey: "membership:remove-north" });
    await context.transaction(async (tx) => {
      await tx.collections.thread.commands.ensureMembership({
        id: "thread-a",
        participantIds: membershipIds,
      }, { operationKey: "membership:retry-receipt" });
    }, { operationKey: "membership:retry-workflow" });
    assertEquals(
      ((await collections.thread.get({ id: "thread-a" }))
        ?.participantIds as string[]).includes(north[0].id),
      false,
    );
    await assertRejects(
      () =>
        context.transaction(async (tx) => {
          await tx.collections.thread.commands.ensureMembership({
            id: "thread-a",
            participantIds: ["human-a", north[0].id].sort(),
          }, { operationKey: "membership:retry-receipt" });
        }, { operationKey: "membership:retry-workflow" }),
      Error,
      "was reused with another intent",
    );

    const beforeRollbackThread = await collections.thread.get({
      id: "thread-a",
    });
    const collectionEventTypes = new Set([
      "participant.created",
      "thread.updated",
      "message.created",
    ]);
    const beforeRollbackEvents = (await application.events.list({
      namespace: NAMESPACE,
      limit: 200,
    })).filter((event) => collectionEventTypes.has(event.type))
      .map((event) => [event.type, event.id]);
    await assertRejects(() =>
      context.actions.createThreadMessage({
        id: "message-human",
        threadId: "thread-a",
        sender: {
          externalId: "rollback-sender",
          participantType: "job",
        },
        membership: {
          participants: [{
            externalId: "rollback-agent",
            participantType: "agent",
            agentId: "rollback-agent",
          }],
          recipients: [],
        },
        content: "This duplicate message ID must roll back",
      }, { operationKey: "thread-message:rollback" })
    );
    assertEquals(
      (await collections.participant.queries.byExternalId({
        externalId: "rollback-sender",
      })).length,
      0,
    );
    assertEquals(
      (await collections.participant.queries.byExternalId({
        externalId: "rollback-agent",
      })).length,
      0,
    );
    assertEquals(
      (await collections.thread.get({ id: "thread-a" }))?.participantIds,
      beforeRollbackThread?.participantIds,
    );
    assertEquals(
      (await application.events.list({ namespace: NAMESPACE, limit: 200 }))
        .filter((event) => collectionEventTypes.has(event.type))
        .map((event) => [event.type, event.id]),
      beforeRollbackEvents,
    );

    const directEnrollment = await context.actions.addThreadParticipant({
      threadId: "thread-a",
      participant: {
        externalId: "direct-agent",
        participantType: "agent",
        agentId: "direct-agent",
      },
    }, { operationKey: "membership:direct-enrollment" }) as {
      participant: { id: string };
      thread: { participantIds: string[] };
    };
    assertEquals(
      directEnrollment.thread.participantIds.includes(
        directEnrollment.participant.id,
      ),
      true,
    );

    await context.actions.createThreadMessage({
      id: "message-internal-turn",
      threadId: "thread-a",
      sender: {
        externalId: "copilotz.maintenance",
        participantType: "job",
      },
      recipientIds: ["human-a"],
      content: "Private task",
      visibility: { kind: "internal" },
      historyScopeId: "turn:maintenance-a",
    }, { operationKey: "thread-message:internal-turn" });
    const publicHistory = await collections.message.queries.history({
      threadId: "thread-a",
      limit: 100,
    });
    assertEquals(publicHistory.map((item) => item.id), [
      "message-human",
      "message-id-only-sender",
      "message-job",
      "message-membership",
      "message-shared-membership-sender",
    ]);
    const scoped = await listThreadMessageRecords(context, "thread-a", {
      historyScopeId: "turn:maintenance-a",
    });
    assertEquals(scoped.map((item) => item.id), [
      "message-human",
      "message-id-only-sender",
      "message-job",
      "message-membership",
      "message-shared-membership-sender",
      "message-internal-turn",
    ]);
  } finally {
    await application.shutdown();
    await db.close();
  }
});
