/**
 * Composes the Discord Channel Resource and Adapter.
 *
 * @module
 */

import { definePlugin } from "@copilotz/copilotz/plugins";
import { channelsPlugin } from "../channel-core/plugin.ts";
import type { ChannelProviderPlugin } from "../channel-core/internal/contracts.ts";
import { createDiscordChannelAdapter } from "./adapters/index.ts";
import type { CreateDiscordChannelPluginOptions } from "./internal/contracts.ts";
import { createDiscordChannelResource } from "./resources/index.ts";

export function createDiscordChannelPlugin(
  options: CreateDiscordChannelPluginOptions,
): ChannelProviderPlugin {
  const channelId = options.channelId?.trim() || "discord";
  return definePlugin({
    id: options.pluginId?.trim() || "@copilotz/channel-discord",
    version: options.version?.trim() || "4.0.0",
    plugins: [channelsPlugin] as const,
    resources: {
      channels: { [channelId]: createDiscordChannelResource(options) },
    },
    adapters: {
      channels: { [channelId]: createDiscordChannelAdapter(options) },
    },
  });
}
