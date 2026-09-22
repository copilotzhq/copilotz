/**
 * Delivers prepared channel intents through retryable provider adapters.
 *
 * @module
 */

import { isSettledActionError } from "@copilotz/copilotz/actions";
import type { ActionCaller } from "@copilotz/copilotz/actions";
import { type ContentRef, isContentRef } from "@copilotz/copilotz/content";
import {
  defineProcessor,
  type Processor,
  type ProcessorContext,
} from "@copilotz/copilotz/plugins";
import type {
  ChannelActionAdapters,
  ChannelActionResources,
} from "../../actions/ingress/index.ts";
import type { channelEgressAction } from "../../actions/egress/index.ts";
import { defineChannelResource } from "../../authoring/channel-resource/index.ts";
import type { ChannelEgressMessage } from "../../shared/contracts.ts";
import { isPublicChannelMessage } from "../../shared/helpers.ts";

type ChannelProcessorContext = ProcessorContext<
  ChannelActionResources,
  ChannelActionAdapters,
  Readonly<{ channelEgress: ActionCaller<typeof channelEgressAction> }>
>;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function optionalRecord(
  value: unknown,
): Record<string, unknown> | null | undefined {
  if (value === undefined) return undefined;
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function eventVisibility(
  event: { metadata?: Readonly<Record<string, unknown>> },
): ChannelEgressMessage["visibility"] | null | undefined {
  const metadata = optionalRecord(event.metadata);
  if (metadata === null) return null;
  if (!metadata || metadata.core === undefined) return undefined;
  const core = optionalRecord(metadata.core);
  if (!core) return null;
  // Core treats an omitted envelope visibility as public. Explicit row
  // restrictions still apply independently below.
  if (core.visibility === undefined) return undefined;
  const visibility = optionalRecord(core.visibility);
  return visibility === null
    ? null
    : visibility as ChannelEgressMessage["visibility"];
}

function text(value: unknown): string {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function content(value: unknown): ChannelEgressMessage["content"] | null {
  if (!Array.isArray(value) || !value.every(isContentRef)) return null;
  return value.map((ref) => {
    const entry = ref as ContentRef;
    return {
      assetId: entry.assetId,
      kind: entry.kind,
      role: entry.role,
      mediaType: entry.mediaType,
      ...(entry.name === undefined ? {} : { name: entry.name }),
      ...(entry.alt === undefined ? {} : { alt: entry.alt }),
      ...(entry.language === undefined ? {} : { language: entry.language }),
      ...(entry.disposition === undefined
        ? {}
        : { disposition: entry.disposition }),
      ...(entry.metadata === undefined ? {} : { metadata: entry.metadata }),
    };
  });
}

function message(value: Record<string, unknown>): ChannelEgressMessage | null {
  const id = text(value.id);
  const senderId = text(value.senderId);
  const threadId = text(value.threadId);
  const entries = content(value.content);
  if (!id || !senderId || !threadId || !entries) {
    return null;
  }
  const metadata = optionalRecord(value.metadata);
  const visibility = optionalRecord(value.visibility);
  if (metadata === null || visibility === null) return null;
  const historyScopeId = value.historyScopeId;
  if (historyScopeId !== undefined && typeof historyScopeId !== "string") {
    return null;
  }
  const recipientIds = value.recipientIds;
  if (
    recipientIds !== undefined &&
    (!Array.isArray(recipientIds) ||
      !recipientIds.every((entry) =>
        typeof entry === "string" && entry.trim().length > 0
      ))
  ) return null;
  return {
    id,
    senderId,
    threadId,
    content: entries,
    ...(visibility === undefined ? {} : {
      visibility: visibility as ChannelEgressMessage["visibility"],
    }),
    ...(historyScopeId === undefined ? {} : { historyScopeId }),
    ...(recipientIds === undefined ? {} : { recipientIds }),
    metadata: (metadata ?? {}) as ChannelEgressMessage["metadata"],
  };
}

function receipt(
  value: { deliveryKey: string; delivered: number } | void,
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

export const channelEgressProcessor: Processor<ChannelProcessorContext> =
  defineProcessor<ChannelProcessorContext>({
    id: "copilotz.channels.external-egress",
    on: [{ eventType: "message.created", subject: { type: "message" } }],
    settlement: "detached",
    async handle(event, context) {
      if (!event.durable) return;
      let snapshot = message(record(record(event.data).record));
      if (!snapshot) return;
      const envelopeVisibility = eventVisibility(event);
      if (envelopeVisibility === null) return;
      if (envelopeVisibility !== undefined) {
        if (
          !isPublicChannelMessage({
            ...snapshot,
            visibility: envelopeVisibility,
          })
        ) return;
        if (snapshot.visibility === undefined) {
          snapshot = { ...snapshot, visibility: envelopeVisibility };
        }
      }
      if (!isPublicChannelMessage(snapshot)) return;
      const messageId = snapshot.id;
      const senderId = snapshot.senderId;
      const sender = await context.collections.participant.get({
        id: senderId,
      });
      if (sender?.participantType !== "agent") return;
      const threadId = snapshot.threadId;
      const bindings = await context.collections.channelBinding.queries
        .byThreadId({ threadId });
      const hasExternalBinding = bindings.some((binding) => {
        const channelId = text(binding.channelId);
        const channel = channelId
          ? context.resources.channels?.[channelId]
          : undefined;
        return channel !== undefined &&
          defineChannelResource(channel).egress === "external";
      });
      if (!hasExternalBinding) return;
      let output;
      try {
        output = await context.actions.channelEgress({
          messageId,
          message: snapshot,
        }, {
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
        const result = await adapter.deliver(
          {
            intent,
            content: await context.content.resolveMany(intent.content),
          } as const,
          {
            namespace: context.namespace,
            resources: context.resources,
            adapters: context.adapters,
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

export default channelEgressProcessor;
