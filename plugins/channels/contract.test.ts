import { coreEvent } from "../core/shared/events/index.ts";
import { assertEquals, assertThrows } from "@std/assert";
import * as channelPublic from "./index.ts";
import { channelIngress } from "../channel-core/authoring/channel-ingress/index.ts";
import { channelsPlugin } from "../channel-core/plugin.ts";
import { defineChannelResource } from "../channel-core/authoring/channel-resource/index.ts";
import { discordChannelPlugin } from "../channel-discord/index.ts";
import { telegramChannelPlugin } from "../channel-telegram/index.ts";
import { webChannelPlugin } from "../channel-web/index.ts";
import { whatsappChannelPlugin } from "../channel-whatsapp/index.ts";
import { zendeskChannelPlugin } from "../channel-zendesk/index.ts";
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
  assertThrows(() =>
    defineChannelResource({
      egress: "external",
      legacyId: "telegram",
    } as never), TypeError);
  const sparse = new Array<string>(2);
  sparse[1] = "agent";
  assertThrows(() =>
    defineChannelResource({
      egress: "external",
      defaultAgentAliases: sparse,
    }), TypeError);
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
  assertThrows(() => channelIngress("web", occurrence as never), TypeError);
  assertEquals(occurrenceReads, 0);
  assertThrows(() =>
    channelIngress("web", {
      id: "one",
      input: {},
      route: {},
    } as never), TypeError);
  assertThrows(() =>
    channelIngress("web", { id: "one", input: {} }, {
      get correlationId() {
        throw new Error("must not execute");
      },
    } as never), TypeError);
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
  const envelope = channelIngress("web", { id: "one", input: providerInput }, {
    metadata: optionsMetadata,
  });
  providerInput.nested.text = "changed";
  optionsMetadata.host = "changed";
  assertEquals(envelope.payload, {
    channelId: "web",
    id: "one",
    input: { nested: { text: "original" } },
  });
  assertEquals(envelope.metadata, {
    host: "gateway",
    core: { visibility: { kind: "internal" } },
  });
  assertEquals(coreEvent(envelope).visibility, { kind: "internal" });
});
Deno.test("Channel public exports and provider composition expose only the Resource/Adapter split", () => {
  assertEquals(
    Object.keys(channelPublic).sort(),
    [
      "channelProviderOptions",
      "outboundText",
      "providerRecord",
      "requestHeader",
      "requiredProviderText",
      "timingSafeTextEqual",
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
      "discordChannelAdapter",
      "discordChannelPlugin",
      "discordChannelResource",
      "createDiscordTransport",
      "telegramChannelAdapter",
      "telegramChannelPlugin",
      "telegramChannelResource",
      "createTelegramTransport",
      "webChannelAdapter",
      "webChannelPlugin",
      "webChannelResource",
      "whatsappChannelAdapter",
      "whatsappChannelPlugin",
      "whatsappChannelResource",
      "createWhatsAppGraphTransport",
      "zendeskChannelAdapter",
      "zendeskChannelPlugin",
      "zendeskChannelResource",
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
    webChannelPlugin,
    telegramChannelPlugin,
    whatsappChannelPlugin,
    discordChannelPlugin,
    zendeskChannelPlugin,
  ];
  for (const plugin of providers) {
    const resourceAliases = Object.keys(plugin.resources.channels ?? {});
    const adapterAliases = Object.keys(plugin.adapters.channels ?? {});
    assertEquals(resourceAliases, adapterAliases);
    assertEquals(plugin.plugins.includes(channelsPlugin), true);
    const resource = Object.values(plugin.resources.channels)[0] as
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
