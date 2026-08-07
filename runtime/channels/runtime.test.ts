import { assert, assertEquals, assertExists, assertRejects } from "@std/assert";

import { createTestDatabase, type TestDatabase } from "../testing/ominipg.ts";
import type { Agent } from "../resources/index.ts";
import { createEventNativeApp } from "../../server/event-native.ts";
import { createCopilotzApplication } from "../application/index.ts";
import type { CopilotzProcessorContext } from "../engine/index.ts";
import { createSqlSession } from "../events/index.ts";
import { definePlugin, defineProcessor } from "../plugins/index.ts";
import { createChannelRuntime } from "./runtime.ts";
import { createWebChannelPlugin } from "./web.ts";

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
    on: ["message.created"],
    delivery: "durable",
    async handle(event, context) {
      if (!event.durable || !event.subject) return;
      const message = await context.conversation.getMessage(event.subject.id);
      assertExists(message);
      if (message.sender.participantType !== "human") return;
      const agent = message.recipientIds.length
        ? await context.conversation.getParticipant(message.recipientIds[0])
        : null;
      assertExists(agent);
      const content = await context.content.prepare("Channel reply", {
        operationKey: "channel-reply-content",
      });
      await context.conversation.createMessage({
        id: `reply:${message.id}`,
        threadId: message.threadId,
        sender: {
          id: agent.id,
          externalId: agent.externalId,
          participantType: "agent",
          agentId: agent.agentId,
          name: agent.name,
        },
        recipientIds: [message.sender.id],
        content,
      }, { operationKey: "channel-reply-message" });
    },
  });
  return definePlugin({
    manifest: {
      id: "test.channel-reply",
      version: "1.0.0",
      provides: { processors: [processor.id] },
    },
    resources: { processors: [processor] },
  });
}

async function close(db: TestDatabase): Promise<void> {
  await db.close();
}

Deno.test("channel runtime normalizes web ingress, bootstraps graph identities, and delivers attachment outputs", async () => {
  const db = await createTestDatabase({ url: ":memory:" });
  const application = await createCopilotzApplication({
    session: createSqlSession(db),
    namespace: NAMESPACE,
    schema: SCHEMA,
    core: false,
    plugins: [
      replyPlugin(),
      createWebChannelPlugin({ defaultAgentIds: [supportAgent.id] }),
    ],
    resources: { agents: [supportAgent] },
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
          metadata: { channel: "web" },
        },
        participant: {
          externalId: "web-user-a",
          participantType: "human",
          name: "Web User",
        },
        input: {
          content: "Channel input",
          id: "channel-message-a",
          correlationId: "channel-run-a",
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
    const thread = await application.conversation.getThreadByExternalId(
      NAMESPACE,
      "web-thread-a",
    );
    assertExists(thread);
    assertEquals(thread.participants.length, 2);
    assertEquals(
      thread.participants.map((participant) => participant.participantType)
        .sort(),
      ["agent", "human"],
    );
    const messages = await application.conversation.listMessages(
      NAMESPACE,
      thread.id,
    );
    assertEquals(messages.map((message) => message.id), [
      "channel-message-a",
      "reply:channel-message-a",
    ]);
    const resolved = await application.content.resolver.getMany(
      messages[1].content,
      { namespace: NAMESPACE },
    );
    assertEquals(resolved[0].text, "Channel reply");

    const second = await createEventNativeApp(application).handle({
      resource: "channels",
      method: "POST",
      path: ["web"],
      body: {
        thread: { externalId: "web-thread-a" },
        participant: {
          externalId: "web-user-a",
          participantType: "human",
        },
        input: {
          content: "Second input",
          id: "channel-message-b",
        },
      },
      context: { callback() {} },
    });
    assertEquals(second, { status: 202, data: { accepted: true } });
    assertEquals(
      (await application.conversation.listParticipants(NAMESPACE)).length,
      2,
    );
    assertEquals(
      (await application.conversation.listThreads(NAMESPACE)).length,
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
    session: createSqlSession(db),
    namespace: NAMESPACE,
    schema: `${SCHEMA}_callback`,
    core: false,
    plugins: [createWebChannelPlugin()],
  });
  try {
    await application.conversation.createThread({
      namespace: NAMESPACE,
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
          input: { content: "No callback", id: "message-no-callback" },
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
