/** Sends one captured channel intent under the external-effect protocol. @module */
import {
  type ActionDefinition,
  defineAction,
  externalEffect,
} from "@copilotz/copilotz/actions";
import type { ChannelActionContext } from "../ingress/index.ts";
import type {
  ChannelDeliveryIntent,
  ChannelDeliveryReceipt,
} from "../../shared/contracts.ts";
import { defineChannelResource } from "../../authoring/channel-resource/index.ts";

export const channelDeliverAction: ActionDefinition<
  ChannelDeliveryIntent,
  ChannelDeliveryReceipt,
  ChannelActionContext
> = defineAction({
  id: "copilotz.channels.deliver",
  execute: (intent: ChannelDeliveryIntent, context: ChannelActionContext) =>
    externalEffect(context, "channel.deliver", async () => {
      const channel = context.resources.channels?.[intent.channelId];
      if (!channel) {
        throw new Error(
          `Unknown Channel Resource alias '${intent.channelId}'.`,
        );
      }
      const resource = defineChannelResource(channel);
      if (resource.egress !== "external") {
        throw new Error(
          `Channel '${intent.channelId}' is not configured for external egress.`,
        );
      }
      const adapter = context.adapters.channels?.[intent.channelId];
      if (!adapter || typeof adapter.deliver !== "function") {
        throw new Error(
          `Channel Adapter '${intent.channelId}' cannot deliver externally.`,
        );
      }
      const content = await context.content.resolveMany(intent.content);
      const result = await adapter.deliver!({ intent, content }, {
        namespace: context.namespace,
        resources: context.resources,
        adapters: context.adapters,
        channelId: intent.channelId,
        channel: resource,
        signal: context.signal,
        now: context.now,
      });
      if (
        result !== undefined &&
        (result.deliveryKey !== intent.deliveryKey ||
          !Number.isSafeInteger(result.delivered) || result.delivered < 0)
      ) {
        throw new TypeError("Invalid channel delivery receipt.");
      }
      return result ?? { deliveryKey: intent.deliveryKey, delivered: 0 };
    }),
});
export default channelDeliverAction;
