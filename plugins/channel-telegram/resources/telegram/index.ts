/**
 * Defines the data-only Telegram Channel Resource.
 *
 * @module
 */

import { defineChannelResource } from "../../../channel-core/authoring/channel-resource/index.ts";
import type { ChannelResource } from "../../../channel-core/internal/contracts.ts";
import type { CreateTelegramChannelResourceOptions } from "../../internal/contracts.ts";

export function createTelegramChannelResource(
  options: CreateTelegramChannelResourceOptions = {},
): ChannelResource {
  return defineChannelResource({
    egress: "external",
    ...(options.defaultAgentAliases
      ? { defaultAgentAliases: options.defaultAgentAliases }
      : {}),
    ...(options.metadata ? { metadata: options.metadata } : {}),
  });
}
