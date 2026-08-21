import {
  coreFeatureAliases,
  message as coreMessage,
} from "@copilotz/copilotz/plugins/core";
import { assert, assertEquals, assertExists, assertRejects } from "@std/assert";
import {
  loadMessageRecord,
  loadParticipantRecord,
} from "../engine/collection-graph.ts";
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
import { definePlugin, defineProcessor } from "../plugins/index.ts";
import { coreCollectionsPlugin } from "../../plugins/core/plugin.ts";
import { createChannelRuntime } from "./runtime.ts";
import { createWebChannelPlugin } from "./web.ts";
import { createTestDatabase, type TestDatabase } from "../testing/ominipg.ts";
import type { Agent } from "../resources/index.ts";
import { createEventNativeApp } from "../../server/event-native.ts";
import { createCopilotzApplication } from "../application/index.ts";
import type { CopilotzProcessorContext } from "../engine/index.ts";

const SCHEMA = "copilotz_channel_runtime";
const NAMESPACE = "tenant-a";

const supportAgent: Agent = {
  id: "support",
  name: "Support",
  role: "support",
};

function replyPlugin() {
  const processor = defineProcessor<CopilotzProcessorContext>({
    id: "channel.reply",
    on: [{ eventType: "message.created" }],
    async handle(event, context) {
      if (!event.durable || !event.subject) return;
      const message = await loadMessageRecord(context, event.subject.id);
      assertExists(message);
      if (message.sender.participantType !== "human") return;
      const recipient = await loadParticipantRecord(
        context,
        message.recipientIds[0],
      );
      assertExists(recipient);
      const content = await context.content.prepare("Channel reply", {
        operationKey: "channel-reply-content",
      });
      const persisted = await context.content.materialize(content);
      await context.collections.message.create({
        id: `reply:${message.id}`,
        threadId: message.threadId,
        senderId: recipient.id,
        recipientIds: [message.sender.id],
        content: persisted,
      }, { operationKey: "channel-reply-message" });
      await context.content.linkOwner(`reply:${message.id}`, persisted);
    },
  });
  return definePlugin({
    id: "test.channel-reply",
    version: "1.0.0",
    processors: [processor],
  });
}

async function close(db: TestDatabase): Promise<void> {
  await db.close();
}

Deno.test("channel runtime normalizes web ingress, bootstraps graph identities, and delivers attachment outputs", async () => {
  const db = await createTestDatabase({ url: ":memory:" });
  const application = await createCopilotzApplication({
    database: db,
    namespace: NAMESPACE,
    databaseSchema: SCHEMA,
    core: false,
    canonicalCore: [coreCollectionsPlugin],
    plugins: [
      replyPlugin(),
      createWebChannelPlugin({ defaultAgentIds: [supportAgent.id] }),
    ],
    context: { agents: { [supportAgent.id]: supportAgent } },
  });
  const runtime = createChannelRuntime(application);
  try {
    assert(Object.isFrozen(runtime));
    assertEquals(runtime.list().map((channel) => channel.id), ["web"]);
    const outputs: Array<{ type: string; durable?: boolean }> = [];
    const dispatched = await runtime.dispatch(NAMESPACE, {
      method: "POST",
      headers: {},
      body: {
        thread: {
          externalId: "web-thread-a",
          name: "Web support",
          description: "Created by the Web channel",
          participants: [{
            externalId: "passive-observer",
            participantType: "job",
            name: "Observer",
          }],
          metadata: { channel: "web" },
        },
        participant: {
          externalId: "web-user-a",
          participantType: "human",
          name: "Web User",
        },
        input: {
          type: "copilotz.core.message.input",
          correlationId: "channel-run-a",
          payload: {
            thread: "web-thread-a",
            participant: {
              externalId: "web-user-a",
              participantType: "human",
              name: "Web User",
            },
            recipientIds: [supportAgent.id],
            content: [
              { type: "text", text: "Channel input" },
              {
                type: "image",
                dataBase64: btoa("image-bytes"),
                mediaType: "image/png",
                name: "fixture.png",
              },
            ],
            id: "channel-message-a",
          },
        },
      },
      route: { ingress: "web", egress: "web" },
      callback(output) {
        outputs.push(output as { type: string; durable?: boolean });
      },
    });
    assertEquals(dispatched.status, 202);
    assertEquals(dispatched.response, { accepted: true });
    assertEquals(dispatched.requestBound, true);
    assertEquals(dispatched.executions.length, 1);
    await dispatched.done;

    assertEquals(
      outputs.filter((output) => output.type === "message.created").length,
      2,
    );
    assert(
      outputs.every((output) =>
        !["TOKEN", "REASONING", "TOOL_CALL_DELTA"].includes(output.type)
      ),
    );
    const thread = await projectThreadByExternalId(
      application,
      NAMESPACE,
      "web-thread-a",
    );
    assertExists(thread);
    assertEquals(thread.name, "Web support");
    assertEquals(thread.description, "Created by the Web channel");
    assertEquals(thread.participants.length, 3);
    assertEquals(
      thread.participants.map((participant) => participant.participantType)
        .sort(),
      ["agent", "human", "job"],
    );
    const messages = await projectMessages(application, NAMESPACE, thread.id);
    assertEquals(messages.map((message) => message.id), [
      "channel-message-a",
      "reply:channel-message-a",
    ]);
    const resolved = await application.content.resolver.getMany(
      messages[1].content,
      { namespace: NAMESPACE },
    );
    assertEquals(resolved[0].text, "Channel reply");
    const inputContent = await application.content.resolver.getMany(
      messages[0].content,
      { namespace: NAMESPACE },
    );
    assertEquals(inputContent[0].text, "Channel input");
    assertEquals(inputContent[1].asset.mediaType, "image/png");
    assertEquals(
      new TextDecoder().decode(inputContent[1].bytes),
      "image-bytes",
    );

    const second = await createEventNativeApp(application).handle({
      resource: "channels",
      method: "POST",
      path: ["web"],
      body: {
        thread: {
          externalId: "web-thread-a",
          name: "Renamed Web support",
        },
        participant: {
          externalId: "web-user-a",
          participantType: "human",
        },
        input: coreMessage({
          thread: "web-thread-a",
          participant: {
            externalId: "web-user-a",
            participantType: "human",
          },
          recipientIds: [supportAgent.id],
          content: "Second input",
          id: "channel-message-b",
        }),
      },
      context: { callback() {} },
    });
    assertEquals(second, { status: 202, data: { accepted: true } });
    assertEquals(
      (await projectThreadById(application, NAMESPACE, thread.id))
        ?.name,
      "Renamed Web support",
    );
    assertEquals(
      (await projectParticipants(application, NAMESPACE)).length,
      3,
    );
    assertEquals(
      (await projectThreads(application, NAMESPACE)).length,
      1,
    );
  } finally {
    await application.shutdown();
    await close(db);
  }
});

Deno.test("request-bound channel delivery reports missing callbacks through done", async () => {
  const db = await createTestDatabase({ url: ":memory:" });
  const application = await createCopilotzApplication({
    database: db,
    namespace: NAMESPACE,
    databaseSchema: `${SCHEMA}_callback`,
    core: false,
    canonicalCore: [coreCollectionsPlugin],
    plugins: [createWebChannelPlugin()],
  });
  try {
    await createTestDomainContext(application, NAMESPACE, coreFeatureAliases)
      .features.thread
      .create({
        id: "thread-a",
        participants: [{
          id: "user-a",
          externalId: "user-a",
          participantType: "human",
        }],
      });
    const dispatched = await createChannelRuntime(application).dispatch(
      NAMESPACE,
      {
        method: "POST",
        headers: {},
        body: {
          thread: "thread-a",
          participant: "user-a",
          input: coreMessage({
            thread: "thread-a",
            participant: "user-a",
            content: "No callback",
            id: "message-no-callback",
          }),
        },
        route: { ingress: "web", egress: "web" },
      },
    );
    await assertRejects(
      () => dispatched.done,
      TypeError,
      "requires an output callback",
    );
  } finally {
    await application.shutdown();
    await close(db);
  }
});

Deno.test("channel core remains factory-first, runtime-neutral, and queue-free", async () => {
  for (const module of ["runtime.ts", "types.ts", "web.ts", "index.ts"]) {
    const source = await Deno.readTextFile(new URL(module, import.meta.url));
    assertEquals(/\bclass\s+\w+/.test(source), false, module);
    assertEquals(/\bDeno\b|\bBun\b|\bprocess\b/.test(source), false, module);
    assertEquals(/from\s+["']node:/.test(source), false, module);
    assertEquals(
      /unsafeGraph|queueId|queueTTL|ackMode/.test(source),
      false,
      module,
    );
    assertEquals(
      /\.query\s*\(|\bSELECT\b|\bINSERT\b/.test(source),
      false,
      module,
    );
    assertEquals(/server\//.test(source), false, module);
  }
});
