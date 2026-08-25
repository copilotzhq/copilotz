/**
 * Defines the data-only Discord Channel Resource.
 *
 * @module
 */

import { defineChannelResource } from "../../../channel-core/authoring/channel-resource/index.ts";
import type { ChannelResource } from "../../../channel-core/internal/contracts.ts";
import type { CreateDiscordChannelResourceOptions } from "../../internal/contracts.ts";

export function createDiscordChannelResource(
  options: CreateDiscordChannelResourceOptions = {},
): ChannelResource {
  return defineChannelResource({
    egress: "external",
    ...(options.defaultAgentAliases
      ? { defaultAgentAliases: options.defaultAgentAliases }
      : {}),
    ...(options.metadata ? { metadata: options.metadata } : {}),
  });
}
