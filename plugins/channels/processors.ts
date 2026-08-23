import {
  type ActionCaller,
  isSettledActionError,
} from "@copilotz/copilotz/actions";
import {
  defineProcessor,
  type Processor,
  type ProcessorContext,
} from "@copilotz/copilotz/plugins";
import type {
  ChannelActionAdapters,
  ChannelActionResources,
  channelEgressAction,
  channelIngressAction,
} from "./actions.ts";
import { defineChannelResource } from "./resource.ts";
import {
  CHANNEL_INGRESS_INPUT_EVENT,
  type ChannelDeliveryReceipt,
  type ChannelIngressInput,
} from "./types.ts";

type ChannelProcessorContext = ProcessorContext<
  ChannelActionResources,
  ChannelActionAdapters,
  Readonly<{
    channelIngress: ActionCaller<typeof channelIngressAction>;
    channelEgress: ActionCaller<typeof channelEgressAction>;
  }>
>;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function text(value: unknown): string {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

async function settled(operation: () => Promise<unknown>): Promise<void> {
  try {
    await operation();
  } catch (error) {
    if (!isSettledActionError(error)) throw error;
  }
}

function receipt(
  value: ChannelDeliveryReceipt | void,
  deliveryKey: string,
): void {
  if (value === undefined) return;
  if (value.deliveryKey !== deliveryKey) {
    throw new Error(
      `Channel delivery receipt '${value.deliveryKey}' does not match '${deliveryKey}'.`,
    );
  }
  if (!Number.isSafeInteger(value.delivered) || value.delivered < 0) {
    throw new TypeError("Channel delivery receipt count must be non-negative.");
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

/**
 * External I/O stays in the retryable Processor. Its Action only prepares a
 * stable durable intent, so retries reuse one delivery key and canonical refs.
 */
export const channelEgressProcessor: Processor<ChannelProcessorContext> =
  defineProcessor<ChannelProcessorContext>({
    id: "copilotz.channels.external-egress",
    on: [{ eventType: "message.created", subject: { type: "message" } }],
    settlement: "detached",
    async handle(event, context) {
      if (!event.durable) return;
      const messageId = text(
        record(event.data).record &&
          record(record(event.data).record).id,
      ) || text(event.subject?.id);
      if (!messageId) return;
      const message = await context.collections.message.get({ id: messageId });
      if (!message) return;
      const senderId = text(message.senderId);
      if (!senderId) return;
      const sender = await context.collections.participant.get({
        id: senderId,
      });
      if (sender?.participantType !== "agent") return;
      const threadId = text(message.threadId);
      if (!threadId) return;
      const bindings = await context.collections.channelBinding.queries
        .byThreadId({ threadId });
      const hasExternalBinding = bindings.some((binding) => {
        const channelId = text(binding.channelId);
        if (!channelId) return false;
        const channel = context.resources.channels?.[channelId];
        return channel !== undefined &&
          defineChannelResource(channel).egress === "external";
      });
      if (!hasExternalBinding) return;
      let output;
      try {
        output = await context.actions.channelEgress({ messageId }, {
          operationKey: `egress:${messageId}`,
          identity: {
            causationId: event.id,
            correlationId: event.correlationId,
            settlementScopeId: context.identity.settlementScopeId,
          },
          signal: context.signal,
        });
      } catch (error) {
        if (isSettledActionError(error)) return;
        throw error;
      }
      for (const intent of output.intents) {
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
        const resolved = await context.content.resolveMany(intent.content);
        const result = await adapter.deliver(
          Object.freeze({
            intent,
            content: Object.freeze(resolved),
          }),
          {
            namespace: context.namespace,
            channelId: intent.channelId,
            channel: resource,
            signal: context.signal,
            now: context.now,
          },
        );
        receipt(result, intent.deliveryKey);
      }
    },
  });
