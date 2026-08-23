import {
  base64ToBytes,
  bytesToBase64,
  type ContentInput,
  type ResolvedContent,
} from "@copilotz/copilotz/content";
import { definePlugin } from "@copilotz/copilotz/plugins";
import {
  outboundText,
  providerRecord,
  requestHeader,
  requiredProviderText,
  timingSafeTextEqual,
} from "../helpers.ts";
import { channelsPlugin } from "../plugin.ts";
import { defineChannelResource } from "../resource.ts";
import type {
  ChannelAdapter,
  ChannelDeliveryAttempt,
  ChannelJsonObject,
  ChannelProviderPlugin,
  ChannelResource,
} from "../types.ts";
import { createZendeskTransport } from "./transport.ts";
import type {
  CreateZendeskChannelAdapterOptions,
  CreateZendeskChannelPluginOptions,
  CreateZendeskChannelResourceOptions,
  ZendeskActionPayload,
  ZendeskConfig,
  ZendeskConfigContext,
  ZendeskDelivery,
  ZendeskTransport,
  ZendeskWebhookPayload,
} from "./types.ts";

function configContext(
  operation: ZendeskConfigContext["operation"],
  context: Readonly<{ namespace: string; channelId: string }>,
  request?: ZendeskConfigContext["request"],
  route?: ChannelJsonObject,
): ZendeskConfigContext {
  return Object.freeze({
    operation,
    namespace: context.namespace,
    channelId: context.channelId,
    ...(request ? { request } : {}),
    ...(route ? { route } : {}),
  });
}

async function configFor(
  options: CreateZendeskChannelAdapterOptions,
  context: ZendeskConfigContext,
): Promise<ZendeskConfig> {
  const value = typeof options.config === "function"
    ? await options.config(context)
    : options.config;
  if (!value || typeof value !== "object") {
    throw new TypeError("Zendesk config resolver returned no config.");
  }
  return Object.freeze({
    appId: requiredProviderText(value.appId, "Zendesk appId"),
    apiKey: requiredProviderText(value.apiKey, "Zendesk apiKey"),
    apiSecret: requiredProviderText(value.apiSecret, "Zendesk apiSecret"),
    ...(value.webhookSecret?.trim()
      ? { webhookSecret: value.webhookSecret.trim() }
      : {}),
    businessName: value.businessName?.trim() || "Business",
    businessLogo: value.businessLogo?.trim() || null,
  });
}

async function occurrence(
  value: ZendeskWebhookPayload["events"] extends
    readonly (infer T)[] | undefined ? T
    : never,
  transport: ZendeskTransport,
) {
  if (value.type !== "conversation:message") return null;
  const conversation = value.payload?.conversation;
  const message = value.payload?.message;
  const author = message?.author;
  const content = message?.content;
  if (
    !conversation?.id || !message?.id || author?.type !== "user" || !content
  ) return null;
  const externalId = author.user?.externalId?.trim() || author.user?.id?.trim();
  if (!externalId) return null;
  const text = content.text?.trim();
  const downloaded = content.type === "file" && content.mediaUrl?.trim()
    ? await transport.download(content.mediaUrl.trim())
    : null;
  const media = downloaded
    ? Object.freeze({
      dataBase64: bytesToBase64(downloaded.bytes),
      mediaType: content.mediaType?.trim() || downloaded.mediaType,
      ...(content.fileName?.trim()
        ? { name: content.fileName.trim() }
        : downloaded.name
        ? { name: downloaded.name }
        : {}),
    })
    : null;
  if (!text && !media) return null;
  return Object.freeze({
    id: `zendesk:${message.id.trim()}`,
    input: Object.freeze({
      conversationId: conversation.id.trim(),
      ...(conversation.type?.trim()
        ? { conversationType: conversation.type.trim() }
        : {}),
      messageId: message.id.trim(),
      externalUserId: externalId,
      ...(author.user?.id?.trim() ? { userId: author.user.id.trim() } : {}),
      ...(author.displayName?.trim()
        ? { displayName: author.displayName.trim() }
        : {}),
      ...(text ? { text } : {}),
      ...(media ? { media } : {}),
    }),
  });
}

function mediaKind(value: string): "image" | "audio" | "video" | "file" {
  if (value.startsWith("image/")) return "image";
  if (value.startsWith("audio/")) return "audio";
  if (value.startsWith("video/")) return "video";
  return "file";
}

function normalizedMediaType(value: string, name?: string): string {
  const type = value.split(";", 1)[0].trim().toLowerCase();
  if (type === "audio/ogg") return "audio/opus";
  if (type === "audio/x-wav") return "audio/wav";
  if (type === "audio/x-m4a") return "audio/mp4";
  if (type === "application/octet-stream" && /\.ogg$/i.test(name ?? "")) {
    return "audio/opus";
  }
  return type || "application/octet-stream";
}

function author(config: ZendeskConfig): Readonly<Record<string, unknown>> {
  return Object.freeze({
    type: "business",
    displayName: config.businessName || "Business",
    avatarUrl: config.businessLogo ?? null,
  });
}

function action(value: unknown): ZendeskActionPayload | null {
  const root = providerRecord(value);
  const nested = providerRecord(root.action);
  const source = Object.keys(nested).length ? nested : root;
  if (source.type !== "reply_buttons") return null;
  const content = (Array.isArray(source.content) ? source.content : []).flatMap(
    (item) => {
      const button = providerRecord(item);
      const text = typeof button.text === "string" ? button.text.trim() : "";
      const payload = typeof button.payload === "string"
        ? button.payload.trim()
        : "";
      return text && payload ? [{ text, payload }] : [];
    },
  );
  const message = typeof source.message === "string"
    ? source.message.trim()
    : typeof root.content === "string"
    ? root.content.trim()
    : "";
  return message && content.length
    ? Object.freeze({
      type: "reply_buttons",
      message,
      content: Object.freeze(content),
    })
    : null;
}

async function emit(
  options: CreateZendeskChannelAdapterOptions,
  transport: ZendeskTransport,
  config: ZendeskConfig,
  attempt: ChannelDeliveryAttempt,
  original: ZendeskDelivery,
): Promise<unknown> {
  const delivery = options.transformDelivery
    ? await options.transformDelivery(original, attempt)
    : original;
  if (!delivery) return null;
  if (delivery.kind === "text") {
    return await transport.send(config, delivery.conversationId, {
      author: author(config),
      content: { type: "text", text: delivery.text },
    });
  }
  if (delivery.kind === "media") {
    const uploaded = await transport.upload(
      config,
      delivery.conversationId,
      delivery.media,
    );
    return await transport.send(config, delivery.conversationId, {
      author: author(config),
      content: {
        type: delivery.media.mediaType.startsWith("image/") ? "image" : "file",
        mediaUrl: uploaded.mediaUrl,
      },
    });
  }
  return await transport.send(config, delivery.conversationId, {
    author: author(config),
    content: {
      type: "text",
      text: delivery.action.message,
      actions: delivery.action.content.map((item) => ({
        type: "reply",
        text: item.text,
        payload: item.payload,
      })),
    },
  });
}

function providerId(value: unknown): string | undefined {
  const root = providerRecord(value);
  const message = providerRecord(root.message);
  const id = root.id ?? message.id;
  return typeof id === "string" && id.trim() ? id.trim() : undefined;
}

async function emitContent(
  options: CreateZendeskChannelAdapterOptions,
  transport: ZendeskTransport,
  config: ZendeskConfig,
  attempt: ChannelDeliveryAttempt,
  conversationId: string,
  content: ResolvedContent,
): Promise<unknown | undefined> {
  const text = outboundText(content);
  if (text) {
    return await emit(options, transport, config, attempt, {
      kind: "text",
      conversationId,
      text,
    });
  }
  if (["image", "audio", "video", "file"].includes(content.ref.kind)) {
    return await emit(options, transport, config, attempt, {
      kind: "media",
      conversationId,
      media: {
        bytes: content.bytes,
        mediaType: content.ref.mediaType,
        ...(content.ref.name ? { name: content.ref.name } : {}),
      },
    });
  }
  return undefined;
}

export function createZendeskChannelResource(
  options: CreateZendeskChannelResourceOptions = {},
): ChannelResource {
  return defineChannelResource({
    egress: "external",
    ...(options.defaultAgentAliases
      ? { defaultAgentAliases: options.defaultAgentAliases }
      : {}),
    ...(options.metadata ? { metadata: options.metadata } : {}),
  });
}

export function createZendeskChannelAdapter(
  options: CreateZendeskChannelAdapterOptions,
): ChannelAdapter {
  if (!options?.config) throw new TypeError("Zendesk Adapter requires config.");
  const transport = options.transport ??
    createZendeskTransport({ fetch: options.fetch });
  return Object.freeze({
    async accept(request, context) {
      const config = await configFor(
        options,
        configContext("accept", context, request),
      );
      if (request.method.toUpperCase() === "GET") {
        return Object.freeze({
          status: 200,
          response: "ok",
          occurrences: Object.freeze([]),
        });
      }
      if (config.webhookSecret) {
        const supplied = requestHeader(request.headers, "x-api-key");
        if (!supplied || !timingSafeTextEqual(supplied, config.webhookSecret)) {
          return Object.freeze({
            status: 403,
            response: Object.freeze({ error: "Forbidden" }),
            occurrences: Object.freeze([]),
          });
        }
      }
      const events = (request.body as ZendeskWebhookPayload)?.events;
      const occurrences = [];
      for (const event of events ?? []) {
        const accepted = await occurrence(event, transport);
        if (accepted) occurrences.push(accepted);
      }
      return Object.freeze({
        status: events ? 200 : 400,
        response: events
          ? Object.freeze({ status: "ok" })
          : Object.freeze({ error: "No events found" }),
        occurrences: Object.freeze(occurrences),
      });
    },
    receive(value, _context) {
      const input = providerRecord(value);
      const conversationId = requiredProviderText(
        input.conversationId,
        "Zendesk conversation ID",
      );
      const contents: ContentInput[] = [];
      if (typeof input.text === "string" && input.text.trim()) {
        contents.push(input.text.trim());
      }
      const descriptor = providerRecord(input.media);
      if (Object.keys(descriptor).length) {
        const name = typeof descriptor.name === "string"
          ? descriptor.name
          : undefined;
        const mediaType = normalizedMediaType(
          requiredProviderText(descriptor.mediaType, "Zendesk media type"),
          name,
        );
        contents.push({
          type: mediaKind(mediaType),
          bytes: base64ToBytes(requiredProviderText(
            descriptor.dataBase64,
            "Zendesk media base64",
          )),
          mediaType,
          ...(name ? { name } : {}),
        });
      }
      if (!contents.length) throw new TypeError("Zendesk message is empty.");
      const messageId = requiredProviderText(
        input.messageId,
        "Zendesk message ID",
      );
      const externalId = requiredProviderText(
        input.externalUserId,
        "Zendesk external user ID",
      );
      const displayName = typeof input.displayName === "string"
        ? input.displayName.trim()
        : "";
      return Object.freeze({
        externalThreadId: conversationId,
        sender: Object.freeze({
          externalId,
          participantType: "human" as const,
          ...(displayName ? { name: displayName } : {}),
          metadata: Object.freeze({
            provider: "zendesk",
            ...(typeof input.userId === "string"
              ? { userId: input.userId }
              : {}),
          }),
        }),
        content: contents.length === 1 ? contents[0] : Object.freeze(contents),
        route: Object.freeze({ conversationId }),
        metadata: Object.freeze({
          provider: "zendesk",
          providerMessageId: messageId,
        }),
        thread: Object.freeze({
          metadata: Object.freeze({
            provider: "zendesk",
            conversationId,
            ...(typeof input.conversationType === "string"
              ? { conversationType: input.conversationType }
              : {}),
            lastInboundMessageId: messageId,
          }),
        }),
      });
    },
    async deliver(attempt, context) {
      const route = providerRecord(attempt.intent.route);
      const conversationId = requiredProviderText(
        route.conversationId,
        "Zendesk conversation ID",
      );
      const config = await configFor(
        options,
        configContext("deliver", context, undefined, attempt.intent.route),
      );
      let delivered = 0;
      const providerIds: string[] = [];
      for (const content of attempt.content) {
        const result = await emitContent(
          options,
          transport,
          config,
          attempt,
          conversationId,
          content,
        );
        if (result === undefined) continue;
        delivered += 1;
        const id = providerId(result);
        if (id) providerIds.push(id);
      }
      const metadata = providerRecord(attempt.intent.metadata);
      const semantic = action(providerRecord(metadata.message));
      if (semantic) {
        const result = await emit(options, transport, config, attempt, {
          kind: "reply_buttons",
          conversationId,
          action: semantic,
        });
        delivered += 1;
        const id = providerId(result);
        if (id) providerIds.push(id);
      }
      return Object.freeze({
        deliveryKey: attempt.intent.deliveryKey,
        delivered,
        ...(providerIds.length
          ? { providerIds: Object.freeze(providerIds) }
          : {}),
      });
    },
  });
}

export function createZendeskChannelPlugin(
  options: CreateZendeskChannelPluginOptions,
): ChannelProviderPlugin {
  const channelId = options.channelId?.trim() || "zendesk";
  return definePlugin({
    id: options.pluginId?.trim() || "@copilotz/channel-zendesk",
    version: options.version?.trim() || "4.0.0",
    plugins: [channelsPlugin] as const,
    resources: {
      channels: { [channelId]: createZendeskChannelResource(options) },
    },
    adapters: {
      channels: { [channelId]: createZendeskChannelAdapter(options) },
    },
  });
}
