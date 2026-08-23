import { assertEquals, assertThrows } from "@std/assert";
import * as channelPublic from "./index.ts";
import { channelIngress } from "./input.ts";
import { channelsPlugin } from "./plugin.ts";
import { defineChannelResource } from "./resource.ts";
import { createDiscordChannelPlugin } from "./discord/channel.ts";
import { createTelegramChannelPlugin } from "./telegram/channel.ts";
import { createWebChannelPlugin } from "./web.ts";
import { createWhatsAppChannelPlugin } from "./whatsapp/channel.ts";
import { createZendeskChannelPlugin } from "./zendesk/channel.ts";

Deno.test("Channel Resource snapshots exact data without invoking accessors", () => {
  let reads = 0;
  const accessor = Object.defineProperty({}, "egress", {
    enumerable: true,
    get() {
      reads += 1;
      return "external";
    },
  });
  assertThrows(() => defineChannelResource(accessor as never), TypeError);
  assertEquals(reads, 0);

  assertThrows(
    () =>
      defineChannelResource({
        egress: "external",
        legacyId: "telegram",
      } as never),
    TypeError,
  );
  const sparse = new Array<string>(2);
  sparse[1] = "agent";
  assertThrows(
    () =>
      defineChannelResource({
        egress: "external",
        defaultAgentAliases: sparse,
      }),
    TypeError,
  );
});

Deno.test("channelIngress rejects occurrence and option accessors and extras", () => {
  let occurrenceReads = 0;
  const occurrence = Object.defineProperties({}, {
    id: { enumerable: true, value: "one" },
    input: {
      enumerable: true,
      get() {
        occurrenceReads += 1;
        return {};
      },
    },
  });
  assertThrows(
    () => channelIngress("web", occurrence as never),
    TypeError,
  );
  assertEquals(occurrenceReads, 0);

  assertThrows(
    () =>
      channelIngress("web", {
        id: "one",
        input: {},
        route: {},
      } as never),
    TypeError,
  );
  assertThrows(
    () =>
      channelIngress("web", { id: "one", input: {} }, {
        get correlationId() {
          throw new Error("must not execute");
        },
      } as never),
    TypeError,
  );
});

Deno.test("Channel public data snapshots are isolated from caller mutation", () => {
  const aliases = ["primary"];
  const resourceMetadata = { tier: "gold" };
  const resource = defineChannelResource({
    egress: "external",
    defaultAgentAliases: aliases,
    metadata: resourceMetadata,
  });
  aliases[0] = "changed";
  resourceMetadata.tier = "changed";
  assertEquals(resource.defaultAgentAliases, ["primary"]);
  assertEquals(resource.metadata, { tier: "gold" });

  const providerInput = { nested: { text: "original" } };
  const optionsMetadata = { host: "gateway" };
  const envelope = channelIngress(
    "web",
    { id: "one", input: providerInput },
    { metadata: optionsMetadata },
  );
  providerInput.nested.text = "changed";
  optionsMetadata.host = "changed";
  assertEquals(envelope.payload, {
    channelId: "web",
    id: "one",
    input: { nested: { text: "original" } },
  });
  assertEquals(envelope.metadata, { host: "gateway" });
  assertEquals(envelope.visibility, { kind: "internal" });
});

Deno.test("Channel public exports and provider composition expose only the Resource/Adapter split", () => {
  assertEquals(
    Object.keys(channelPublic).sort(),
    [
      "CHANNELS_PLUGIN_ID",
      "CHANNELS_PLUGIN_VERSION",
      "CHANNEL_BINDING_COLLECTION",
      "CHANNEL_EGRESS_ACTION_ID",
      "CHANNEL_INGRESS_ACTION_ID",
      "CHANNEL_INGRESS_INPUT_EVENT",
      "buildWhatsAppMediaCarouselMessage",
      "buildWhatsAppReplyButtonsMessage",
      "channelBindingCollection",
      "channelEgressAction",
      "channelEgressProcessor",
      "channelIngress",
      "channelIngressAction",
      "channelIngressProcessor",
      "channelsPlugin",
      "createDiscordChannelAdapter",
      "createDiscordChannelPlugin",
      "createDiscordChannelResource",
      "createDiscordTransport",
      "createTelegramChannelAdapter",
      "createTelegramChannelPlugin",
      "createTelegramChannelResource",
      "createTelegramTransport",
      "createWebChannelAdapter",
      "createWebChannelPlugin",
      "createWebChannelResource",
      "createWhatsAppChannelAdapter",
      "createWhatsAppChannelPlugin",
      "createWhatsAppChannelResource",
      "createWhatsAppGraphTransport",
      "createZendeskChannelAdapter",
      "createZendeskChannelPlugin",
      "createZendeskChannelResource",
      "createZendeskTransport",
      "defineChannelResource",
      "isChannelResource",
      "normalizeWhatsAppActionPayload",
      "normalizeWhatsAppReplyButtons",
      "resolveWhatsAppMediaCarouselAction",
      "splitWhatsAppText",
      "verifyDiscordSignature",
      "verifyWhatsAppSignature",
      "whatsappHeader",
    ].sort(),
  );
  const providers = [
    createWebChannelPlugin({ channelId: "web-custom" }),
    createTelegramChannelPlugin({
      channelId: "telegram-custom",
      config: { botToken: "private" },
    }),
    createWhatsAppChannelPlugin({
      channelId: "whatsapp-custom",
      config: { accessToken: "private", phoneId: "phone" },
    }),
    createDiscordChannelPlugin({
      channelId: "discord-custom",
      config: {
        applicationId: "application",
        publicKey: "public",
        botToken: "private",
      },
    }),
    createZendeskChannelPlugin({
      channelId: "zendesk-custom",
      config: { appId: "app", apiKey: "key", apiSecret: "private" },
    }),
  ];
  for (const plugin of providers) {
    const resourceAliases = Object.keys(plugin.resources.channels ?? {});
    const adapterAliases = Object.keys(plugin.adapters.channels ?? {});
    assertEquals(resourceAliases, adapterAliases);
    assertEquals(plugin.plugins.includes(channelsPlugin), true);
    const resource = plugin.resources.channels?.[resourceAliases[0]] as
      | Record<string, unknown>
      | undefined;
    assertEquals(
      Object.keys(resource ?? {}).some((key) =>
        typeof resource?.[key] === "function"
      ),
      false,
    );
    assertEquals("id" in (resource ?? {}), false);
    assertEquals(JSON.stringify(resource).includes("private"), false);
  }
});
