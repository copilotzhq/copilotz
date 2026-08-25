/**
 * Invokes durable channel ingress Actions for accepted provider events.
 *
 * @module
 */

import { isSettledActionError } from "@copilotz/copilotz/actions";
import type { ActionCaller } from "@copilotz/copilotz/actions";
import {
  defineProcessor,
  type Processor,
  type ProcessorContext,
} from "@copilotz/copilotz/plugins";
import type {
  ChannelActionAdapters,
  ChannelActionResources,
  channelIngressAction,
} from "../../actions/index.ts";
import {
  CHANNEL_INGRESS_INPUT_EVENT,
  type ChannelIngressInput,
} from "../../internal/contracts.ts";

type ChannelProcessorContext = ProcessorContext<
  ChannelActionResources,
  ChannelActionAdapters,
  Readonly<{
    channelIngress: ActionCaller<typeof channelIngressAction>;
  }>
>;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

async function settled(operation: () => Promise<unknown>): Promise<void> {
  try {
    await operation();
  } catch (error) {
    if (!isSettledActionError(error)) throw error;
  }
}

export const channelIngressProcessor: Processor<ChannelProcessorContext> =
  defineProcessor<ChannelProcessorContext>({
    id: "copilotz.channels.ingress-input",
    on: [{ eventType: CHANNEL_INGRESS_INPUT_EVENT }],
    async handle(event, context) {
      if (!event.durable) return;
      const payload = record(event.payload);
      await settled(() =>
        context.actions.channelIngress(
          payload as ChannelIngressInput,
          {
            operationKey: `ingress:${event.id}`,
            identity: {
              causationId: event.id,
              correlationId: event.correlationId,
              deduplicationId: event.deduplicationId,
              settlementScopeId: context.identity.settlementScopeId,
            },
            signal: context.signal,
          },
        )
      );
    },
  });
