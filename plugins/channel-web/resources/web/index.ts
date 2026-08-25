/**
 * Defines the data-only Web Channel Resource.
 *
 * @module
 */

import { defineChannelResource } from "../../../channel-core/authoring/channel-resource/index.ts";
import type {
  ChannelJsonObject,
  ChannelResource,
} from "../../../channel-core/internal/contracts.ts";

export type CreateWebChannelResourceOptions = Readonly<{
  defaultAgentAliases?: readonly string[];
  metadata?: ChannelJsonObject;
}>;

/** Data-only request-observation policy; its map alias is supplied by composition. */
export function createWebChannelResource(
  options: CreateWebChannelResourceOptions = {},
): ChannelResource {
  return defineChannelResource({
    egress: "request-observation",
    ...(options.defaultAgentAliases
      ? { defaultAgentAliases: options.defaultAgentAliases }
      : {}),
    ...(options.metadata ? { metadata: options.metadata } : {}),
  });
}
