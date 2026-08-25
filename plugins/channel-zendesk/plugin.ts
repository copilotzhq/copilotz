/** Composes the Zendesk Channel Resource and Adapter. @module */
import { definePlugin } from "@copilotz/copilotz/plugins";
import { channelsPlugin } from "../channel-core/plugin.ts";
import type { ChannelProviderPlugin } from "../channel-core/internal/contracts.ts";
import { createZendeskChannelAdapter } from "./adapters/index.ts";
import type { CreateZendeskChannelPluginOptions } from "./internal/contracts.ts";
import { createZendeskChannelResource } from "./resources/index.ts";

export function createZendeskChannelPlugin(
  options: CreateZendeskChannelPluginOptions,
): ChannelProviderPlugin {
  const channelId = options.channelId?.trim() || "zendesk";
  return definePlugin({
    id: options.pluginId?.trim() || "@copilotz/channel-zendesk",
    version: options.version?.trim() || "4.0.0",
    plugins: [channelsPlugin] as const,
    resources: {
      channels: { [channelId]: createZendeskChannelResource(options) },
    },
    adapters: {
      channels: { [channelId]: createZendeskChannelAdapter(options) },
    },
  });
}
