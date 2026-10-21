import { storageFixture } from "../../shared/testing/storage-plugin.ts";
import { assertEquals, assertRejects } from "@std/assert";
import { createTestDomainContext } from "../../shared/testing/context.ts";
import { createCopilotzApplication } from "../../../../runtime/application/index.ts";
import { createTestDatabase } from "../../../../runtime/testing/ominipg.ts";
import {} from "../../plugin.ts";
import { listThreadMessageRecords } from "../../shared/projections.ts";
import { type ActionContext, defineAction } from "@copilotz/copilotz/actions";
import type { ContentSequence } from "@copilotz/copilotz/content";
import { createThreadMessage } from "./index.ts";

const NAMESPACE = "tenant-thread-message";

Deno.test("thread-message retry refreshes membership and commits one complete reply after rollback", async () => {
  const db = await createTestDatabase({
    url: Deno.env.get("COPILOTZ_TEST_POSTGRES_URL") ?? ":memory:",
  });
  const schema = "core_thread_message_retry";
  let attempts = 0;
  const retryingMessage = defineAction({
    id: "test.thread-message-retry",
    async execute(input, context) {
      const wrapped: Pick<
        ActionContext,
        "collections" | "content" | "transaction"
      > = {
        collections: context.collections,
        content: context.content,
        async transaction(run, options) {
          attempts++;
          try {
            return await context.transaction(async (tx) => {
              const result = await run(tx);
              if (attempts === 1) {
                throw new Error(
                  "Collection 'thread' 'thread' changed while its mutation was prepared.",
                );
              }
              return result;
            }, options);
          } catch (error) {
            if (attempts === 1) {
              // The first write rolled back. Model a competing membership
              // commit before retry; recipient selection must be refreshed.
              await context.collections.thread.commands.addParticipant({
                id: "thread",
                participantId: "late",
              });
            }
            throw error;
          }
        },
      };
      return await createThreadMessage(input, wrapped);
    },
  });
  const application = await createCopilotzApplication({
    database: db,
    namespace: NAMESPACE,
    databaseSchema: schema,
    plugins: [storageFixture],
    actions: { retryingMessage },
  });
  try {
    const context = createTestDomainContext(application, NAMESPACE);
    await context.actions.createThread({
      id: "thread",
      participants: [{
        id: "human",
        externalId: "human",
        participantType: "human",
      }],
    });
    await context.collections.participant.create({
      id: "late",
      externalId: "late",
      participantType: "agent",
      agentId: "late",
      name: "Late agent",
      metadata: {},
    });
    const reply = "Full reply after a rolled-back attempt 🌎";
    await context.actions.retryingMessage({
      id: "reply",
      threadId: "thread",
      sender: { externalId: "new-sender", participantType: "job" },
      content: reply,
    });
    assertEquals(attempts, 2);
    const message = await context.collections.message.get({ id: "reply" });
    assertEquals(message?.recipientIds, ["late"]);
    assertEquals(
      (await context.collections.participant.queries.byExternalId({
        externalId: "new-sender",
      })).length,
      1,
    );
    const [body] = await application.content.resolver.getMany(
      message?.content as ContentSequence,
      { namespace: NAMESPACE },
    );
    assertEquals(new TextDecoder().decode(body.bytes), reply);
    assertEquals(
      (await application.events.list({ namespace: NAMESPACE, limit: 100 }))
        .filter((event) => event.type === "message.created").length,
      1,
    );
  } finally {
    await application.shutdown();
    await db.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await db.close();
  }
});

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

Deno.test("a message that names no recipients addresses the thread's agents", async () => {
  const db = await createTestDatabase({ url: ":memory:" });
  const application = await createCopilotzApplication({
    database: db,
    namespace: NAMESPACE,
    databaseSchema: "copilotz_thread_message_default_recipients",
    plugins: [storageFixture],
    engine: { retryBaseMs: 0, random: () => 0 },
  });
  try {
    const context = createTestDomainContext(application, NAMESPACE);
    const human = {
      id: "human-a",
      externalId: "human-a",
      participantType: "human",
    } as const;
    const agent = {
      id: "agent-a",
      externalId: "agent-a",
      participantType: "agent",
      agentId: "assistant",
      name: "Assistant",
    } as const;
    await context.actions.createThread({
      id: "thread-agent",
      participants: [human, agent],
    }, { operationKey: "thread-agent:create" });
    await context.actions.createThread({
      id: "thread-alone",
      participants: [human],
    }, { operationKey: "thread-alone:create" });
    const recipients = async (input: Record<string, unknown>) => {
      const created = await context.actions.createThreadMessage({
        threadId: "thread-agent",
        sender: human,
        content: "Hello",
        ...input,
      }, { operationKey: `message:${String(input.id)}` }) as {
        recipientIds: string[];
      };
      return created.recipientIds;
    };

    assertEquals(await recipients({ id: "message-default" }), ["agent-a"]);
    assertEquals(
      await recipients({ id: "message-explicit", recipientIds: ["human-a"] }),
      ["human-a"],
    );
    assertEquals(
      await recipients({ id: "message-explicit-none", recipientIds: [] }),
      [],
    );
    assertEquals(
      await recipients({
        id: "message-membership-none",
        membership: { participants: [], recipients: [] },
      }),
      [],
    );
    // The sender never addresses itself.
    assertEquals(
      await recipients({ id: "message-from-agent", sender: agent }),
      [],
    );
    const alone = await context.actions.createThreadMessage({
      id: "message-alone",
      threadId: "thread-alone",
      sender: human,
      content: "Anyone?",
    }, { operationKey: "message:alone" }) as { recipientIds: string[] };
    assertEquals(alone.recipientIds, []);
  } finally {
    await application.shutdown();
    await db.close();
  }
});

Deno.test("a visible message moves its thread's updatedAt in the same write; internal work does not", async () => {
  const db = await createTestDatabase({ url: ":memory:" });
  const application = await createCopilotzApplication({
    database: db,
    namespace: NAMESPACE,
    databaseSchema: "copilotz_thread_message_activity",
    plugins: [storageFixture],
    engine: { retryBaseMs: 0, random: () => 0 },
  });
  try {
    const context = createTestDomainContext(application, NAMESPACE);
    const human = {
      id: "human-a",
      externalId: "human-a",
      participantType: "human",
    } as const;
    for (const id of ["thread-old", "thread-new"]) {
      await context.actions.createThread({ id, participants: [human] }, {
        operationKey: `${id}:create`,
      });
    }
    const collections = application.collections.withScope({
      namespace: NAMESPACE,
    });
    const updatedAt = async (id: string) =>
      String((await collections.thread.get({ id }))?.updatedAt);
    const before = await updatedAt("thread-old");
    await new Promise((resolve) => setTimeout(resolve, 5));
    await context.actions.createThreadMessage({
      id: "message-internal",
      threadId: "thread-old",
      sender: human,
      visibility: { kind: "internal" },
      content: "Internal note",
    }, { operationKey: "message:internal" });
    assertEquals(await updatedAt("thread-old"), before, "internal work");
    await context.actions.createThreadMessage({
      id: "message-visible",
      threadId: "thread-old",
      sender: human,
      content: "Back to this one",
    }, { operationKey: "message:visible" });
    const after = await updatedAt("thread-old");
    assertEquals(after > before, true, `${after} > ${before}`);
    assertEquals(
      (await collections.thread.get({ id: "thread-old" }))?.lastMessageId,
      "message-visible",
    );
    // The thread that just had a message now leads a recent-first list.
    const recent = await collections.thread.list({
      order: { field: "updatedAt", direction: "desc" },
      limit: 2,
    });
    assertEquals(recent.map((thread) => thread.id), [
      "thread-old",
      "thread-new",
    ]);
    // Its own event keeps `thread.updated` processors out of every message.
    const types = (await application.events.list({
      namespace: NAMESPACE,
      limit: 200,
    })).map((event) => event.type);
    assertEquals(
      types.filter((type) => type === "thread.message-recorded").length,
      1,
    );
  } finally {
    await application.shutdown();
    await db.close();
  }
});
