import type { ContentInput } from "../../content/index.ts";
import type { ConversationMessage } from "../../domain/index.ts";
import { type CopilotzPlugin, definePlugin } from "../../plugins/index.ts";
import { coreMessageEnvelope } from "../helpers.ts";
import { loadChannelMessage } from "../identity.ts";
import type {
  ChannelEgressContext,
  ChannelIngressEnvelope,
  ChannelRequest,
  ChannelResource,
} from "../types.ts";
import {
  buildWhatsAppMediaCarouselMessage,
  buildWhatsAppReplyButtonsMessage,
  normalizeWhatsAppActionPayload,
  resolveWhatsAppMediaCarouselAction,
  splitWhatsAppText,
} from "./protocol.ts";
import {
  createWhatsAppGraphTransport,
  verifyWhatsAppSignature,
  whatsappHeader,
} from "./transport.ts";
import type {
  CreateWhatsAppChannelOptions,
  CreateWhatsAppChannelPluginOptions,
  WhatsAppActionPayload,
  WhatsAppConfig,
  WhatsAppDeliveryOutput,
  WhatsAppMediaCarouselAction,
  WhatsAppMediaInput,
  WhatsAppTransport,
  WhatsAppWebhookMessage,
  WhatsAppWebhookPayload,
} from "./types.ts";

const DEFAULT_MAX_STREAM_BYTES = 32 * 1024 * 1024;

function required(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`${name} must be non-empty.`);
  }
  return value.trim();
}

function queryValue(
  request: ChannelRequest,
  name: string,
): string | undefined {
  const value = request.query?.[name];
  return Array.isArray(value) ? value[0] : value as string | undefined;
}

async function resolveConfig(
  source: CreateWhatsAppChannelOptions["config"],
  request: ChannelRequest,
): Promise<WhatsAppConfig> {
  const config = typeof source === "function" ? await source(request) : source;
  if (!config || typeof config !== "object") {
    throw new TypeError("WhatsApp config resolver returned no config.");
  }
  return Object.freeze({
    accessToken: required(config.accessToken, "WhatsApp accessToken"),
    phoneId: config.phoneId?.trim() ?? "",
    ...(config.appSecret?.trim() ? { appSecret: config.appSecret.trim() } : {}),
    ...(config.webhookVerifyToken?.trim()
      ? { webhookVerifyToken: config.webhookVerifyToken.trim() }
      : {}),
    graphApiVersion: config.graphApiVersion?.trim() || "v25.0",
  });
}

function mediaDescriptor(message: WhatsAppWebhookMessage):
  | Readonly<{
    id: string;
    mediaType?: string;
    name?: string;
    kind: "image" | "audio" | "video" | "file";
  }>
  | null {
  if (message.image?.id) {
    return {
      id: message.image.id,
      mediaType: message.image.mime_type,
      kind: "image",
    };
  }
  if (message.audio?.id) {
    return {
      id: message.audio.id,
      mediaType: message.audio.mime_type,
      kind: "audio",
    };
  }
  if (message.video?.id) {
    return {
      id: message.video.id,
      mediaType: message.video.mime_type,
      kind: "video",
    };
  }
  if (message.document?.id) {
    return {
      id: message.document.id,
      mediaType: message.document.mime_type,
      name: message.document.filename,
      kind: "file",
    };
  }
  return null;
}

function caption(message: WhatsAppWebhookMessage): string | undefined {
  return message.text?.body?.trim() ||
    message.image?.caption?.trim() ||
    message.video?.caption?.trim() ||
    message.document?.caption?.trim() ||
    message.interactive?.button_reply?.title?.trim() ||
    message.interactive?.list_reply?.title?.trim() ||
    undefined;
}

async function ingressEnvelope(
  options: CreateWhatsAppChannelOptions,
  transport: WhatsAppTransport,
  config: WhatsAppConfig,
  input: Readonly<{
    businessId: string;
    phoneId?: string;
    userName?: string;
    message: WhatsAppWebhookMessage;
  }>,
): Promise<ChannelIngressEnvelope | null> {
  const senderPhone = required(input.message.from, "WhatsApp sender phone");
  const messageId = required(input.message.id, "WhatsApp message ID");
  const content: ContentInput[] = [];
  const text = caption(input.message);
  if (text) content.push({ type: "text", text });
  const descriptor = mediaDescriptor(input.message);
  if (descriptor) {
    const downloaded = await transport.download(config, descriptor);
    if (downloaded) {
      content.push({
        type: descriptor.kind,
        bytes: downloaded.bytes,
        mediaType: downloaded.mediaType,
        ...(downloaded.name || descriptor.name
          ? { name: downloaded.name || descriptor.name }
          : {}),
      });
    }
  }
  if (content.length === 0) return null;
  const externalId = options.threadExternalId?.({
    senderPhone,
    phoneId: input.phoneId,
    businessId: input.businessId,
  })?.trim() || senderPhone;
  const interactive = input.message.interactive?.button_reply ??
    input.message.interactive?.list_reply;
  return Object.freeze({
    thread: {
      externalId,
      metadata: {
        channels: {
          whatsapp: {
            recipientPhone: senderPhone,
            channelId: input.phoneId ?? null,
            businessId: input.businessId,
            userName: input.userName ?? null,
            lastInboundMessageId: messageId,
          },
        },
      },
    },
    participant: {
      externalId: senderPhone,
      participantType: "human" as const,
      ...(input.userName ? { name: input.userName } : {}),
      metadata: { phone: senderPhone, provider: "whatsapp" },
    },
    input: coreMessageEnvelope({
      thread: externalId,
      participant: {
        externalId: senderPhone,
        participantType: "human" as const,
        ...(input.userName ? { name: input.userName } : {}),
        metadata: { phone: senderPhone, provider: "whatsapp" },
      },
      content: content.length === 1 && text && !descriptor
        ? text
        : Object.freeze(content),
      id: messageId,
      correlationId: `whatsapp:${messageId}`,
      deduplicationId: `whatsapp:${messageId}`,
      metadata: {
        provider: "whatsapp",
        providerMessageId: messageId,
        ...(input.message.timestamp
          ? { providerTimestamp: input.message.timestamp }
          : {}),
        messageType: input.message.type,
        ...(interactive
          ? {
            interactive: {
              id: interactive.id ?? null,
              title: interactive.title ?? null,
              description: interactive.description ?? null,
            },
          }
          : {}),
      },
    }),
  });
}

function whatsappContext(metadata: Readonly<Record<string, unknown>>): {
  recipientPhone: string;
  channelId?: string;
} | null {
  const channels = metadata.channels;
  if (!channels || typeof channels !== "object" || Array.isArray(channels)) {
    return null;
  }
  const value = (channels as Record<string, unknown>).whatsapp;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const recipientPhone = typeof record.recipientPhone === "string"
    ? record.recipientPhone.trim()
    : "";
  if (!recipientPhone) return null;
  const channelId = typeof record.channelId === "string"
    ? record.channelId.trim()
    : "";
  return { recipientPhone, ...(channelId ? { channelId } : {}) };
}

function isStreamOutput(output: unknown): output is Extract<
  import("../../attachments/index.ts").AttachmentOutput,
  { type: "stream.output" }
> {
  return Boolean(
    output && typeof output === "object" &&
      (output as { type?: unknown }).type === "stream.output" &&
      (output as { payload?: { getReader?: unknown } }).payload &&
      typeof (output as { payload: { getReader?: unknown } }).payload
          .getReader === "function",
  );
}

async function readStream(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      if (!(item.value instanceof Uint8Array)) {
        throw new TypeError(
          "WhatsApp output stream must contain Uint8Array chunks.",
        );
      }
      length += item.value.byteLength;
      if (length > maxBytes) {
        await reader.cancel("whatsapp_output_too_large");
        throw new RangeError(
          `WhatsApp output stream exceeds ${maxBytes} bytes.`,
        );
      }
      chunks.push(item.value.slice());
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

async function sendText(
  transport: WhatsAppTransport,
  config: WhatsAppConfig,
  to: string,
  text: string,
): Promise<void> {
  for (const chunk of splitWhatsAppText(text)) {
    await transport.send(config, {
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body: chunk },
    });
  }
}

async function sendMedia(
  transport: WhatsAppTransport,
  config: WhatsAppConfig,
  to: string,
  media: WhatsAppMediaInput,
): Promise<void> {
  const uploaded = await transport.upload(config, media);
  await transport.send(config, {
    messaging_product: "whatsapp",
    to,
    type: uploaded.type,
    [uploaded.type]: {
      id: uploaded.id,
      ...(uploaded.type === "document" && media.name
        ? { filename: media.name }
        : {}),
    },
  });
}

async function transformed(
  options: CreateWhatsAppChannelOptions,
  output: WhatsAppDeliveryOutput,
  context: ChannelEgressContext,
): Promise<WhatsAppDeliveryOutput | null> {
  return options.transformOutput
    ? await options.transformOutput(output, context)
    : output;
}

async function deliverOutput(
  options: CreateWhatsAppChannelOptions,
  transport: WhatsAppTransport,
  config: WhatsAppConfig,
  context: ChannelEgressContext,
  original: WhatsAppDeliveryOutput,
): Promise<void> {
  const output = await transformed(options, original, context);
  if (!output) return;
  if (output.kind === "text") {
    if (output.text.trim()) {
      await sendText(transport, config, output.to, output.text);
    }
    return;
  }
  if (output.kind === "media") {
    await sendMedia(transport, config, output.to, output.media);
    return;
  }
  if (output.kind === "reply_buttons") {
    const body = buildWhatsAppReplyButtonsMessage(output.to, output.action);
    if (body) await transport.send(config, body);
    return;
  }
  const action = await resolveWhatsAppMediaCarouselAction(
    output.action,
    (media) => transport.upload(config, media),
  );
  const body = action
    ? buildWhatsAppMediaCarouselMessage(output.to, action)
    : null;
  if (body) {
    await transport.send(config, body);
    return;
  }
  const fallback = output.action.fallbackText?.trim() ||
    output.action.message?.trim();
  if (fallback) await sendText(transport, config, output.to, fallback);
}

async function deliverMessage(
  options: CreateWhatsAppChannelOptions,
  transport: WhatsAppTransport,
  config: WhatsAppConfig,
  context: ChannelEgressContext,
  to: string,
  message: ConversationMessage,
  output: import("../../attachments/index.ts").AttachmentOutput,
): Promise<void> {
  if (message.sender.participantType !== "agent") return;
  const content = await context.application.content.resolver.getMany(
    message.content,
    { namespace: context.namespace },
  );
  for (const item of content) {
    if (item.ref.kind === "text" && item.text) {
      await deliverOutput(options, transport, config, context, {
        kind: "text",
        to,
        text: item.text,
        output,
      });
      continue;
    }
    if (item.ref.kind === "json") {
      const text = item.text ?? JSON.stringify(item.value);
      if (text) {
        await deliverOutput(options, transport, config, context, {
          kind: "text",
          to,
          text,
          output,
        });
      }
      continue;
    }
    await deliverOutput(options, transport, config, context, {
      kind: "media",
      to,
      media: {
        bytes: item.bytes,
        mediaType: item.ref.mediaType,
        ...(item.ref.name ? { name: item.ref.name } : {}),
      },
      output,
    });
  }
}

function actionPayload(value: unknown): WhatsAppActionPayload | null {
  const action = normalizeWhatsAppActionPayload(value);
  return action?.type === "reply_buttons" || action?.type === "media_carousel"
    ? action
    : null;
}

/** Creates an attachment-native WhatsApp channel. */
export function createWhatsAppChannel(
  options: CreateWhatsAppChannelOptions,
): ChannelResource {
  if (!options?.config) {
    throw new TypeError("WhatsApp channel requires config.");
  }
  const id = options.id?.trim() || "whatsapp";
  const transport = options.transport ??
    createWhatsAppGraphTransport({ fetch: options.fetch });
  const maxStreamBytes = options.maxStreamBytes ?? DEFAULT_MAX_STREAM_BYTES;
  if (!Number.isSafeInteger(maxStreamBytes) || maxStreamBytes < 1) {
    throw new TypeError("WhatsApp maxStreamBytes must be positive.");
  }
  return Object.freeze({
    id,
    ...(options.defaultAgentIds?.length
      ? { defaultAgentIds: Object.freeze([...options.defaultAgentIds]) }
      : {}),
    ingress: Object.freeze({
      async handle(request: ChannelRequest) {
        const config = await resolveConfig(options.config, request);
        if (request.method.toUpperCase() === "GET") {
          const accepted = queryValue(request, "hub.mode") === "subscribe" &&
            queryValue(request, "hub.verify_token") ===
              (config.webhookVerifyToken ?? "");
          return accepted
            ? {
              status: 200,
              response: queryValue(request, "hub.challenge") ?? "",
              inputs: Object.freeze([]),
            }
            : {
              status: 403,
              response: { error: "Forbidden" },
              inputs: Object.freeze([]),
            };
        }
        if (config.appSecret) {
          const signature = whatsappHeader(
            request.headers,
            "x-hub-signature-256",
          );
          if (!signature) {
            return {
              status: 403,
              response: { error: "Missing X-Hub-Signature-256 header" },
              inputs: Object.freeze([]),
            };
          }
          if (!request.rawBody) {
            return {
              status: 400,
              response: {
                error: "Raw body required for signature verification",
              },
              inputs: Object.freeze([]),
            };
          }
          if (
            !await verifyWhatsAppSignature(
              request.rawBody,
              config.appSecret,
              signature,
            )
          ) {
            return {
              status: 403,
              response: { error: "Invalid webhook signature" },
              inputs: Object.freeze([]),
            };
          }
        }
        const payload = request.body as WhatsAppWebhookPayload;
        const inputs: ChannelIngressEnvelope[] = [];
        for (const entry of payload?.entry ?? []) {
          for (const change of entry.changes ?? []) {
            const value = change.value;
            const userName = value?.contacts?.[0]?.profile?.name;
            const phoneId = value?.metadata?.phone_number_id;
            for (const message of value?.messages ?? []) {
              const envelope = await ingressEnvelope(
                options,
                transport,
                { ...config, phoneId: phoneId?.trim() || config.phoneId },
                { businessId: entry.id, phoneId, userName, message },
              );
              if (envelope) inputs.push(envelope);
            }
          }
        }
        return {
          status: 200,
          response: { status: "ok" },
          inputs: Object.freeze(inputs),
        };
      },
    }),
    egress: Object.freeze({
      async deliver(context: ChannelEgressContext) {
        const route = whatsappContext(context.execution.thread.metadata);
        if (!route) {
          throw new Error(
            "Thread metadata is missing WhatsApp recipient routing information.",
          );
        }
        const baseConfig = await resolveConfig(options.config, context.request);
        const config = Object.freeze({
          ...baseConfig,
          phoneId: route.channelId || required(
            baseConfig.phoneId,
            "WhatsApp phoneId",
          ),
        });
        const deliveredMessages = new Set<string>();
        for await (const output of context.execution.outputs) {
          if (isStreamOutput(output)) {
            if (output.participant.type !== "agent") {
              await output.payload.cancel("whatsapp_non_agent_stream").catch(
                () => undefined,
              );
              continue;
            }
            const bytes = await readStream(output.payload, maxStreamBytes);
            if (bytes.byteLength) {
              await deliverOutput(options, transport, config, context, {
                kind: "media",
                to: route.recipientPhone,
                media: { bytes, mediaType: output.mediaType },
                output,
              });
            }
            continue;
          }
          if (output.type === "message.created" && output.durable) {
            const messageId = output.subject?.type === "message"
              ? output.subject.id
              : output.payload && typeof output.payload === "object" &&
                  typeof (output.payload as Record<string, unknown>)
                      .messageId ===
                    "string"
              ? (output.payload as Record<string, string>).messageId
              : "";
            if (!messageId || deliveredMessages.has(messageId)) continue;
            deliveredMessages.add(messageId);
            const message = await loadChannelMessage(
              context.application,
              context.namespace,
              messageId,
            );
            if (message) {
              await deliverMessage(
                options,
                transport,
                config,
                context,
                route.recipientPhone,
                message,
                output,
              );
            }
            continue;
          }
          if (output.type !== "action.created") continue;
          const action = actionPayload(output.payload);
          if (!action) continue;
          await deliverOutput(
            options,
            transport,
            config,
            context,
            action.type === "media_carousel"
              ? {
                kind: "media_carousel",
                to: route.recipientPhone,
                action: action as WhatsAppMediaCarouselAction,
                output,
              }
              : {
                kind: "reply_buttons",
                to: route.recipientPhone,
                action,
                output,
              },
          );
        }
      },
    }),
  });
}

export function createWhatsAppChannelPlugin(
  options: CreateWhatsAppChannelPluginOptions,
): CopilotzPlugin {
  const channel = createWhatsAppChannel(options);
  return definePlugin({
    id: options.pluginId?.trim() || "@copilotz/channel-whatsapp",
    version: options.version?.trim() || "3.0.0",
    resources: { channels: { [channel.id]: channel } },
  });
}
