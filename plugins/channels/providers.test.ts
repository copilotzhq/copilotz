import type { ResolvedContent } from "@copilotz/copilotz/content";
import { assert, assertEquals, assertExists } from "@std/assert";
import {
  createDiscordChannelAdapter,
  createDiscordChannelResource,
} from "../channel-discord/index.ts";
import type {
  DiscordConfig,
  DiscordMediaInput,
  DiscordTransport,
} from "../channel-discord/index.ts";
import {
  createTelegramChannelAdapter,
  createTelegramChannelResource,
} from "../channel-telegram/index.ts";
import type {
  TelegramConfig,
  TelegramMediaInput,
  TelegramTransport,
} from "../channel-telegram/index.ts";
import {
  buildWhatsAppMediaCarouselMessage,
  buildWhatsAppReplyButtonsMessage,
  normalizeWhatsAppReplyButtons,
  resolveWhatsAppMediaCarouselAction,
  splitWhatsAppText,
} from "../channel-whatsapp/index.ts";
import {
  createWhatsAppChannelAdapter,
  createWhatsAppChannelResource,
} from "../channel-whatsapp/index.ts";
import { verifyWhatsAppSignature } from "../channel-whatsapp/index.ts";
import type {
  WhatsAppConfig,
  WhatsAppMediaInput,
  WhatsAppTransport,
} from "../channel-whatsapp/index.ts";
import {
  createZendeskChannelAdapter,
  createZendeskChannelResource,
} from "../channel-zendesk/index.ts";
import type {
  ZendeskConfig,
  ZendeskMediaInput,
  ZendeskTransport,
} from "../channel-zendesk/index.ts";
import type {
  ChannelAcceptContext,
  ChannelDeliveryAttempt,
  ChannelDeliveryContext,
  ChannelJsonObject,
  ChannelRequest,
  ChannelResource,
} from "../channel-core/internal/contracts.ts";

const NAMESPACE = "channel-provider-contract";

function request(
  input: Partial<ChannelRequest> & Pick<ChannelRequest, "method" | "body">,
): ChannelRequest {
  return Object.freeze({
    method: input.method,
    headers: Object.freeze({ ...(input.headers ?? {}) }),
    body: input.body,
    ...(input.query ? { query: input.query } : {}),
    ...(input.rawBody ? { rawBody: input.rawBody.slice() } : {}),
  });
}

function acceptContext(
  channelId: string,
  channel: ChannelResource,
): ChannelAcceptContext {
  return Object.freeze({
    namespace: NAMESPACE,
    channelId,
    channel,
    signal: new AbortController().signal,
    now: () => new Date("2026-08-23T12:00:00.000Z"),
  });
}

function deliveryContext(
  channelId: string,
  channel: ChannelResource,
): ChannelDeliveryContext {
  return Object.freeze({
    namespace: NAMESPACE,
    channelId,
    channel,
    signal: new AbortController().signal,
    now: () => new Date("2026-08-23T12:00:00.000Z"),
  });
}

function resolved(
  kind: "text" | "image" | "audio" | "video" | "file",
  input: Readonly<{
    text?: string;
    bytes?: Uint8Array;
    mediaType?: string;
    name?: string;
  }>,
): ResolvedContent {
  const bytes = input.bytes?.slice() ?? new TextEncoder().encode(input.text);
  const mediaType = input.mediaType ??
    (kind === "text"
      ? "text/plain; charset=utf-8"
      : "application/octet-stream");
  return Object.freeze({
    ref: Object.freeze({
      assetId: `asset-${kind}-${bytes.length}`,
      kind,
      role: "body",
      mediaType,
      ...(input.name ? { name: input.name } : {}),
    }),
    asset: Object.freeze({}) as never,
    bytes,
    ...(input.text ? { text: input.text } : {}),
  });
}

function attempt(
  channelId: string,
  route: ChannelJsonObject,
  content: readonly ResolvedContent[],
  message: ChannelJsonObject = Object.freeze({}),
): ChannelDeliveryAttempt {
  return Object.freeze({
    intent: Object.freeze({
      deliveryKey: `delivery-${channelId}`,
      bindingId: `binding-${channelId}`,
      channelId,
      externalThreadId: `external-${channelId}`,
      threadId: `thread-${channelId}`,
      messageId: `message-${channelId}`,
      route,
      sender: Object.freeze({
        id: "agent-participant",
        externalId: "support",
        participantType: "agent" as const,
        agentId: "support",
      }),
      content: Object.freeze(content.map((item) => item.ref)),
      metadata: Object.freeze({ message }),
    }),
    content: Object.freeze(content),
  });
}

function hex(value: ArrayBuffer | Uint8Array): string {
  return [...new Uint8Array(value)].map((byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}

async function discordSigningFixture(): Promise<
  Readonly<{
    config: DiscordConfig;
    headers(body: Uint8Array): Promise<Readonly<Record<string, string>>>;
  }>
> {
  const keys = await crypto.subtle.generateKey(
    { name: "Ed25519" },
    true,
    ["sign", "verify"],
  ) as CryptoKeyPair;
  const publicKey = hex(await crypto.subtle.exportKey("raw", keys.publicKey));
  return Object.freeze({
    config: Object.freeze({
      applicationId: "discord-application",
      publicKey,
      botToken: "discord-bot-secret",
    }),
    async headers(body) {
      const timestamp = "1787428800";
      const prefix = new TextEncoder().encode(timestamp);
      const signed = new Uint8Array(prefix.length + body.length);
      signed.set(prefix);
      signed.set(body, prefix.length);
      return Object.freeze({
        "x-signature-ed25519": hex(
          await crypto.subtle.sign("Ed25519", keys.privateKey, signed),
        ),
        "x-signature-timestamp": timestamp,
      });
    },
  });
}

async function hmac(body: Uint8Array, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return `sha256=${
    hex(await crypto.subtle.sign("HMAC", key, body.slice().buffer))
  }`;
}

Deno.test("Telegram Adapter fails webhook auth closed and lowers callbacks without provider I/O", async () => {
  const calls: string[] = [];
  const transport: TelegramTransport = Object.freeze({
    call(_config, method, _body) {
      calls.push(method);
      return Promise.resolve(Object.freeze({ ok: true }));
    },
    download() {
      return Promise.reject(new Error("callback must not download media"));
    },
    sendMedia() {
      return Promise.resolve(Object.freeze({ ok: true }));
    },
  });
  const config: TelegramConfig = Object.freeze({
    botToken: "telegram-bot-secret",
    secretToken: "telegram-webhook-secret",
  });
  const resource = createTelegramChannelResource();
  const adapter = createTelegramChannelAdapter({ config, transport });
  const denied = await adapter.accept(
    request({
      method: "POST",
      headers: { "x-telegram-bot-api-secret-token": "wrong" },
      body: {},
    }),
    acceptContext("telegram", resource),
  );
  assertEquals(denied.status, 403);
  assertEquals(denied.occurrences, []);

  const accepted = await adapter.accept(
    request({
      method: "POST",
      headers: {
        "x-telegram-bot-api-secret-token": config.secretToken!,
      },
      body: {
        callback_query: {
          id: "callback-a",
          from: { id: "user-a", first_name: "Alice" },
          data: "selected",
          message: { chat: { id: "chat-a" } },
        },
      },
    }),
    acceptContext("telegram", resource),
  );
  assertEquals(accepted.occurrences.length, 1);
  assertEquals(
    accepted.occurrences[0].id,
    'telegram:["callback","callback-a"]',
  );
  const received = await adapter.receive(
    accepted.occurrences[0].input,
    Object.freeze({
      ...acceptContext("telegram", resource),
      occurrenceId: accepted.occurrences[0].id,
    }),
  );
  assertEquals(received.externalThreadId, "chat-a");
  assertEquals(received.sender.externalId, "user-a");
  assertEquals(received.content, "selected");
  assertEquals(received.route, { chatId: "chat-a" });
  assertEquals(calls, []);
});

Deno.test("Telegram Adapter emits native text, media, and reply-button payloads", async () => {
  const calls: Array<
    Readonly<{ method: string; body: Record<string, unknown> }>
  > = [];
  const media: TelegramMediaInput[] = [];
  const transport: TelegramTransport = Object.freeze({
    call(_config, method, body) {
      calls.push(Object.freeze({ method, body: structuredClone(body) }));
      return Promise.resolve(Object.freeze({
        result: Object.freeze({ message_id: `telegram-${calls.length}` }),
      }));
    },
    download() {
      return Promise.resolve(null);
    },
    sendMedia(_config, _chatId, input) {
      media.push(Object.freeze({ ...input, bytes: input.bytes.slice() }));
      return Promise.resolve(Object.freeze({
        result: Object.freeze({ message_id: "telegram-media" }),
      }));
    },
  });
  const resource = createTelegramChannelResource();
  const adapter = createTelegramChannelAdapter({
    config: { botToken: "telegram-bot-secret" },
    transport,
  });
  const receipt = await adapter.deliver!(
    attempt(
      "telegram",
      Object.freeze({ chatId: "chat-a" }),
      Object.freeze([
        resolved("text", { text: "Telegram reply" }),
        resolved("audio", {
          bytes: new Uint8Array([9, 8]),
          mediaType: "audio/ogg",
          name: "answer.ogg",
        }),
      ]),
      Object.freeze({
        action: Object.freeze({
          type: "reply_buttons",
          message: "Choose",
          content: Object.freeze([
            Object.freeze({ text: "Open", payload: "open" }),
          ]),
        }),
      }),
    ),
    deliveryContext("telegram", resource),
  );
  assertEquals(calls.map((item) => item.method), [
    "sendMessage",
    "sendMessage",
  ]);
  assertEquals(calls[0].body, { chat_id: "chat-a", text: "Telegram reply" });
  assertEquals(calls[1].body.reply_markup, {
    inline_keyboard: [[{ text: "Open", callback_data: "open" }]],
  });
  assertEquals(media[0].mediaType, "audio/ogg");
  assertEquals(receipt, {
    deliveryKey: "delivery-telegram",
    delivered: 3,
    providerIds: ["telegram-1", "telegram-media", "telegram-2"],
  });
});

Deno.test("Discord Adapter answers ping, rejects invalid signatures, and uses Bot-native egress", async () => {
  const signing = await discordSigningFixture();
  const sends: Array<Readonly<Record<string, unknown>>> = [];
  const media: DiscordMediaInput[] = [];
  const transport: DiscordTransport = Object.freeze({
    download() {
      return Promise.resolve(null);
    },
    send(config, channelId, body) {
      assertEquals(config.botToken, "discord-bot-secret");
      assertEquals(channelId, "discord-channel-a");
      sends.push(structuredClone(body));
      return Promise.resolve(Object.freeze({ id: `discord-${sends.length}` }));
    },
    sendMedia(config, channelId, input) {
      assertEquals(config.botToken, "discord-bot-secret");
      assertEquals(channelId, "discord-channel-a");
      media.push(Object.freeze({ ...input, bytes: input.bytes.slice() }));
      return Promise.resolve(Object.freeze({ id: "discord-media" }));
    },
  });
  const resource = createDiscordChannelResource();
  const adapter = createDiscordChannelAdapter({
    config: signing.config,
    transport,
  });
  const body = Object.freeze({ type: 1 });
  const rawBody = new TextEncoder().encode(JSON.stringify(body));
  const ping = await adapter.accept(
    request({
      method: "POST",
      headers: await signing.headers(rawBody),
      body,
      rawBody,
    }),
    acceptContext("discord", resource),
  );
  assertEquals(ping, { status: 200, response: { type: 1 }, occurrences: [] });
  const denied = await adapter.accept(
    request({
      method: "POST",
      headers: {
        "x-signature-ed25519": "00",
        "x-signature-timestamp": "1787428800",
      },
      body,
      rawBody,
    }),
    acceptContext("discord", resource),
  );
  assertEquals(denied.status, 401);
  assertEquals(denied.occurrences, []);

  const receipt = await adapter.deliver!(
    attempt(
      "discord",
      Object.freeze({ channelId: "discord-channel-a" }),
      Object.freeze([
        resolved("text", { text: "Discord reply" }),
        resolved("file", {
          bytes: new Uint8Array([4, 3]),
          mediaType: "application/pdf",
          name: "answer.pdf",
        }),
      ]),
      Object.freeze({
        action: Object.freeze({
          type: "reply_buttons",
          message: "Choose",
          content: Object.freeze([
            Object.freeze({ text: "Open", payload: "open" }),
          ]),
        }),
      }),
    ),
    deliveryContext("discord", resource),
  );
  assertEquals(sends[0], { content: "Discord reply" });
  assertEquals(sends[1].components, [{
    type: 1,
    components: [{ type: 2, style: 1, label: "Open", custom_id: "open" }],
  }]);
  assertEquals(media[0].name, "answer.pdf");
  assertEquals(receipt, {
    deliveryKey: "delivery-discord",
    delivered: 3,
    providerIds: ["discord-1", "discord-media", "discord-2"],
  });
});

Deno.test("WhatsApp Adapter verifies GET/HMAC handshakes and emits native text, media, and actions", async () => {
  const config: WhatsAppConfig = Object.freeze({
    accessToken: "whatsapp-access-secret",
    phoneId: "phone-a",
    appSecret: "whatsapp-app-secret",
    webhookVerifyToken: "whatsapp-verify-secret",
  });
  const uploads: WhatsAppMediaInput[] = [];
  const sends: Array<Readonly<Record<string, unknown>>> = [];
  const transport: WhatsAppTransport = Object.freeze({
    download() {
      return Promise.resolve(null);
    },
    upload(_config, input) {
      uploads.push(Object.freeze({ ...input, bytes: input.bytes.slice() }));
      return Promise.resolve(Object.freeze({
        id: `whatsapp-upload-${uploads.length}`,
        type: input.mediaType.startsWith("audio/")
          ? "audio" as const
          : "document" as const,
      }));
    },
    send(_config, body) {
      sends.push(structuredClone(body));
      return Promise.resolve(Object.freeze({
        messages: Object.freeze([{ id: `whatsapp-${sends.length}` }]),
      }));
    },
  });
  const resource = createWhatsAppChannelResource();
  const adapter = createWhatsAppChannelAdapter({ config, transport });
  const verified = await adapter.accept(
    request({
      method: "GET",
      query: {
        "hub.mode": "subscribe",
        "hub.verify_token": config.webhookVerifyToken!,
        "hub.challenge": "challenge-a",
      },
      body: null,
    }),
    acceptContext("whatsapp", resource),
  );
  assertEquals(verified, {
    status: 200,
    response: "challenge-a",
    occurrences: [],
  });
  const rejectedVerification = await adapter.accept(
    request({
      method: "GET",
      query: {
        "hub.mode": "subscribe",
        "hub.verify_token": "wrong",
        "hub.challenge": "challenge-a",
      },
      body: null,
    }),
    acceptContext("whatsapp", resource),
  );
  assertEquals(rejectedVerification.status, 403);

  const rawBody = new TextEncoder().encode("{}");
  const signature = await hmac(rawBody, config.appSecret!);
  assert(await verifyWhatsAppSignature(rawBody, config.appSecret!, signature));
  assertEquals(
    await verifyWhatsAppSignature(
      new TextEncoder().encode("changed"),
      config.appSecret!,
      signature,
    ),
    false,
  );
  const denied = await adapter.accept(
    request({
      method: "POST",
      headers: { "x-hub-signature-256": "sha256=00" },
      body: {},
      rawBody,
    }),
    acceptContext("whatsapp", resource),
  );
  assertEquals(denied.status, 403);
  assertEquals(denied.occurrences, []);

  const receipt = await adapter.deliver!(
    attempt(
      "whatsapp",
      Object.freeze({
        recipientPhone: "5511999999999",
        phoneId: "phone-a",
        businessId: "business-a",
      }),
      Object.freeze([
        resolved("text", { text: "WhatsApp reply" }),
        resolved("audio", {
          bytes: new Uint8Array([9, 8, 7]),
          mediaType: "audio/ogg",
          name: "answer.ogg",
        }),
      ]),
      Object.freeze({
        action: Object.freeze({
          type: "reply_buttons",
          message: "Choose",
          content: Object.freeze([
            Object.freeze({ text: "Yes", payload: "yes" }),
          ]),
        }),
      }),
    ),
    deliveryContext("whatsapp", resource),
  );
  assertEquals(sends.map((body) => body.type), [
    "text",
    "audio",
    "interactive",
  ]);
  assertEquals(sends[0].text, { body: "WhatsApp reply" });
  assertEquals(sends[1].audio, { id: "whatsapp-upload-1" });
  assertEquals(
    (sends[2].interactive as Record<string, unknown>).type,
    "button",
  );
  assertEquals(uploads[0].bytes, new Uint8Array([9, 8, 7]));
  assertEquals(receipt, {
    deliveryKey: "delivery-whatsapp",
    delivered: 3,
    providerIds: ["whatsapp-1", "whatsapp-2", "whatsapp-3"],
  });
});

Deno.test("WhatsApp protocol enforces reply, split, and carousel constraints", async () => {
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
  assertEquals(splitWhatsAppText("one.two", 4), ["one.", "two"]);

  const uploads: WhatsAppMediaInput[] = [];
  const action = Object.freeze({
    type: "media_carousel" as const,
    message: "Pick a card",
    cards: Object.freeze([
      Object.freeze({
        body: "First",
        image: Object.freeze({
          bytes: new Uint8Array([1, 2]),
          mediaType: "image/png",
        }),
        buttons: Object.freeze([
          Object.freeze({
            type: "quick_reply" as const,
            text: "First",
            payload: "first",
          }),
        ]),
      }),
      Object.freeze({
        body: "Second",
        image: Object.freeze({ link: "https://images.test/second.png" }),
        buttons: Object.freeze([
          Object.freeze({
            type: "quick_reply" as const,
            text: "Second",
            payload: "second",
          }),
        ]),
      }),
    ]),
  });
  const resolvedCarousel = await resolveWhatsAppMediaCarouselAction(
    action,
    (input) => {
      uploads.push(Object.freeze({ ...input, bytes: input.bytes.slice() }));
      return Promise.resolve(Object.freeze({
        id: "carousel-upload-a",
        type: "image" as const,
      }));
    },
  );
  assertExists(resolvedCarousel);
  assertEquals(uploads.length, 1);
  const built = buildWhatsAppMediaCarouselMessage("5511", resolvedCarousel);
  assertEquals(built?.type, "interactive");
  assertEquals(
    (built?.interactive as Record<string, unknown>).type,
    "carousel",
  );

  const duplicateIds = {
    ...action,
    cards: action.cards.map((card) => ({
      ...card,
      buttons: card.buttons.map((button) => ({
        ...button,
        payload: "duplicate",
      })),
    })),
  };
  assertEquals(
    await resolveWhatsAppMediaCarouselAction(
      duplicateIds,
      () =>
        Promise.resolve(Object.freeze({
          id: "duplicate-check-upload",
          type: "image" as const,
        })),
    ),
    null,
  );
});

Deno.test("Zendesk Adapter fails auth closed, normalizes media, and emits native content/actions", async () => {
  const config: ZendeskConfig = Object.freeze({
    appId: "zendesk-app",
    apiKey: "zendesk-key-secret",
    apiSecret: "zendesk-api-secret",
    webhookSecret: "zendesk-webhook-secret",
    businessName: "Copilotz",
  });
  const uploads: ZendeskMediaInput[] = [];
  const sends: Array<Readonly<Record<string, unknown>>> = [];
  const transport: ZendeskTransport = Object.freeze({
    download() {
      return Promise.resolve(null);
    },
    upload(_config, _conversationId, input) {
      uploads.push(Object.freeze({ ...input, bytes: input.bytes.slice() }));
      return Promise.resolve(Object.freeze({
        mediaUrl: `https://media.test/${uploads.length}`,
        mediaType: input.mediaType,
      }));
    },
    send(_config, conversationId, body) {
      assertEquals(conversationId, "zendesk-conversation-a");
      sends.push(structuredClone(body));
      return Promise.resolve(Object.freeze({ id: `zendesk-${sends.length}` }));
    },
  });
  const resource = createZendeskChannelResource();
  const adapter = createZendeskChannelAdapter({ config, transport });
  const denied = await adapter.accept(
    request({
      method: "POST",
      headers: { "x-api-key": "wrong" },
      body: { events: [] },
    }),
    acceptContext("zendesk", resource),
  );
  assertEquals(denied.status, 403);
  assertEquals(denied.occurrences, []);

  const received = await adapter.receive(
    Object.freeze({
      conversationId: "zendesk-conversation-a",
      messageId: "zendesk-message-a",
      externalUserId: "zendesk-user-a",
      text: "Voice note",
      media: Object.freeze({
        dataBase64: "T2dnUwE=",
        mediaType: "application/octet-stream",
        name: "voice.ogg",
      }),
    }),
    Object.freeze({
      ...acceptContext("zendesk", resource),
      occurrenceId: "zendesk:zendesk-message-a",
    }),
  );
  assert(Array.isArray(received.content));
  const receivedMedia = received.content[1] as Readonly<{
    bytes: Uint8Array;
    mediaType: string;
  }>;
  assertEquals(receivedMedia.mediaType, "audio/opus");
  assertEquals(
    receivedMedia.bytes,
    new Uint8Array([0x4f, 0x67, 0x67, 0x53, 1]),
  );

  const receipt = await adapter.deliver!(
    attempt(
      "zendesk",
      Object.freeze({ conversationId: "zendesk-conversation-a" }),
      Object.freeze([
        resolved("text", { text: "Zendesk reply" }),
        resolved("image", {
          bytes: new Uint8Array([1, 2, 3]),
          mediaType: "image/png",
          name: "reply.png",
        }),
      ]),
      Object.freeze({
        action: Object.freeze({
          type: "reply_buttons",
          message: "Choose",
          content: Object.freeze([
            Object.freeze({ text: "Continue", payload: "continue" }),
          ]),
        }),
      }),
    ),
    deliveryContext("zendesk", resource),
  );
  assertEquals(
    sends.map((body) => (body.content as Record<string, unknown>).type),
    ["text", "image", "text"],
  );
  assertEquals(
    (sends[2].content as Record<string, unknown>).actions,
    [{ type: "reply", text: "Continue", payload: "continue" }],
  );
  assertEquals(uploads[0].mediaType, "image/png");
  assertEquals(receipt, {
    deliveryKey: "delivery-zendesk",
    delivered: 3,
    providerIds: ["zendesk-1", "zendesk-2", "zendesk-3"],
  });
});
