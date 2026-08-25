/**
 * Composes the Telegram Channel Resource and Adapter.
 *
 * @module
 */

import { definePlugin } from "@copilotz/copilotz/plugins";
import { channelsPlugin } from "../channel-core/plugin.ts";
import type { ChannelProviderPlugin } from "../channel-core/internal/contracts.ts";
import { createTelegramChannelAdapter } from "./adapters/index.ts";
import type { CreateTelegramChannelPluginOptions } from "./internal/contracts.ts";
import { createTelegramChannelResource } from "./resources/index.ts";

export function createTelegramChannelPlugin(
  options: CreateTelegramChannelPluginOptions,
): ChannelProviderPlugin {
  const channelId = options.channelId?.trim() || "telegram";
  return definePlugin({
    id: options.pluginId?.trim() || "@copilotz/channel-telegram",
    version: options.version?.trim() || "4.0.0",
    plugins: [channelsPlugin] as const,
    resources: {
      channels: { [channelId]: createTelegramChannelResource(options) },
    },
    adapters: {
      channels: { [channelId]: createTelegramChannelAdapter(options) },
    },
  });
}
