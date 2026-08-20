import { assertEquals, assertExists } from "@std/assert";
import {
  createTestDatabase,
  type TestDatabase,
} from "../../testing/ominipg.ts";
import { createTestDomainContext } from "../../../runtime/testing/domain-context.ts";
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
} from "../../../runtime/testing/projections.ts";
import type { Agent } from "../../resources/index.ts";
import { createCopilotzApplication } from "../../application/index.ts";
import type { CopilotzProcessorContext } from "../../engine/index.ts";
import {
  loadMessageRecord,
  loadParticipantRecord,
} from "../../engine/collection-graph.ts";
import { definePlugin, defineProcessor } from "../../plugins/index.ts";
import { coreCollectionsPlugin } from "../../../plugins/core/plugin.ts";
import { createChannelRuntime } from "../runtime.ts";
import { createTelegramChannel, createTelegramChannelPlugin } from "./index.ts";
import type {
  TelegramConfig,
  TelegramMediaInput,
  TelegramTransport,
} from "./types.ts";

const NAMESPACE = "tenant-telegram";
const config: TelegramConfig = {
  botToken: "bot-token",
  secretToken: "webhook-token",
};
const agent: Agent = { id: "support", name: "Support", role: "support" };

function fakeTransport() {
  const downloads: string[] = [];
  const calls: Array<
    { method: string; body: Readonly<Record<string, unknown>> }
  > = [];
  const media: TelegramMediaInput[] = [];
  const transport: TelegramTransport = Object.freeze({
    async call(_config, method, body) {
      calls.push({ method, body: structuredClone(body) });
      return { ok: true };
    },
    async download(_config, fileId) {
      downloads.push(fileId);
      return { bytes: new Uint8Array([1, 2]), mediaType: "image/jpeg" };
    },
    async sendMedia(_config, _chatId, value) {
      media.push({ ...value, bytes: value.bytes.slice() });
      return { ok: true };
    },
  });
  return { transport, downloads, calls, media };
}

function replyPlugin() {
  const processor = defineProcessor<CopilotzProcessorContext>({
    id: "telegram.reply",
    on: [{ eventType: "message.created" }],
    async handle(event, context) {
      if (!event.durable || event.subject?.type !== "message") return;
      const input = await loadMessageRecord(context, event.subject.id);
      assertExists(input);
      if (input.sender.participantType !== "human") return;
      const recipient = await loadParticipantRecord(
        context,
        input.recipientIds[0],
      );
      assertExists(recipient);
      await context.events.emit({
        type: "action.created",
        payload: {
          action: {
            type: "reply_buttons",
            message: "Choose",
            content: [{ text: "Open", payload: "open" }],
          },
        },
      });
      const content = await context.content.prepare([
        "Telegram reply",
        {
          type: "audio",
          bytes: new Uint8Array([9, 8]),
          mediaType: "audio/ogg",
        },
      ], { operationKey: "telegram-reply-content" });
      const persisted = await context.content.materialize(content);
      await context.collections.message.create({
        id: `reply:${input.id}`,
        threadId: input.threadId,
        senderId: recipient.id,
        recipientIds: [input.sender.id],
        content: persisted,
      }, { operationKey: "telegram-reply-message" });
      await context.content.linkOwner(`reply:${input.id}`, persisted);
    },
  });
  return definePlugin({
    manifest: {
      id: "test.telegram-reply",
      version: "1.0.0",
      provides: { processors: [processor.id] },
    },
    resources: { processors: [processor] },
  });
}

async function close(db: TestDatabase): Promise<void> {
  await db.close();
}

Deno.test("Telegram channel preserves identity, canonical media, buttons, and native egress", async () => {
  const db = await createTestDatabase({ url: ":memory:" });
  const fake = fakeTransport();
  const application = await createCopilotzApplication({
    database: db,
    namespace: NAMESPACE,
    databaseSchema: "copilotz_v3_telegram",
    core: false,
    canonicalCore: [coreCollectionsPlugin],
    plugins: [
      replyPlugin(),
      createTelegramChannelPlugin({
        config,
        transport: fake.transport,
        defaultAgentIds: [agent.id],
      }),
    ],
    resources: { agents: [agent] },
  });
  try {
    const result = await createChannelRuntime(application).dispatch(NAMESPACE, {
      method: "POST",
      headers: { "X-Telegram-Bot-Api-Secret-Token": "webhook-token" },
      body: {
        update_id: 10,
        message: {
          message_id: 20,
          chat: { id: -1001 },
          from: { id: 42, username: "vinicius" },
          caption: "A photo",
          photo: [{ file_id: "small" }, { file_id: "large" }],
        },
      },
      route: { ingress: "telegram", egress: "telegram" },
    });
    await result.done;
    assertEquals(fake.downloads, ["large"]);
    assertEquals(fake.calls.map((value) => value.method), [
      "sendMessage",
      "sendMessage",
    ]);
    assertEquals(fake.calls[0].body.reply_markup, {
      inline_keyboard: [[{ text: "Open", callback_data: "open" }]],
    });
    assertEquals(fake.calls[1].body.text, "Telegram reply");
    assertEquals(fake.media.map((value) => value.mediaType), ["audio/ogg"]);
    const thread = await projectThreadByExternalId(
      application,
      NAMESPACE,
      "-1001",
    );
    assertExists(thread);
    const messages = await projectMessages(application, NAMESPACE, thread.id);
    assertEquals(messages[0].id, "telegram:-1001:20");
    const inbound = await application.content.resolver.getMany(
      messages[0].content,
      { namespace: NAMESPACE },
    );
    assertEquals(inbound.map((value) => value.ref.kind), ["text", "image"]);
  } finally {
    await application.shutdown();
    await close(db);
  }
});

Deno.test("Telegram callback ingress and webhook auth fail closed", async () => {
  const fake = fakeTransport();
  const channel = createTelegramChannel({ config, transport: fake.transport });
  assertExists(channel.ingress);
  const denied = await channel.ingress.handle({
    method: "POST",
    headers: { "x-telegram-bot-api-secret-token": "wrong" },
    body: {},
    route: { ingress: "telegram", egress: "telegram" },
  }, {} as never);
  assertEquals(denied.status, 403);
  const accepted = await channel.ingress.handle({
    method: "POST",
    headers: { "x-telegram-bot-api-secret-token": "webhook-token" },
    body: {
      callback_query: {
        id: "callback-a",
        from: { id: 42, first_name: "V" },
        data: "selected",
        message: { chat: { id: 7 } },
      },
    },
    route: { ingress: "telegram", egress: "telegram" },
  }, {} as never);
  assertEquals(accepted.inputs?.[0].input, {
    content: "selected",
    id: "telegram:callback:callback-a",
    correlationId: "telegram:callback:callback-a",
    deduplicationId: "telegram:callback:callback-a",
    metadata: { provider: "telegram", callbackQueryId: "callback-a" },
  });
});

Deno.test("Telegram channel core is factory-first and runtime-neutral", async () => {
  for (const file of ["channel.ts", "transport.ts", "types.ts"]) {
    const source = await Deno.readTextFile(new URL(file, import.meta.url));
    assertEquals(/\bclass\s+[A-Za-z_$]/.test(source), false, file);
    assertEquals(source.includes("Deno."), false, file);
    assertEquals(source.includes("node:"), false, file);
    assertEquals(source.includes("server/"), false, file);
    assertEquals(source.includes("unsafeGraph"), false, file);
  }
});
