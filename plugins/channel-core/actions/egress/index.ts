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
import {
  type ContentRef,
  type ContentSequence,
  isContentRef,
} from "@copilotz/copilotz/content";
import { deriveWorkflowId } from "@copilotz/copilotz/events";
import { cloneChannelJson } from "../../authoring/channel-ingress/index.ts";
import { defineChannelResource } from "../../authoring/channel-resource/index.ts";
import type {
  ChannelBindingRecord,
  ChannelDeliveryIntent,
  ChannelEgressActionInput,
  ChannelEgressActionOutput,
  ChannelEgressMessage,
  ChannelJsonObject,
  ChannelResource,
} from "../../shared/contracts.ts";
import { isPublicChannelMessage } from "../../shared/helpers.ts";
import type { ChannelActionContext } from "../ingress/index.ts";

export const CHANNEL_EGRESS_ACTION_ID = "copilotz.channels.egress";

const egressSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    messageId: { type: "string" },
    message: { type: "object" },
  },
  required: ["messageId"],
} as const;

const EGRESS_INPUT_KEYS = new Set(["messageId", "message"]);
const EGRESS_MESSAGE_KEYS = new Set([
  "id",
  "senderId",
  "threadId",
  "visibility",
  "historyScopeId",
  "recipientIds",
  "content",
  "metadata",
]);

function text(value: unknown, label: string): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) throw new TypeError(`${label} must be non-empty.`);
  return normalized;
}

function optionalText(value: unknown, label: string): string | undefined {
  return value === undefined ? undefined : text(value, label);
}

function fields(
  value: unknown,
  allowed: ReadonlySet<string>,
  label: string,
): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be a plain object.`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${label} must be a plain object.`);
  }
  const result: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !allowed.has(key)) {
      throw new TypeError(`${label} cannot declare '${String(key)}'.`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      throw new TypeError(
        `${label}.${key} must be an enumerable data property.`,
      );
    }
    if (descriptor.value === undefined) {
      throw new TypeError(`${label}.${key} cannot be undefined.`);
    }
    result[key] = descriptor.value;
  }
  return result;
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
  return (Array.from({ length: value.length }, (_, index) => {
    const descriptor = descriptors[String(index)];
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      throw new TypeError(`${label}[${index}] must be a data property.`);
    }
    return descriptor.value;
  }));
}

function contentSequence(value: unknown): ContentSequence {
  return (dataArray(value, "Channel delivery content").map(
    (value, index): ContentRef => {
      if (!isContentRef(value)) {
        throw new TypeError(
          `Channel delivery content[${index}] must be a ref.`,
        );
      }
      const ref = value as ContentRef;
      return {
        assetId: text(
          ref.assetId,
          `Channel delivery content[${index}] Asset ID`,
        ),
        kind: ref.kind,
        role: text(ref.role, `Channel delivery content[${index}] role`),
        mediaType: text(
          ref.mediaType,
          `Channel delivery content[${index}] media type`,
        ),
        ...(ref.name === undefined ? {} : {
          name: text(ref.name, `Channel delivery content[${index}] name`),
        }),
        ...(ref.alt === undefined ? {} : {
          alt: text(ref.alt, `Channel delivery content[${index}] alt`),
        }),
        ...(ref.language === undefined ? {} : {
          language: text(
            ref.language,
            `Channel delivery content[${index}] language`,
          ),
        }),
        ...(ref.disposition === undefined
          ? {}
          : { disposition: ref.disposition }),
        ...(ref.metadata === undefined ? {} : {
          metadata: object(
            ref.metadata,
            `Channel delivery content[${index}] metadata`,
          ) as unknown as Record<string, unknown>,
        }),
      } as const;
    },
  ));
}

function isDeliverableContent(ref: ContentRef): boolean {
  return (ref.kind === "text" || ref.kind === "json")
    ? ref.role === "body"
    : ref.role === "body" || ref.role === "attachment";
}

function message(value: unknown): ChannelEgressMessage {
  const snapshot = fields(value, EGRESS_MESSAGE_KEYS, "Channel egress message");
  const visibility = snapshot.visibility === undefined
    ? undefined
    : object(snapshot.visibility, "Channel egress message visibility");
  let historyScopeId: string | undefined;
  if (snapshot.historyScopeId !== undefined) {
    if (typeof snapshot.historyScopeId !== "string") {
      throw new TypeError(
        "Channel egress message history scope ID must be a string.",
      );
    }
    historyScopeId = snapshot.historyScopeId;
  }
  const recipientIds = snapshot.recipientIds === undefined
    ? undefined
    : dataArray(
      snapshot.recipientIds,
      "Channel egress message recipient IDs",
    ).map((value, index) =>
      text(value, `Channel egress message recipient ID[${index}]`)
    );
  return {
    id: text(snapshot.id, "Channel egress message ID"),
    senderId: text(snapshot.senderId, "Channel egress message sender ID"),
    threadId: text(snapshot.threadId, "Channel egress message thread ID"),
    ...(visibility ? { visibility } : {}),
    ...(historyScopeId === undefined ? {} : { historyScopeId }),
    ...(recipientIds ? { recipientIds } : {}),
    content: contentSequence(snapshot.content),
    metadata: object(snapshot.metadata, "Channel egress message metadata"),
  };
}

function input(value: unknown): ChannelEgressActionInput {
  const raw = fields(value, EGRESS_INPUT_KEYS, "Channel egress Action input");
  const messageId = text(raw.messageId, "Channel egress message ID");
  const snapshot = raw.message === undefined ? undefined : message(raw.message);
  if (snapshot && snapshot.id !== messageId) {
    throw new TypeError(
      "Channel egress message snapshot ID must match messageId.",
    );
  }
  return {
    messageId,
    ...(snapshot ? { message: snapshot } : {}),
  };
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
  const actionInput = input(rawInput);
  const messageId = actionInput.messageId;
  const message = actionInput.message ??
    await context.collections.message.get({ id: messageId });
  if (!message) throw new Error(`Message '${messageId}' was not found.`);
  if (!isPublicChannelMessage(message)) return ({ intents: [] as const });
  const sender = await context.collections.participant.get({
    id: text(message.senderId, "Message sender ID"),
  });
  if (!sender || sender.participantType !== "agent") {
    return ({ intents: [] as const } as const);
  }
  const threadId = text(message.threadId, "Message thread ID");
  const bindings = await context.collections.channelBinding.queries.byThreadId({
    threadId,
  });
  const originalContent = contentSequence(message.content);
  const content = originalContent.filter(isDeliverableContent);
  if (originalContent.length > 0 && content.length === 0) {
    return ({ intents: [] as const });
  }
  const intents: ChannelDeliveryIntent[] = [];
  for (const value of bindings) {
    const binding = bindingRecord(value);
    const channelId = text(binding.channelId, "Binding Channel ID");
    if (channel(context, channelId).egress !== "external") continue;
    const deliveryKey = await deriveWorkflowId(
      "channel-delivery",
      identityTuple(binding.id, messageId),
    );
    intents.push(
      {
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
        sender: {
          id: sender.id,
          externalId: text(
            sender.externalId ?? sender.id,
            "Channel delivery sender external ID",
          ),
          participantType: "agent",
          ...(optionalText(sender.name, "Channel delivery sender name")
            ? {
              name: optionalText(sender.name, "Channel delivery sender name"),
            }
            : {}),
          ...(optionalText(sender.agentId, "Channel delivery sender Agent ID")
            ? {
              agentId: optionalText(
                sender.agentId,
                "Channel delivery sender Agent ID",
              ),
            }
            : {}),
        } as const,
        content,
        metadata: object({
          binding: binding.metadata,
          message: message.metadata ?? {},
        }, "Channel delivery metadata"),
      } as const,
    );
  }
  return ({ intents: intents } as const);
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

export default channelEgressAction;
