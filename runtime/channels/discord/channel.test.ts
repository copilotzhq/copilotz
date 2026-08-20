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
import { createDiscordChannel, createDiscordChannelPlugin } from "./index.ts";
import type {
  DiscordConfig,
  DiscordMediaInput,
  DiscordTransport,
} from "./types.ts";

const NAMESPACE = "tenant-discord";
const agent: Agent = { id: "support", name: "Support", role: "support" };

function hex(bytes: Uint8Array): string {
  return [...bytes].map((value) => value.toString(16).padStart(2, "0")).join(
    "",
  );
}

async function signingContext() {
  const keys = await crypto.subtle.generateKey(
    { name: "Ed25519" },
    true,
    ["sign", "verify"],
  ) as CryptoKeyPair;
  const publicKey = hex(
    new Uint8Array(await crypto.subtle.exportKey("raw", keys.publicKey)),
  );
  const config: DiscordConfig = {
    applicationId: "application-a",
    publicKey,
  };
  return {
    config,
    async headers(body: Uint8Array, timestamp = "123") {
      const prefix = new TextEncoder().encode(timestamp);
      const value = new Uint8Array(prefix.byteLength + body.byteLength);
      value.set(prefix);
      value.set(body, prefix.byteLength);
      const signature = new Uint8Array(
        await crypto.subtle.sign("Ed25519", keys.privateKey, value.buffer),
      );
      return {
        "x-signature-ed25519": hex(signature),
        "x-signature-timestamp": timestamp,
      };
    },
  };
}

function fakeTransport() {
  const downloads: string[] = [];
  const sends: Array<{
    body: Readonly<Record<string, unknown>>;
    initial: boolean;
  }> = [];
  const media: Array<{ value: DiscordMediaInput; initial: boolean }> = [];
  const transport: DiscordTransport = Object.freeze({
    async download(url) {
      downloads.push(url);
      return { bytes: new Uint8Array([1, 2]), mediaType: "image/png" };
    },
    async send(_config, _token, body, initial) {
      sends.push({ body: structuredClone(body), initial });
      return { id: `send-${sends.length}` };
    },
    async sendMedia(_config, _token, value, initial) {
      media.push({
        value: { ...value, bytes: value.bytes.slice() },
        initial,
      });
      return { id: `media-${media.length}` };
    },
  });
  return { transport, downloads, sends, media };
}

function replyPlugin() {
  const processor = defineProcessor<CopilotzProcessorContext>({
    id: "discord.reply",
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
        "Discord reply",
        {
          type: "file",
          bytes: new Uint8Array([9, 8]),
          mediaType: "application/pdf",
          name: "answer.pdf",
        },
      ], { operationKey: "discord-reply-content" });
      const persisted = await context.content.materialize(content);
      await context.collections.message.create({
        id: `reply:${input.id}`,
        threadId: input.threadId,
        senderId: recipient.id,
        recipientIds: [input.sender.id],
        content: persisted,
      }, { operationKey: "discord-reply-message" });
      await context.content.linkOwner(`reply:${input.id}`, persisted);
    },
  });
  return definePlugin({
    manifest: {
      id: "test.discord-reply",
      version: "1.0.0",
      provides: { processors: [processor.id] },
    },
    resources: { processors: [processor] },
  });
}

async function close(db: TestDatabase): Promise<void> {
  await db.close();
}

Deno.test("Discord channel verifies interactions and preserves native media/action egress", async () => {
  const signed = await signingContext();
  const fake = fakeTransport();
  const db = await createTestDatabase({ url: ":memory:" });
  const application = await createCopilotzApplication({
    database: db,
    namespace: NAMESPACE,
    databaseSchema: "copilotz_v3_discord",
    core: false,
    canonicalCore: [coreCollectionsPlugin],
    plugins: [
      replyPlugin(),
      createDiscordChannelPlugin({
        config: signed.config,
        transport: fake.transport,
        defaultAgentIds: [agent.id],
      }),
    ],
    resources: { agents: [agent] },
  });
  const body = {
    id: "interaction-a",
    type: 2,
    token: "interaction-token-a",
    channel_id: "channel-a",
    guild_id: "guild-a",
    member: { user: { id: "user-a", username: "vinicius" } },
    data: {
      name: "ask",
      options: [
        { name: "prompt", type: 3, value: "Inspect this" },
        { name: "attachment", type: 11, value: "attachment-a" },
      ],
      resolved: {
        attachments: {
          "attachment-a": {
            url: "https://cdn.discord.example/a",
            content_type: "image/png",
            filename: "input.png",
          },
        },
      },
    },
  };
  const rawBody = new TextEncoder().encode(JSON.stringify(body));
  try {
    const result = await createChannelRuntime(application).dispatch(NAMESPACE, {
      method: "POST",
      headers: await signed.headers(rawBody),
      body,
      rawBody,
      route: { ingress: "discord", egress: "discord" },
    });
    assertEquals(result.response, { type: 5 });
    await result.done;
    assertEquals(fake.downloads, ["https://cdn.discord.example/a"]);
    assertEquals(fake.sends.map((value) => value.initial), [true, false]);
    assertEquals(fake.sends[0].body.components, [{
      type: 1,
      components: [{ type: 2, style: 1, label: "Open", custom_id: "open" }],
    }]);
    assertEquals(fake.sends[1].body.content, "Discord reply");
    assertEquals(fake.media.length, 1);
    assertEquals(fake.media[0].initial, false);
    assertEquals(fake.media[0].value.name, "answer.pdf");
    const thread = await projectThreadByExternalId(
      application,
      NAMESPACE,
      "channel-a",
    );
    assertExists(thread);
    const messages = await projectMessages(application, NAMESPACE, thread.id);
    assertEquals(messages[0].id, "discord:interaction-a");
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

Deno.test("Discord ping responds immediately and invalid signatures fail closed", async () => {
  const signed = await signingContext();
  const channel = createDiscordChannel({
    config: signed.config,
    transport: fakeTransport().transport,
  });
  assertExists(channel.ingress);
  const body = { type: 1 };
  const rawBody = new TextEncoder().encode(JSON.stringify(body));
  const ping = await channel.ingress.handle({
    method: "POST",
    headers: await signed.headers(rawBody),
    body,
    rawBody,
    route: { ingress: "discord", egress: "discord" },
  }, {} as never);
  assertEquals(ping, { status: 200, response: { type: 1 }, inputs: [] });
  const denied = await channel.ingress.handle({
    method: "POST",
    headers: {
      "x-signature-ed25519": "00",
      "x-signature-timestamp": "123",
    },
    body,
    rawBody,
    route: { ingress: "discord", egress: "discord" },
  }, {} as never);
  assertEquals(denied.status, 401);
  assertEquals(denied.inputs, []);
});

Deno.test("Discord channel core is factory-first and runtime-neutral", async () => {
  for (const file of ["channel.ts", "transport.ts", "types.ts"]) {
    const source = await Deno.readTextFile(new URL(file, import.meta.url));
    assertEquals(/\bclass\s+[A-Za-z_$]/.test(source), false, file);
    assertEquals(source.includes("Deno."), false, file);
    assertEquals(source.includes("node:"), false, file);
    assertEquals(source.includes("server/"), false, file);
    assertEquals(source.includes("unsafeGraph"), false, file);
  }
});
