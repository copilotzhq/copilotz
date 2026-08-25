/** Composes the shared Channel graph, actions, and processors. @module */

import { type CopilotzPlugin, definePlugin } from "@copilotz/copilotz/plugins";
import { corePlugin } from "@copilotz/copilotz/core";
import { channelEgressAction, channelIngressAction } from "./actions/index.ts";
import { channelBindingCollection } from "./collections/index.ts";
import {
  channelEgressProcessor,
  channelIngressProcessor,
} from "./processors/index.ts";

export const CHANNELS_PLUGIN_ID = "@copilotz/channels";
export const CHANNELS_PLUGIN_VERSION = "0.63.0";

type EmptyMap = Readonly<Record<never, never>>;
type ChannelsCollections = Readonly<{
  channelBinding: typeof channelBindingCollection;
}>;
type ChannelsActions = Readonly<{
  channelIngress: typeof channelIngressAction;
  channelEgress: typeof channelEgressAction;
}>;
type ChannelsProcessors = Readonly<{
  channelIngress: typeof channelIngressProcessor;
  channelEgress: typeof channelEgressProcessor;
}>;

/** Core graph integration shared by every concrete Channel provider. */
export const channelsPlugin: CopilotzPlugin<
  typeof CHANNELS_PLUGIN_ID,
  typeof CHANNELS_PLUGIN_VERSION,
  readonly [typeof corePlugin],
  ChannelsCollections,
  ChannelsActions,
  ChannelsProcessors,
  EmptyMap,
  EmptyMap
> = definePlugin({
  id: CHANNELS_PLUGIN_ID,
  version: CHANNELS_PLUGIN_VERSION,
  plugins: [corePlugin] as const,
  collections: { channelBinding: channelBindingCollection },
  actions: {
    channelIngress: channelIngressAction,
    channelEgress: channelEgressAction,
  },
  processors: {
    channelIngress: channelIngressProcessor,
    channelEgress: channelEgressProcessor,
  },
});
