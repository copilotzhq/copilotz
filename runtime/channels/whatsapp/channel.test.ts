import { assert, assertEquals, assertExists, assertThrows } from "@std/assert";

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
import {
  buildWhatsAppReplyButtonsMessage,
  createWhatsAppChannel,
  createWhatsAppChannelPlugin,
  normalizeWhatsAppReplyButtons,
  verifyWhatsAppSignature,
} from "./index.ts";
import type {
  WhatsAppConfig,
  WhatsAppMediaInput,
  WhatsAppTransport,
} from "./types.ts";

const NAMESPACE = "tenant-whatsapp";
const CONFIG: WhatsAppConfig = {
  accessToken: "test-token",
  phoneId: "default-phone-id",
  appSecret: "test-secret",
  webhookVerifyToken: "verify-me",
};
const agent: Agent = { id: "support", name: "Support", role: "support" };

function bytes(...values: number[]): Uint8Array {
  return new Uint8Array(values);
}

function mediaKind(mediaType: string) {
  if (mediaType.startsWith("image/")) return "image" as const;
  if (mediaType.startsWith("audio/")) return "audio" as const;
  if (mediaType.startsWith("video/")) return "video" as const;
  return "document" as const;
}

function fakeTransport() {
  const downloads: string[] = [];
  const uploads: WhatsAppMediaInput[] = [];
  const sends: Array<Readonly<Record<string, unknown>>> = [];
  const transport: WhatsAppTransport = Object.freeze({
    async download(_config, input) {
      downloads.push(input.id);
      return {
        bytes: bytes(1, 2, 3),
        mediaType: input.mediaType || "application/octet-stream",
        ...(input.name ? { name: input.name } : {}),
      };
    },
    async upload(_config, input) {
      uploads.push({
        ...input,
        bytes: input.bytes.slice(),
      });
      return {
        id: `uploaded-${uploads.length}`,
        type: mediaKind(input.mediaType),
      };
    },
    async send(_config, body) {
      sends.push(structuredClone(body));
      return { messages: [{ id: `outbound-${sends.length}` }] };
    },
  });
  return { transport, downloads, uploads, sends };
}

function replyPlugin() {
  const processor = defineProcessor<CopilotzProcessorContext>({
    id: "whatsapp.reply",
    on: ["message.created"],
    delivery: "durable",
    async handle(event, context) {
      if (!event.durable || event.subject?.type !== "message") return;
      const message = await context.conversation.getMessage(event.subject.id);
      assertExists(message);
      if (message.sender.participantType !== "human") return;
      const recipient = await context.conversation.getParticipant(
        message.recipientIds[0],
      );
      assertExists(recipient);
      await context.events.emit({
        type: "action.created",
        payload: {
          action: {
            type: "reply_buttons",
            message: "Choose",
            content: [{ text: "Yes", payload: "yes" }],
          },
        },
      });
      const content = await context.content.prepare([
        "Native WhatsApp reply",
        {
          type: "audio",
          bytes: bytes(9, 8, 7),
          mediaType: "audio/ogg",
          name: "answer.ogg",
        },
      ], { operationKey: "reply-content" });
      await context.conversation.createMessage({
        id: `reply:${message.id}`,
        threadId: message.threadId,
        sender: {
          id: recipient.id,
          externalId: recipient.externalId,
          participantType: "agent",
          agentId: recipient.agentId,
          name: recipient.name,
        },
        recipientIds: [message.sender.id],
        content,
      }, { operationKey: "reply-message" });
    },
  });
  return definePlugin({
    manifest: {
      id: "test.whatsapp-reply",
      version: "1.0.0",
      provides: { processors: [processor.id] },
    },
    resources: { processors: [processor] },
  });
}

async function signature(body: Uint8Array, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, body.slice().buffer),
  );
  return `sha256=${
    [...digest].map((value) => value.toString(16).padStart(2, "0")).join("")
  }`;
}

async function close(db: TestDatabase): Promise<void> {
  await db.close();
}

Deno.test("WhatsApp channel normalizes signed media ingress and native semantic egress", async () => {
  const db = await createTestDatabase({ url: ":memory:" });
  const fake = fakeTransport();
  const application = await createCopilotzApplication({
    session: createSqlSession(db),
    namespace: NAMESPACE,
    schema: "copilotz_v3_whatsapp",
    core: false,
    plugins: [
      replyPlugin(),
      createWhatsAppChannelPlugin({
        config: CONFIG,
        transport: fake.transport,
        defaultAgentIds: [agent.id],
      }),
    ],
    resources: { agents: [agent] },
  });
  const body = {
    entry: [{
      id: "business-a",
      changes: [{
        value: {
          metadata: { phone_number_id: "inbound-phone-id" },
          contacts: [{ profile: { name: "Vinicius" } }],
          messages: [{
            from: "5511999999999",
            id: "wamid.input-a",
            timestamp: "123",
            type: "audio",
            text: { body: "Please listen" },
            audio: { id: "media-in-a", mime_type: "audio/ogg" },
          }],
        },
      }],
    }],
  };
  const rawBody = new TextEncoder().encode(JSON.stringify(body));
  const headers = {
    "X-Hub-Signature-256": await signature(rawBody, CONFIG.appSecret!),
  };
  try {
    const runtime = createChannelRuntime(application);
    const dispatched = await runtime.dispatch(NAMESPACE, {
      method: "POST",
      headers,
      body,
      rawBody,
      route: { ingress: "whatsapp", egress: "whatsapp" },
    });
    assertEquals(dispatched.status, 200);
    assertEquals(dispatched.response, { status: "ok" });
    assertEquals(dispatched.requestBound, false);
    await dispatched.done;

    assertEquals(fake.downloads, ["media-in-a"]);
    assertEquals(fake.uploads.length, 1);
    assertEquals(fake.uploads[0].mediaType, "audio/ogg");
    assertEquals(fake.uploads[0].bytes, bytes(9, 8, 7));
    assertEquals(
      fake.sends.map((value) => value.type),
      ["interactive", "text", "audio"],
    );
    assertEquals(
      (fake.sends[0].interactive as Record<string, unknown>).type,
      "button",
    );
    assertEquals(fake.sends[1].text, { body: "Native WhatsApp reply" });
    assertEquals(fake.sends[2].audio, { id: "uploaded-1" });

    const thread = await application.conversation.getThreadByExternalId(
      NAMESPACE,
      "5511999999999",
    );
    assertExists(thread);
    assertEquals(thread.participants.length, 2);
    assertEquals(
      (thread.metadata.channels as Record<string, unknown>).whatsapp,
      {
        recipientPhone: "5511999999999",
        channelId: "inbound-phone-id",
        businessId: "business-a",
        userName: "Vinicius",
        lastInboundMessageId: "wamid.input-a",
      },
    );
    const messages = await application.conversation.listMessages(
      NAMESPACE,
      thread.id,
    );
    assertEquals(messages.map((value) => value.id), [
      "wamid.input-a",
      "reply:wamid.input-a",
    ]);
    const inbound = await application.content.resolver.getMany(
      messages[0].content,
      { namespace: NAMESPACE },
    );
    assertEquals(inbound.map((value) => value.ref.kind), ["text", "audio"]);
    assertEquals(inbound[0].text, "Please listen");
    assertEquals(inbound[1].bytes, bytes(1, 2, 3));

    const beforeRetry = fake.sends.length;
    const retry = await runtime.dispatch(NAMESPACE, {
      method: "POST",
      headers,
      body,
      rawBody,
      route: { ingress: "whatsapp", egress: "whatsapp" },
    });
    await retry.done;
    assertEquals(fake.sends.length, beforeRetry);
    assertEquals(
      (await application.conversation.listThreads(NAMESPACE)).length,
      1,
    );
    assertEquals(
      (await application.conversation.listMessages(NAMESPACE, thread.id))
        .length,
      2,
    );
  } finally {
    await application.shutdown();
    await close(db);
  }
});

Deno.test("WhatsApp webhook verification and HMAC fail closed", async () => {
  const fake = fakeTransport();
  const channel = createWhatsAppChannel({
    config: CONFIG,
    transport: fake.transport,
  });
  assertExists(channel.ingress);
  const accepted = await channel.ingress.handle({
    method: "GET",
    headers: {},
    query: {
      "hub.mode": "subscribe",
      "hub.verify_token": "verify-me",
      "hub.challenge": "challenge-a",
    },
    body: null,
    route: { ingress: "whatsapp", egress: "whatsapp" },
  }, {} as never);
  assertEquals(accepted, {
    status: 200,
    response: "challenge-a",
    inputs: [],
  });
  const body = new TextEncoder().encode("{}");
  const valid = await signature(body, CONFIG.appSecret!);
  assert(await verifyWhatsAppSignature(body, CONFIG.appSecret!, valid));
  assertEquals(
    await verifyWhatsAppSignature(
      new TextEncoder().encode("changed"),
      CONFIG.appSecret!,
      valid,
    ),
    false,
  );
  const denied = await channel.ingress.handle({
    method: "POST",
    headers: { "x-hub-signature-256": "sha256=00" },
    body: {},
    rawBody: body,
    route: { ingress: "whatsapp", egress: "whatsapp" },
  }, {} as never);
  assertEquals(denied.status, 403);
  assertEquals(denied.inputs, []);
});

Deno.test("WhatsApp protocol keeps reply constraints and stream limits explicit", async () => {
  assertEquals(
    normalizeWhatsAppReplyButtons([
      { text: "First option title that is too long", payload: "same" },
      { text: "Second", payload: "same" },
      { text: "Third" },
      { text: "Fourth" },
    ]),
    [
      { type: "reply", reply: { id: "same", title: "First option title t" } },
      { type: "reply", reply: { id: "same_2", title: "Second" } },
      { type: "reply", reply: { id: "third", title: "Third" } },
    ],
  );
  assertEquals(
    buildWhatsAppReplyButtonsMessage("5511", {
      type: "reply_buttons",
      message: "Choose",
      content: [{ text: "Yes", payload: "yes" }],
    })?.type,
    "interactive",
  );
  assertThrows(
    () =>
      createWhatsAppChannel({
        config: CONFIG,
        transport: fakeTransport().transport,
        maxStreamBytes: 0,
      }),
    TypeError,
    "maxStreamBytes",
  );
});

Deno.test("WhatsApp channel core is factory-first and runtime-neutral", async () => {
  const files = ["channel.ts", "protocol.ts", "transport.ts", "types.ts"];
  for (const file of files) {
    const source = await Deno.readTextFile(new URL(file, import.meta.url));
    assertEquals(/\bclass\s+[A-Za-z_$]/.test(source), false, file);
    assertEquals(source.includes("Deno."), false, file);
    assertEquals(source.includes("node:"), false, file);
    assertEquals(source.includes("server/"), false, file);
    assertEquals(source.includes("resources/channels"), false, file);
    assertEquals(source.includes("unsafeGraph"), false, file);
  }
});
