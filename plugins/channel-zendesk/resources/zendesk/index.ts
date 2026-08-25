/** Defines the data-only Zendesk Channel Resource. @module */
import { defineChannelResource } from "../../../channel-core/authoring/channel-resource/index.ts";
import type { ChannelResource } from "../../../channel-core/internal/contracts.ts";
import type { CreateZendeskChannelResourceOptions } from "../../internal/contracts.ts";

export function createZendeskChannelResource(
  options: CreateZendeskChannelResourceOptions = {},
): ChannelResource {
  return defineChannelResource({
    egress: "external",
    ...(options.defaultAgentAliases
      ? { defaultAgentAliases: options.defaultAgentAliases }
      : {}),
    ...(options.metadata ? { metadata: options.metadata } : {}),
  });
}
