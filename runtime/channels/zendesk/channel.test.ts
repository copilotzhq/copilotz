import { assertEquals, assertExists } from "@std/assert";

import {
  createTestDatabase,
  type TestDatabase,
} from "../../testing/ominipg.ts";
import type { Agent } from "../../resources/index.ts";
import { createCopilotzApplication } from "../../application/index.ts";
import type { CopilotzProcessorContext } from "../../engine/index.ts";
import { createSqlSession } from "../../events/index.ts";
import { definePlugin, defineProcessor } from "../../plugins/index.ts";
import { createChannelRuntime } from "../runtime.ts";
import { createZendeskChannel, createZendeskChannelPlugin } from "./index.ts";
import type {
  ZendeskConfig,
  ZendeskMediaInput,
  ZendeskTransport,
} from "./types.ts";

const NAMESPACE = "tenant-zendesk";
const config: ZendeskConfig = {
  appId: "app-a",
  apiKey: "key-a",
  apiSecret: "secret-a",
  webhookSecret: "webhook-a",
  businessName: "Copilotz",
};
const agent: Agent = { id: "support", name: "Support", role: "support" };

function fakeTransport() {
  const downloads: string[] = [];
  const uploads: ZendeskMediaInput[] = [];
  const sends: Array<Readonly<Record<string, unknown>>> = [];
  const transport: ZendeskTransport = Object.freeze({
    async download(url) {
      downloads.push(url);
      return {
        bytes: new Uint8Array([0x4f, 0x67, 0x67, 0x53, 1]),
        mediaType: "application/octet-stream",
      };
    },
    async upload(_config, _conversationId, media) {
      uploads.push({ ...media, bytes: media.bytes.slice() });
      return {
        mediaUrl: `https://media.example/${uploads.length}`,
        mediaType: media.mediaType,
      };
    },
    async send(_config, _conversationId, body) {
      sends.push(structuredClone(body));
      return { id: `send-${sends.length}` };
    },
  });
  return { transport, downloads, uploads, sends };
}

function replyPlugin() {
  const processor = defineProcessor<CopilotzProcessorContext>({
    id: "zendesk.reply",
    on: ["message.created"],
    delivery: "durable",
    async handle(event, context) {
      if (!event.durable || event.subject?.type !== "message") return;
      const input = await context.conversation.getMessage(event.subject.id);
      assertExists(input);
      if (input.sender.participantType !== "human") return;
      const recipient = await context.conversation.getParticipant(
        input.recipientIds[0],
      );
      assertExists(recipient);
      await context.events.emit({
        type: "action.created",
        payload: {
          content: "Choose",
          action: {
            type: "reply_buttons",
            content: [{ text: "Continue", payload: "continue" }],
          },
        },
      });
      const content = await context.content.prepare([
        "Zendesk reply",
        {
          type: "image",
          bytes: new Uint8Array([1, 2, 3]),
          mediaType: "image/png",
          name: "reply.png",
        },
      ], { operationKey: "zendesk-reply-content" });
      await context.conversation.createMessage({
        id: `reply:${input.id}`,
        threadId: input.threadId,
        sender: {
          id: recipient.id,
          externalId: recipient.externalId,
          participantType: "agent",
          agentId: recipient.agentId,
          name: recipient.name,
        },
        recipientIds: [input.sender.id],
        content,
      }, { operationKey: "zendesk-reply-message" });
    },
  });
  return definePlugin({
    manifest: {
      id: "test.zendesk-reply",
      version: "1.0.0",
      provides: { processors: [processor.id] },
    },
    resources: { processors: [processor] },
  });
}

async function close(db: TestDatabase): Promise<void> {
  await db.close();
}

Deno.test("Zendesk channel preserves webhook identity, media, actions, and native egress", async () => {
  const db = await createTestDatabase({ url: ":memory:" });
  const fake = fakeTransport();
  const application = await createCopilotzApplication({
    session: createSqlSession(db),
    namespace: NAMESPACE,
    schema: "copilotz_v3_zendesk",
    core: false,
    plugins: [
      replyPlugin(),
      createZendeskChannelPlugin({
        config,
        transport: fake.transport,
        defaultAgentIds: [agent.id],
      }),
    ],
    resources: { agents: [agent] },
  });
  const body = {
    events: [{
      type: "conversation:message",
      payload: {
        conversation: { id: "conversation-a", type: "personal" },
        message: {
          id: "zendesk-message-a",
          author: {
            type: "user",
            displayName: "Vinicius",
            user: { id: "user-a", externalId: "external-user-a" },
          },
          content: {
            type: "file",
            text: "Voice note",
            mediaUrl: "https://media.example/input",
            mediaType: "application/octet-stream",
            fileName: "voice.ogg",
          },
          source: { integrationId: "integration-a" },
        },
      },
    }],
  };
  try {
    const result = await createChannelRuntime(application).dispatch(NAMESPACE, {
      method: "POST",
      headers: { "X-API-Key": "webhook-a" },
      body,
      route: { ingress: "zendesk", egress: "zendesk" },
    });
    assertEquals(result.status, 200);
    await result.done;
    assertEquals(fake.downloads, ["https://media.example/input"]);
    assertEquals(fake.uploads.map((value) => value.mediaType), ["image/png"]);
    assertEquals(
      fake.sends.map((value) =>
        (value.content as Record<string, unknown>).type
      ),
      ["text", "text", "image"],
    );
    assertEquals(
      (fake.sends[0].content as Record<string, unknown>).actions,
      [{ type: "reply", text: "Continue", payload: "continue" }],
    );
    const thread = await application.conversation.getThreadByExternalId(
      NAMESPACE,
      "conversation-a",
    );
    assertExists(thread);
    const messages = await application.conversation.listMessages(
      NAMESPACE,
      thread.id,
    );
    const inbound = await application.content.resolver.getMany(
      messages[0].content,
      { namespace: NAMESPACE },
    );
    assertEquals(inbound.map((value) => value.ref.kind), ["text", "audio"]);
    assertEquals(inbound[1].ref.mediaType, "audio/opus");
  } finally {
    await application.shutdown();
    await close(db);
  }
});

Deno.test("Zendesk webhook auth fails closed", async () => {
  const channel = createZendeskChannel({
    config,
    transport: fakeTransport().transport,
  });
  assertExists(channel.ingress);
  const result = await channel.ingress.handle({
    method: "POST",
    headers: { "x-api-key": "wrong" },
    body: { events: [] },
    route: { ingress: "zendesk", egress: "zendesk" },
  }, {} as never);
  assertEquals(result.status, 403);
  assertEquals(result.inputs, []);
});

Deno.test("Zendesk channel core is factory-first and runtime-neutral", async () => {
  for (const file of ["channel.ts", "transport.ts", "types.ts"]) {
    const source = await Deno.readTextFile(new URL(file, import.meta.url));
    assertEquals(/\bclass\s+[A-Za-z_$]/.test(source), false, file);
    assertEquals(source.includes("Deno."), false, file);
    assertEquals(source.includes("node:"), false, file);
    assertEquals(source.includes("server/"), false, file);
    assertEquals(source.includes("unsafeGraph"), false, file);
  }
});
