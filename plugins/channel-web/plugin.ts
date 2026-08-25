/**
 * Composes the Web Channel Resource and Adapter.
 *
 * @module
 */

import { definePlugin } from "@copilotz/copilotz/plugins";
import { channelsPlugin } from "../channel-core/plugin.ts";
import type { ChannelProviderPlugin } from "../channel-core/internal/contracts.ts";
import { createWebChannelAdapter } from "./adapters/index.ts";
import {
  createWebChannelResource,
  type CreateWebChannelResourceOptions,
} from "./resources/index.ts";

export type CreateWebChannelPluginOptions =
  & CreateWebChannelResourceOptions
  & Readonly<{
    channelId?: string;
    pluginId?: string;
    version?: string;
  }>;

export function createWebChannelPlugin(
  options: CreateWebChannelPluginOptions = {},
): ChannelProviderPlugin {
  const channelId = options.channelId?.trim() || "web";
  return definePlugin({
    id: options.pluginId?.trim() || "@copilotz/channel-web",
    version: options.version?.trim() || "4.0.0",
    plugins: [channelsPlugin] as const,
    resources: {
      channels: { [channelId]: createWebChannelResource(options) },
    },
    adapters: { channels: { [channelId]: createWebChannelAdapter() } },
  });
}
