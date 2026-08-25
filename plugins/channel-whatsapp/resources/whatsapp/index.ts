/** Defines the data-only WhatsApp Channel Resource. @module */
import { defineChannelResource } from "../../../channel-core/authoring/channel-resource/index.ts";
import type { ChannelResource } from "../../../channel-core/internal/contracts.ts";
import type { CreateWhatsAppChannelResourceOptions } from "../../internal/contracts.ts";

export function createWhatsAppChannelResource(
  options: CreateWhatsAppChannelResourceOptions = {},
): ChannelResource {
  return defineChannelResource({
    egress: "external",
    ...(options.defaultAgentAliases
      ? { defaultAgentAliases: options.defaultAgentAliases }
      : {}),
    ...(options.metadata ? { metadata: options.metadata } : {}),
  });
}
