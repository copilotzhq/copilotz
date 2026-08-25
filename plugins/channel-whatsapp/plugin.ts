/** Composes the WhatsApp Channel Resource and Adapter. @module */
import { definePlugin } from "@copilotz/copilotz/plugins";
import { channelsPlugin } from "../channel-core/plugin.ts";
import type { ChannelProviderPlugin } from "../channel-core/internal/contracts.ts";
import { createWhatsAppChannelAdapter } from "./adapters/index.ts";
import type { CreateWhatsAppChannelPluginOptions } from "./internal/contracts.ts";
import { createWhatsAppChannelResource } from "./resources/index.ts";

export function createWhatsAppChannelPlugin(
  options: CreateWhatsAppChannelPluginOptions,
): ChannelProviderPlugin {
  const channelId = options.channelId?.trim() || "whatsapp";
  return definePlugin({
    id: options.pluginId?.trim() || "@copilotz/channel-whatsapp",
    version: options.version?.trim() || "4.0.0",
    plugins: [channelsPlugin] as const,
    resources: {
      channels: { [channelId]: createWhatsAppChannelResource(options) },
    },
    adapters: {
      channels: { [channelId]: createWhatsAppChannelAdapter(options) },
    },
  });
}
