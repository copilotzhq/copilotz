import type { AgentResource } from "@copilotz/copilotz/core";
import type { LlmAdapter } from "@copilotz/copilotz/llm";
import { definePlugin } from "@copilotz/copilotz/plugins";
import { assertEquals, assertExists } from "@std/assert";
import { createCopilotzApplication } from "../../runtime/application/application.ts";
import { createTestDomainContext } from "../core/internal/testing/context.ts";
import { createTestDatabase } from "../../runtime/testing/ominipg.ts";
import { projectActionEvents } from "../core/internal/testing/projections.ts";
import { createServerFacadeFetchHandler } from "../../server/facade.ts";
import { createServerPlugin } from "../server/index.ts";
import { CHANNEL_INGRESS_ACTION_ID } from "../channel-core/actions/ingress/index.ts";
import {
  createDiscordChannelAdapter,
  createDiscordChannelResource,
} from "../channel-discord/index.ts";
import type {
  DiscordConfig,
  DiscordTransport,
} from "../channel-discord/index.ts";
import { createWhatsAppChannelPlugin } from "../channel-whatsapp/index.ts";
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
  ZendeskTransport,
} from "../channel-zendesk/index.ts";
import { channelsPlugin } from "../channel-core/plugin.ts";
import {
  createTelegramChannelAdapter,
  createTelegramChannelResource,
} from "../channel-telegram/index.ts";
import type {
  TelegramConfig,
  TelegramTransport,
} from "../channel-telegram/index.ts";
import type { ChannelAdapter } from "../channel-core/internal/contracts.ts";
import { CHANNEL_INGRESS_INPUT_EVENT } from "../channel-core/internal/contracts.ts";

const NAMESPACE = "channel-provider-server";
const CONFIG: WhatsAppConfig = Object.freeze({
  accessToken: "private-access-token",
  phoneId: "phone-a",
  appSecret: "private-app-secret",
  webhookVerifyToken: "private-verify-token",
});

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

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
): Promise<void> {
  const deadline = Date.now() + 4_000;
  while (Date.now() <= deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for Channel state.");
}

function hex(bytes: ArrayBuffer | Uint8Array): string {
  return [...new Uint8Array(bytes)].map((value) =>
    value.toString(16).padStart(2, "0")
  ).join("");
}

async function discordSigningFixture(
  body: Uint8Array,
): Promise<
  Readonly<{ publicKey: string; signature: string; timestamp: string }>
> {
  const keys = await crypto.subtle.generateKey(
    { name: "Ed25519" },
    true,
    ["sign", "verify"],
  ) as CryptoKeyPair;
  const publicKey = hex(await crypto.subtle.exportKey("raw", keys.publicKey));
  const timestamp = "1787428800";
  const timestampBytes = new TextEncoder().encode(timestamp);
  const signed = new Uint8Array(timestampBytes.length + body.length);
  signed.set(timestampBytes);
  signed.set(body, timestampBytes.length);
  const signature = hex(
    await crypto.subtle.sign("Ed25519", keys.privateKey, signed),
  );
  return Object.freeze({ publicKey, signature, timestamp });
}

function withToolRecipient(adapter: ChannelAdapter): ChannelAdapter {
  return Object.freeze({
    ...adapter,
    async receive(input, context) {
      const received = await adapter.receive(input, context);
      return Object.freeze({
        ...received,
        recipients: Object.freeze([
          Object.freeze({
            externalId: "provider-test-sink",
            participantType: "tool" as const,
          }),
        ]),
      });
    },
  });
}

Deno.test("signed WhatsApp server ingress persists no credentials and retries one stable external delivery key", async () => {
  const database = await createTestDatabase({ url: ":memory:" });
  const downloads: string[] = [];
  const sends: Array<Readonly<Record<string, unknown>>> = [];
  const deliveryKeys: string[] = [];
  const configOperations: string[] = [];
  let attempts = 0;
  const transport: WhatsAppTransport = Object.freeze({
    download(_config, input) {
      downloads.push(input.id);
      return Promise.resolve(Object.freeze({
        bytes: new Uint8Array([1, 2, 3]),
        mediaType: input.mediaType ?? "audio/ogg",
      }));
    },
    upload(_config, input: WhatsAppMediaInput) {
      return Promise.resolve(Object.freeze({
        id: "uploaded-a",
        type: input.mediaType.startsWith("audio/") ? "audio" : "document",
      }));
    },
    send(_config, body) {
      attempts += 1;
      sends.push(structuredClone(body));
      if (attempts === 1) {
        return Promise.reject(new Error("transient provider failure"));
      }
      return Promise.resolve(
        Object.freeze({ messages: [{ id: "wamid.outbound-a" }] }),
      );
    },
  });
  const agent: AgentResource = Object.freeze({
    id: "support",
    name: "Support",
    role: "support",
    models: { generate: ["fixtureModel"] as const },
  });
  const llm: LlmAdapter = Object.freeze({
    call() {
      return Object.freeze({
        frames: new ReadableStream({
          start(controller) {
            controller.close();
          },
        }),
        result: Promise.resolve(Object.freeze({
          content: "Provider reply",
          attempts: Object.freeze([{ status: "completed" as const }]),
          finishReason: "stop",
        })),
      });
    },
  });
  const application = await createCopilotzApplication({
    database,
    namespace: NAMESPACE,
    databaseSchema: "copilotz_channel_provider_server",
    plugins: [
      createServerPlugin(),
      createWhatsAppChannelPlugin({
        config(context) {
          configOperations.push(
            `${context.operation}:${context.request ? "request" : "worker"}`,
          );
          return CONFIG;
        },
        transport,
        defaultAgentAliases: ["support"],
        transformDelivery(delivery, attempt) {
          deliveryKeys.push(attempt.intent.deliveryKey);
          return delivery;
        },
      }),
    ],
    resources: {
      agents: { support: agent },
      models: {
        fixtureModel: {
          adapter: "fixture",
          model: "fixture-model",
        },
      },
    },
    adapters: { llm: { fixture: llm } },
    engine: {
      retryBaseMs: 0,
      random: () => 0,
      execution: {
        scheduler: {
          schedule(callback) {
            return callback;
          },
          cancel() {},
        },
      },
    },
  });
  const body = Object.freeze({
    entry: [Object.freeze({
      id: "business-a",
      changes: [Object.freeze({
        value: Object.freeze({
          metadata: Object.freeze({ phone_number_id: "phone-a" }),
          contacts: [Object.freeze({
            profile: Object.freeze({ name: "User One" }),
          })],
          messages: [Object.freeze({
            from: "5511999999999",
            id: "wamid.inbound-a",
            type: "audio",
            audio: Object.freeze({
              id: "media-a",
              mime_type: "audio/ogg",
            }),
          })],
        }),
      })],
    })],
  });
  const rawBody = new TextEncoder().encode(JSON.stringify(body));
  try {
    const response = await createServerFacadeFetchHandler(application)(
      new Request("https://test/api/channels/" + "whatsapp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...{
            "x-hub-signature-256": await signature(
              rawBody,
              CONFIG.appSecret!,
            ),
          },
        },
        body: rawBody,
      }),
    );
    assertEquals(response.status, 200);
    assertEquals(await response.json(), { status: "ok" });
    await waitFor(() => attempts >= 1);
    await waitFor(async () =>
      (await application.deliveries.list({
        namespace: NAMESPACE,
        limit: 100,
      })).some((delivery) =>
        delivery.consumerId ===
          "processor:copilotz.channels.external-egress" &&
        delivery.status === "retry_wait"
      )
    );
    const recovery = await application.recover({
      namespace: NAMESPACE,
      consumerIds: ["processor:copilotz.channels.external-egress"],
      limit: 100,
    });
    await Promise.all(recovery.handles.map((handle) => handle.done));
    try {
      await waitFor(() => attempts >= 2);
    } catch (error) {
      const events = await application.events.list({ namespace: NAMESPACE });
      const deliveries = await application.deliveries.list({
        namespace: NAMESPACE,
        limit: 100,
      });
      throw new Error(JSON.stringify({
        cause: String(error),
        actions: await projectActionEvents(
          application,
          NAMESPACE,
          CHANNEL_INGRESS_ACTION_ID,
          { status: "failed" },
        ),
        attempts,
        configOperations,
        events: events.map((event) => event.type),
        deliveries: deliveries.map((delivery) => ({
          consumerId: delivery.consumerId,
          status: delivery.status,
          lastError: delivery.lastError,
        })),
      }));
    }
    assertEquals(downloads, ["media-a"]);
    assertEquals(sends.length, 2);
    assertEquals(deliveryKeys.length, 2);
    assertEquals(new Set(deliveryKeys).size, 1);
    assertEquals(configOperations.includes("accept:request"), true);
    assertEquals(configOperations.includes("receive:worker"), false);
    assertEquals(
      configOperations.filter((value) => value === "deliver:worker").length,
      2,
    );

    const ingress = (await application.events.list({ namespace: NAMESPACE }))
      .find((event) => event.type === CHANNEL_INGRESS_INPUT_EVENT);
    assertExists(ingress);
    const durable = JSON.stringify(ingress.payload);
    assertEquals(durable.includes(CONFIG.accessToken), false);
    assertEquals(durable.includes(CONFIG.appSecret!), false);
    assertEquals(durable.includes(CONFIG.webhookVerifyToken!), false);
    assertEquals(durable.includes("media-a"), false);
    assertEquals(durable.includes("AQID"), true);

    const context = createTestDomainContext(application, NAMESPACE);
    const [binding] = await context.collections.channelBinding.queries
      .byChannelThread({
        channelId: "whatsapp",
        externalThreadId: "5511999999999",
      });
    assertExists(binding);
    const messages = await context.collections.message.queries.byThreadId({
      threadId: String(binding.threadId),
    });
    assertEquals(messages.length, 2);
    const senders = await Promise.all(
      messages.map((message) =>
        context.collections.participant.get({ id: String(message.senderId) })
      ),
    );
    assertEquals(
      senders.map((sender) => sender?.participantType),
      ["human", "agent"],
    );
    const inbound = await context.content.resolveMany(
      messages[0].content as never,
    );
    assertEquals(inbound[0].bytes, new Uint8Array([1, 2, 3]));
  } finally {
    await application.shutdown();
    await database.close();
  }
});

Deno.test("Telegram host accept replaces provider file references with replayable base64 before durable ingress", async () => {
  const database = await createTestDatabase({ url: ":memory:" });
  const downloads: string[] = [];
  const transport: TelegramTransport = Object.freeze({
    call(_config, _method, _body) {
      return Promise.resolve(Object.freeze({ ok: true }));
    },
    download(_config, fileId) {
      downloads.push(fileId);
      return Promise.resolve(Object.freeze({
        bytes: new Uint8Array([7, 6, 5]),
        mediaType: "audio/ogg",
        name: "voice.ogg",
      }));
    },
    sendMedia(_config, _chatId, _media) {
      return Promise.resolve(Object.freeze({ ok: true }));
    },
  });
  const config: TelegramConfig = Object.freeze({
    botToken: "telegram-bot-secret",
    secretToken: "telegram-webhook-secret",
  });
  const adapter = withToolRecipient(createTelegramChannelAdapter({
    config,
    transport,
  }));
  const plugin = definePlugin({
    id: "test.channel-telegram-media-staging",
    version: "1.0.0",
    plugins: [channelsPlugin] as const,
    resources: {
      channels: { telegram: createTelegramChannelResource() },
    },
    adapters: { channels: { telegram: adapter } },
  });
  const application = await createCopilotzApplication({
    database,
    namespace: NAMESPACE,
    databaseSchema: "copilotz_channel_telegram_media_staging",
    plugins: [plugin, createServerPlugin()],
  });
  const body = {
    update_id: "telegram-update-a",
    message: {
      message_id: "telegram-message-a",
      chat: { id: "telegram-thread-a" },
      from: { id: "telegram-user-a", username: "alice" },
      voice: {
        file_id: "telegram-file-reference-a",
        mime_type: "audio/ogg",
        file_name: "voice.ogg",
      },
    },
  };
  try {
    const response = await createServerFacadeFetchHandler(application)(
      new Request("https://test/api/channels/" + "telegram", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...{
            "x-telegram-bot-api-secret-token": config.secretToken!,
          },
        },
        body: JSON.stringify(body),
      }),
    );
    assertEquals(response.status, 200);
    assertEquals(await response.json(), { status: "ok" });
    assertEquals(downloads, ["telegram-file-reference-a"]);

    const context = createTestDomainContext(application, NAMESPACE);
    await waitFor(async () =>
      (await context.collections.channelBinding.queries.byChannelThread({
        channelId: "telegram",
        externalThreadId: "telegram-thread-a",
      })).length === 1
    );
    const ingress = (await application.events.list({ namespace: NAMESPACE }))
      .find((event) => event.type === CHANNEL_INGRESS_INPUT_EVENT);
    assertExists(ingress);
    const durable = JSON.stringify(ingress.payload);
    assertEquals(durable.includes("telegram-file-reference-a"), false);
    assertEquals(durable.includes(config.botToken), false);
    assertEquals(durable.includes(config.secretToken!), false);
    assertEquals(durable.includes("BwYF"), true);

    const [binding] = await context.collections.channelBinding.queries
      .byChannelThread({
        channelId: "telegram",
        externalThreadId: "telegram-thread-a",
      });
    assertExists(binding);
    const [message] = await context.collections.message.queries.byThreadId({
      threadId: String(binding.threadId),
    });
    assertExists(message);
    const [asset] = await context.content.resolveMany(message.content as never);
    assertEquals(asset.bytes, new Uint8Array([7, 6, 5]));
  } finally {
    await application.shutdown();
    await database.close();
  }
});

Deno.test("Discord host accept removes signed attachment URLs before durable ingress and assetizes staged bytes", async () => {
  const database = await createTestDatabase({ url: ":memory:" });
  const secretUrl =
    "https://cdn.discord.test/input.bin?signature=discord-secret-query";
  const downloads: string[] = [];
  const transport: DiscordTransport = Object.freeze({
    download(url) {
      downloads.push(url);
      return Promise.resolve(Object.freeze({
        bytes: new Uint8Array([9, 8, 7]),
        mediaType: "application/octet-stream",
        name: "input.bin",
      }));
    },
    send(_config, _channelId, _body) {
      return Promise.resolve(Object.freeze({ id: "unused" }));
    },
    sendMedia(_config, _channelId, _media) {
      return Promise.resolve(Object.freeze({ id: "unused" }));
    },
  });
  const interaction = {
    id: "discord-interaction-a",
    type: 2,
    token: "discord-interaction-secret",
    channel_id: "discord-thread-a",
    user: { id: "discord-user-a", username: "Alice" },
    data: {
      options: [{ name: "attachment", type: 11, value: "attachment-a" }],
      resolved: {
        attachments: {
          "attachment-a": {
            url: secretUrl,
            content_type: "application/octet-stream",
            filename: "input.bin",
          },
        },
      },
    },
  };
  const rawBody = new TextEncoder().encode(JSON.stringify(interaction));
  const signing = await discordSigningFixture(rawBody);
  const config: DiscordConfig = Object.freeze({
    applicationId: "discord-application",
    publicKey: signing.publicKey,
    botToken: "discord-bot-secret",
  });
  const adapter = withToolRecipient(createDiscordChannelAdapter({
    config,
    transport,
  }));
  const plugin = definePlugin({
    id: "test.channel-discord-safe-url",
    version: "1.0.0",
    plugins: [channelsPlugin] as const,
    resources: {
      channels: { discord: createDiscordChannelResource() },
    },
    adapters: { channels: { discord: adapter } },
  });
  const application = await createCopilotzApplication({
    database,
    namespace: NAMESPACE,
    databaseSchema: "copilotz_channel_discord_safe_url",
    plugins: [plugin, createServerPlugin()],
  });
  try {
    const response = await createServerFacadeFetchHandler(application)(
      new Request("https://test/api/channels/" + "discord", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...{
            "x-signature-ed25519": signing.signature,
            "x-signature-timestamp": signing.timestamp,
          },
        },
        body: rawBody,
      }),
    );
    assertEquals(response.status, 200);
    assertEquals(await response.json(), { type: 5 });
    assertEquals(downloads, [secretUrl]);

    const context = createTestDomainContext(application, NAMESPACE);
    try {
      await waitFor(async () =>
        (await context.collections.channelBinding.queries.byChannelThread({
          channelId: "discord",
          externalThreadId: "discord-thread-a",
        })).length === 1
      );
    } catch (error) {
      throw new Error(JSON.stringify({
        cause: String(error),
        actions: await projectActionEvents(
          application,
          NAMESPACE,
          CHANNEL_INGRESS_ACTION_ID,
          { status: "failed" },
        ),
        events: (await application.events.list({ namespace: NAMESPACE })).map(
          (event) => ({ type: event.type, payload: event.payload }),
        ),
        deliveries: (await application.deliveries.list({
          namespace: NAMESPACE,
          limit: 100,
        })).map((delivery) => ({
          consumerId: delivery.consumerId,
          status: delivery.status,
          lastError: delivery.lastError,
        })),
      }));
    }
    const ingress = (await application.events.list({ namespace: NAMESPACE }))
      .find((event) => event.type === CHANNEL_INGRESS_INPUT_EVENT);
    assertExists(ingress);
    const durable = JSON.stringify(ingress.payload);
    assertEquals(durable.includes(secretUrl), false);
    assertEquals(durable.includes("discord-secret-query"), false);
    assertEquals(durable.includes("discord-interaction-secret"), false);
    assertEquals(durable.includes(config.botToken), false);

    const [binding] = await context.collections.channelBinding.queries
      .byChannelThread({
        channelId: "discord",
        externalThreadId: "discord-thread-a",
      });
    assertExists(binding);
    const [message] = await context.collections.message.queries.byThreadId({
      threadId: String(binding.threadId),
    });
    assertExists(message);
    const [asset] = await context.content.resolveMany(message.content as never);
    assertEquals(asset.bytes, new Uint8Array([9, 8, 7]));
  } finally {
    await application.shutdown();
    await database.close();
  }
});

Deno.test("Zendesk host accept removes signed media URLs before durable ingress and assetizes staged bytes", async () => {
  const database = await createTestDatabase({ url: ":memory:" });
  const secretUrl =
    "https://media.zendesk.test/input.bin?jwt=zendesk-secret-query";
  const downloads: string[] = [];
  const transport: ZendeskTransport = Object.freeze({
    download(url) {
      downloads.push(url);
      return Promise.resolve(Object.freeze({
        bytes: new Uint8Array([4, 5, 6]),
        mediaType: "application/octet-stream",
        name: "input.bin",
      }));
    },
    upload(_config, _conversationId, media) {
      return Promise.resolve(Object.freeze({
        mediaUrl: "https://unused.invalid/output",
        mediaType: media.mediaType,
      }));
    },
    send(_config, _conversationId, _body) {
      return Promise.resolve(Object.freeze({ id: "unused" }));
    },
  });
  const config: ZendeskConfig = Object.freeze({
    appId: "zendesk-app",
    apiKey: "zendesk-key-secret",
    apiSecret: "zendesk-api-secret",
    webhookSecret: "zendesk-webhook-secret",
  });
  const body = {
    events: [{
      type: "conversation:message",
      payload: {
        conversation: { id: "zendesk-thread-a", type: "personal" },
        message: {
          id: "zendesk-message-a",
          author: {
            type: "user",
            displayName: "Alice",
            user: { id: "zendesk-user-a" },
          },
          content: {
            type: "file",
            mediaUrl: secretUrl,
            mediaType: "application/octet-stream",
            fileName: "input.bin",
          },
        },
      },
    }],
  };
  const adapter = withToolRecipient(createZendeskChannelAdapter({
    config,
    transport,
  }));
  const plugin = definePlugin({
    id: "test.channel-zendesk-safe-url",
    version: "1.0.0",
    plugins: [channelsPlugin] as const,
    resources: {
      channels: { zendesk: createZendeskChannelResource() },
    },
    adapters: { channels: { zendesk: adapter } },
  });
  const application = await createCopilotzApplication({
    database,
    namespace: NAMESPACE,
    databaseSchema: "copilotz_channel_zendesk_safe_url",
    plugins: [plugin, createServerPlugin()],
  });
  try {
    const response = await createServerFacadeFetchHandler(application)(
      new Request("https://test/api/channels/" + "zendesk", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...{ "x-api-key": config.webhookSecret! },
        },
        body: JSON.stringify(body),
      }),
    );
    assertEquals(response.status, 200);
    assertEquals(await response.json(), { status: "ok" });
    assertEquals(downloads, [secretUrl]);

    const context = createTestDomainContext(application, NAMESPACE);
    try {
      await waitFor(async () =>
        (await context.collections.channelBinding.queries.byChannelThread({
          channelId: "zendesk",
          externalThreadId: "zendesk-thread-a",
        })).length === 1
      );
    } catch (error) {
      throw new Error(JSON.stringify({
        cause: String(error),
        events: (await application.events.list({ namespace: NAMESPACE })).map(
          (event) => ({ type: event.type, payload: event.payload }),
        ),
        deliveries: (await application.deliveries.list({
          namespace: NAMESPACE,
          limit: 100,
        })).map((delivery) => ({
          consumerId: delivery.consumerId,
          status: delivery.status,
          lastError: delivery.lastError,
        })),
      }));
    }
    const ingress = (await application.events.list({ namespace: NAMESPACE }))
      .find((event) => event.type === CHANNEL_INGRESS_INPUT_EVENT);
    assertExists(ingress);
    const durable = JSON.stringify(ingress.payload);
    assertEquals(durable.includes(secretUrl), false);
    assertEquals(durable.includes("zendesk-secret-query"), false);
    assertEquals(durable.includes(config.apiKey), false);
    assertEquals(durable.includes(config.apiSecret), false);
    assertEquals(durable.includes(config.webhookSecret!), false);

    const [binding] = await context.collections.channelBinding.queries
      .byChannelThread({
        channelId: "zendesk",
        externalThreadId: "zendesk-thread-a",
      });
    assertExists(binding);
    const [message] = await context.collections.message.queries.byThreadId({
      threadId: String(binding.threadId),
    });
    assertExists(message);
    const [asset] = await context.content.resolveMany(message.content as never);
    assertEquals(asset.bytes, new Uint8Array([4, 5, 6]));
  } finally {
    await application.shutdown();
    await database.close();
  }
});
