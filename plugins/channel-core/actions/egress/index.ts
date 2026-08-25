/**
 * Prepares stable external delivery intents for one agent message.
 *
 * @module
 */

import {
  type ActionDefinition,
  defineAction,
} from "@copilotz/copilotz/actions";
import type { CollectionRecord } from "@copilotz/copilotz/collections";
import type { ContentRef, ContentSequence } from "@copilotz/copilotz/content";
import { deriveWorkflowId } from "@copilotz/copilotz/events";
import { cloneChannelJson } from "../../authoring/channel-ingress/index.ts";
import { defineChannelResource } from "../../authoring/channel-resource/index.ts";
import type {
  ChannelBindingRecord,
  ChannelDeliveryIntent,
  ChannelEgressActionInput,
  ChannelEgressActionOutput,
  ChannelJsonObject,
  ChannelResource,
} from "../../internal/contracts.ts";
import type { ChannelActionContext } from "../ingress/index.ts";

export const CHANNEL_EGRESS_ACTION_ID = "copilotz.channels.egress";

const egressSchema = {
  type: "object",
  additionalProperties: false,
  properties: { messageId: { type: "string" } },
  required: ["messageId"],
} as const;

function text(value: unknown, label: string): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) throw new TypeError(`${label} must be non-empty.`);
  return normalized;
}

function optionalText(value: unknown, label: string): string | undefined {
  return value === undefined ? undefined : text(value, label);
}

function input(value: unknown): ChannelEgressActionInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Channel egress Action input must be a plain object.");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("Channel egress Action input must be a plain object.");
  }
  const keys = Reflect.ownKeys(value);
  if (keys.length !== 1 || keys[0] !== "messageId") {
    throw new TypeError(
      "Channel egress Action input cannot declare extra properties.",
    );
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, "messageId");
  if (
    !descriptor?.enumerable || !("value" in descriptor) ||
    descriptor.value === undefined
  ) {
    throw new TypeError(
      "Channel egress Action input.messageId must be an enumerable data property.",
    );
  }
  return Object.freeze({
    messageId: text(descriptor.value, "Channel egress message ID"),
  });
}

function object(value: unknown, label: string): ChannelJsonObject {
  const cloned = cloneChannelJson(value, label);
  if (!cloned || typeof cloned !== "object" || Array.isArray(cloned)) {
    throw new TypeError(`${label} must be a JSON object.`);
  }
  return cloned as ChannelJsonObject;
}

function dataArray(value: unknown, label: string): readonly unknown[] {
  if (
    !Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype
  ) {
    throw new TypeError(`${label} must be an exact array.`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    Object.keys(value).length !== value.length ||
    Reflect.ownKeys(value).some((key) =>
      key !== "length" &&
      (typeof key !== "string" || !/^(0|[1-9][0-9]*)$/.test(key) ||
        Number(key) >= value.length)
    )
  ) {
    throw new TypeError(`${label} must be a dense data array.`);
  }
  return Object.freeze(Array.from({ length: value.length }, (_, index) => {
    const descriptor = descriptors[String(index)];
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      throw new TypeError(`${label}[${index}] must be a data property.`);
    }
    return descriptor.value;
  }));
}

function contentSequence(value: unknown): ContentSequence {
  return Object.freeze(
    dataArray(value, "Channel delivery content").map((value, index) => {
      const cloned = cloneChannelJson(
        value,
        `Channel delivery content[${index}]`,
      );
      if (!cloned || typeof cloned !== "object" || Array.isArray(cloned)) {
        throw new TypeError(
          `Channel delivery content[${index}] must be a ref.`,
        );
      }
      const ref = cloned as unknown as ContentRef;
      text(ref.assetId, `Channel delivery content[${index}] Asset ID`);
      text(ref.kind, `Channel delivery content[${index}] kind`);
      text(ref.role, `Channel delivery content[${index}] role`);
      text(ref.mediaType, `Channel delivery content[${index}] media type`);
      return Object.freeze(ref);
    }),
  );
}

function channel(
  context: ChannelActionContext,
  channelId: string,
): ChannelResource {
  const value = context.resources.channels?.[channelId];
  if (!value) throw new Error(`Unknown Channel Resource alias '${channelId}'.`);
  return defineChannelResource(value);
}

function bindingRecord(value: CollectionRecord): ChannelBindingRecord {
  return value as ChannelBindingRecord;
}

function identityTuple(...parts: readonly string[]): string {
  return JSON.stringify(["copilotz.channels.v1", ...parts]);
}

async function execute(
  rawInput: ChannelEgressActionInput,
  context: ChannelActionContext,
): Promise<ChannelEgressActionOutput> {
  const messageId = input(rawInput).messageId;
  const message = await context.collections.message.get({ id: messageId });
  if (!message) throw new Error(`Message '${messageId}' was not found.`);
  const sender = await context.collections.participant.get({
    id: text(message.senderId, "Message sender ID"),
  });
  if (!sender || sender.participantType !== "agent") {
    return Object.freeze({ intents: Object.freeze([]) });
  }
  const threadId = text(message.threadId, "Message thread ID");
  const bindings = await context.collections.channelBinding.queries.byThreadId({
    threadId,
  });
  const content = contentSequence(message.content);
  const intents: ChannelDeliveryIntent[] = [];
  for (const value of bindings) {
    const binding = bindingRecord(value);
    const channelId = text(binding.channelId, "Binding Channel ID");
    if (channel(context, channelId).egress !== "external") continue;
    const deliveryKey = await deriveWorkflowId(
      "channel-delivery",
      identityTuple(binding.id, messageId),
    );
    intents.push(Object.freeze({
      deliveryKey,
      bindingId: binding.id,
      channelId,
      externalThreadId: text(
        binding.externalThreadId,
        "Binding external thread ID",
      ),
      threadId,
      messageId,
      route: object(binding.route, "Channel delivery route"),
      sender: Object.freeze({
        id: sender.id,
        externalId: text(
          sender.externalId ?? sender.id,
          "Channel delivery sender external ID",
        ),
        participantType: "agent",
        ...(optionalText(sender.name, "Channel delivery sender name")
          ? { name: optionalText(sender.name, "Channel delivery sender name") }
          : {}),
        ...(optionalText(sender.agentId, "Channel delivery sender Agent ID")
          ? {
            agentId: optionalText(
              sender.agentId,
              "Channel delivery sender Agent ID",
            ),
          }
          : {}),
      }),
      content,
      metadata: object({
        binding: binding.metadata,
        message: message.metadata ?? {},
      }, "Channel delivery metadata"),
    }));
  }
  return Object.freeze({ intents: Object.freeze(intents) });
}

export const channelEgressAction: ActionDefinition<
  ChannelEgressActionInput,
  ChannelEgressActionOutput,
  ChannelActionContext,
  typeof egressSchema,
  undefined
> = defineAction({
  id: CHANNEL_EGRESS_ACTION_ID,
  inputSchema: egressSchema,
  execute,
});
