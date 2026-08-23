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
import { cloneChannelJson } from "../input.ts";
import { channelsPlugin } from "../plugin.ts";
import { defineChannelResource } from "../resource.ts";
import type {
  ChannelAdapter,
  ChannelDeliveryAttempt,
  ChannelJsonObject,
  ChannelProviderPlugin,
  ChannelResource,
} from "../types.ts";
import { createTelegramTransport } from "./transport.ts";
import type {
  CreateTelegramChannelAdapterOptions,
  CreateTelegramChannelPluginOptions,
  CreateTelegramChannelResourceOptions,
  TelegramActionPayload,
  TelegramConfig,
  TelegramConfigContext,
  TelegramDelivery,
  TelegramMessage,
  TelegramTransport,
  TelegramUpdate,
  TelegramUser,
} from "./types.ts";

function configContext(
  operation: TelegramConfigContext["operation"],
  context: Readonly<{ namespace: string; channelId: string }>,
  request?: TelegramConfigContext["request"],
  route?: ChannelJsonObject,
): TelegramConfigContext {
  return Object.freeze({
    operation,
    namespace: context.namespace,
    channelId: context.channelId,
    ...(request ? { request } : {}),
    ...(route ? { route } : {}),
  });
}

async function configFor(
  options: CreateTelegramChannelAdapterOptions,
  context: TelegramConfigContext,
): Promise<TelegramConfig> {
  const value = typeof options.config === "function"
    ? await options.config(context)
    : options.config;
  if (!value || typeof value !== "object") {
    throw new TypeError("Telegram config resolver returned no config.");
  }
  return Object.freeze({
    botToken: requiredProviderText(value.botToken, "Telegram botToken"),
    ...(value.secretToken?.trim()
      ? { secretToken: value.secretToken.trim() }
      : {}),
  });
}

function userName(user: TelegramUser): string | undefined {
  return user.username?.trim() ||
    [user.first_name, user.last_name].filter(Boolean).join(" ").trim() ||
    undefined;
}

function safeUser(user: TelegramUser): ChannelJsonObject {
  return Object.freeze({
    id: requiredProviderText(user.id, "Telegram user ID"),
    ...(user.username?.trim() ? { username: user.username.trim() } : {}),
    ...(user.first_name?.trim() ? { firstName: user.first_name.trim() } : {}),
    ...(user.last_name?.trim() ? { lastName: user.last_name.trim() } : {}),
  });
}

function media(message: TelegramMessage): ChannelJsonObject | null {
  const descriptor = message.photo?.at(-1)?.file_id
    ? {
      fileId: message.photo.at(-1)!.file_id,
      kind: "image",
      mediaType: "image/jpeg",
    }
    : message.voice?.file_id
    ? {
      fileId: message.voice.file_id,
      kind: "audio",
      mediaType: message.voice.mime_type || "audio/ogg",
      ...(message.voice.file_name ? { name: message.voice.file_name } : {}),
    }
    : message.audio?.file_id
    ? {
      fileId: message.audio.file_id,
      kind: "audio",
      mediaType: message.audio.mime_type || "audio/mpeg",
      ...(message.audio.file_name ? { name: message.audio.file_name } : {}),
    }
    : message.video?.file_id
    ? {
      fileId: message.video.file_id,
      kind: "video",
      mediaType: message.video.mime_type || "video/mp4",
      ...(message.video.file_name ? { name: message.video.file_name } : {}),
    }
    : message.document?.file_id
    ? {
      fileId: message.document.file_id,
      kind: "file",
      mediaType: message.document.mime_type || "application/octet-stream",
      ...(message.document.file_name
        ? { name: message.document.file_name }
        : {}),
    }
    : null;
  return descriptor ? cloneChannelJson(descriptor) as ChannelJsonObject : null;
}

async function messageOccurrence(
  message: TelegramMessage,
  transport: TelegramTransport,
  config: TelegramConfig,
) {
  if (!message.from) return null;
  const chatId = requiredProviderText(message.chat?.id, "Telegram chat ID");
  const messageId = requiredProviderText(
    message.message_id,
    "Telegram message ID",
  );
  const user = safeUser(message.from);
  const text = message.text?.trim() || message.caption?.trim();
  const attachment = media(message);
  let persistedMedia: ChannelJsonObject | null = null;
  if (attachment) {
    const downloaded = await transport.download(
      config,
      requiredProviderText(attachment.fileId, "Telegram file ID"),
    );
    if (!downloaded) {
      throw new Error("Telegram media download returned no content.");
    }
    persistedMedia = Object.freeze({
      kind: requiredProviderText(attachment.kind, "Telegram media kind"),
      dataBase64: bytesToBase64(downloaded.bytes),
      mediaType: typeof attachment.mediaType === "string"
        ? attachment.mediaType
        : downloaded.mediaType,
      ...(typeof attachment.name === "string"
        ? { name: attachment.name }
        : downloaded.name
        ? { name: downloaded.name }
        : {}),
    });
  }
  if (!text && !persistedMedia) return null;
  return Object.freeze({
    id: `telegram:${JSON.stringify([chatId, messageId])}`,
    input: Object.freeze({
      kind: "message",
      chatId,
      messageId,
      user,
      ...(text ? { text } : {}),
      ...(persistedMedia ? { media: persistedMedia } : {}),
    }),
  });
}

function callbackOccurrence(update: TelegramUpdate) {
  const callback = update.callback_query;
  const data = callback?.data?.trim();
  if (!callback || !data || !callback.message?.chat) return null;
  const callbackId = requiredProviderText(callback.id, "Telegram callback ID");
  return Object.freeze({
    id: `telegram:${JSON.stringify(["callback", callbackId])}`,
    input: Object.freeze({
      kind: "callback",
      chatId: requiredProviderText(
        callback.message.chat.id,
        "Telegram chat ID",
      ),
      callbackId,
      data,
      user: safeUser(callback.from),
    }),
  });
}

function action(value: unknown): TelegramActionPayload | null {
  const root = providerRecord(value);
  const nested = providerRecord(root.action);
  const source = Object.keys(nested).length ? nested : root;
  if (source.type !== "reply_buttons") return null;
  const items = Array.isArray(source.content) ? source.content : [];
  const content = items.flatMap((item) => {
    const value = providerRecord(item);
    const text = typeof value.text === "string" ? value.text.trim() : "";
    const payload = typeof value.payload === "string"
      ? value.payload.trim()
      : "";
    return text && payload ? [{ text, payload }] : [];
  });
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
  options: CreateTelegramChannelAdapterOptions,
  transport: TelegramTransport,
  config: TelegramConfig,
  attempt: ChannelDeliveryAttempt,
  delivery: TelegramDelivery,
): Promise<unknown> {
  const value = options.transformDelivery
    ? await options.transformDelivery(delivery, attempt)
    : delivery;
  if (!value) return null;
  if (value.kind === "text") {
    return await transport.call(config, "sendMessage", {
      chat_id: value.chatId,
      text: value.text,
    });
  }
  if (value.kind === "media") {
    return await transport.sendMedia(config, value.chatId, value.media);
  }
  return await transport.call(config, "sendMessage", {
    chat_id: value.chatId,
    text: value.action.message,
    reply_markup: {
      inline_keyboard: [value.action.content.map((item) => ({
        text: item.text?.slice(0, 64),
        callback_data: item.payload?.slice(0, 64),
      }))],
    },
  });
}

function providerId(value: unknown): string | undefined {
  const result = providerRecord(providerRecord(value).result);
  const id = result.message_id;
  return typeof id === "string" || typeof id === "number"
    ? String(id)
    : undefined;
}

/** Data-only Telegram policy. */
export function createTelegramChannelResource(
  options: CreateTelegramChannelResourceOptions = {},
): ChannelResource {
  return defineChannelResource({
    egress: "external",
    ...(options.defaultAgentAliases
      ? { defaultAgentAliases: options.defaultAgentAliases }
      : {}),
    ...(options.metadata ? { metadata: options.metadata } : {}),
  });
}

/** Executable Telegram behavior composed separately under the same alias. */
export function createTelegramChannelAdapter(
  options: CreateTelegramChannelAdapterOptions,
): ChannelAdapter {
  if (!options?.config) {
    throw new TypeError("Telegram Adapter requires config.");
  }
  const transport = options.transport ??
    createTelegramTransport({ fetch: options.fetch });
  return Object.freeze({
    async accept(request, context) {
      const config = await configFor(
        options,
        configContext("accept", context, request),
      );
      if (config.secretToken) {
        const supplied = requestHeader(
          request.headers,
          "x-telegram-bot-api-secret-token",
        );
        if (!supplied || !timingSafeTextEqual(supplied, config.secretToken)) {
          return Object.freeze({
            status: 403,
            response: Object.freeze({ error: "Forbidden" }),
            occurrences: Object.freeze([]),
          });
        }
      }
      const update = request.body as TelegramUpdate;
      const occurrences = [];
      const message = update?.message ?? update?.edited_message;
      const inbound = message
        ? await messageOccurrence(message, transport, config)
        : null;
      if (inbound) occurrences.push(inbound);
      const callback = callbackOccurrence(update ?? {});
      if (callback) occurrences.push(callback);
      return Object.freeze({
        status: 200,
        response: Object.freeze({ status: "ok" }),
        occurrences: Object.freeze(occurrences),
      });
    },
    receive(value, _context) {
      const input = providerRecord(value);
      const chatId = requiredProviderText(input.chatId, "Telegram chat ID");
      const user = providerRecord(input.user);
      const userId = requiredProviderText(user.id, "Telegram user ID");
      const name = userName({
        id: userId,
        ...(typeof user.username === "string"
          ? { username: user.username }
          : {}),
        ...(typeof user.firstName === "string"
          ? { first_name: user.firstName }
          : {}),
        ...(typeof user.lastName === "string"
          ? { last_name: user.lastName }
          : {}),
      });
      const contents: ContentInput[] = [];
      const text = input.kind === "callback"
        ? requiredProviderText(input.data, "Telegram callback data")
        : typeof input.text === "string"
        ? input.text.trim()
        : "";
      if (text) contents.push(text);
      const descriptor = providerRecord(input.media);
      if (Object.keys(descriptor).length) {
        contents.push({
          type: requiredProviderText(
            descriptor.kind,
            "Telegram media kind",
          ) as "image" | "audio" | "video" | "file",
          bytes: base64ToBytes(requiredProviderText(
            descriptor.dataBase64,
            "Telegram media base64",
          )),
          mediaType: requiredProviderText(
            descriptor.mediaType,
            "Telegram media type",
          ),
          ...(typeof descriptor.name === "string"
            ? { name: descriptor.name }
            : {}),
        });
      }
      if (!contents.length) throw new TypeError("Telegram message is empty.");
      const providerMessageId = requiredProviderText(
        input.messageId ?? input.callbackId,
        "Telegram provider message ID",
      );
      return Object.freeze({
        externalThreadId: chatId,
        sender: Object.freeze({
          externalId: userId,
          participantType: "human" as const,
          ...(name ? { name } : {}),
          metadata: Object.freeze({
            provider: "telegram",
            user: user as ChannelJsonObject,
          }),
        }),
        content: contents.length === 1 ? contents[0] : Object.freeze(contents),
        route: Object.freeze({ chatId }),
        metadata: Object.freeze({
          provider: "telegram",
          providerMessageId,
        }),
        thread: Object.freeze({
          metadata: Object.freeze({
            provider: "telegram",
            chatId,
            userId,
            ...(typeof user.username === "string"
              ? { userName: user.username }
              : {}),
            lastInboundMessageId: providerMessageId,
          }),
        }),
      });
    },
    async deliver(attempt, context) {
      const route = providerRecord(attempt.intent.route);
      const chatId = requiredProviderText(route.chatId, "Telegram chat ID");
      const config = await configFor(
        options,
        configContext("deliver", context, undefined, attempt.intent.route),
      );
      let delivered = 0;
      const providerIds: string[] = [];
      for (const item of attempt.content) {
        const result = await deliverContent(
          item,
          async (delivery) =>
            await emit(options, transport, config, attempt, {
              ...delivery,
              chatId,
            } as TelegramDelivery),
        );
        if (result === undefined) continue;
        delivered += 1;
        const id = providerId(result);
        if (id) providerIds.push(id);
      }
      const metadata = providerRecord(attempt.intent.metadata);
      const message = providerRecord(metadata.message);
      const buttons = action(message);
      if (buttons) {
        const result = await emit(options, transport, config, attempt, {
          kind: "reply_buttons",
          chatId,
          action: buttons,
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

async function deliverContent(
  content: ResolvedContent,
  send: (
    delivery:
      | Omit<Extract<TelegramDelivery, { kind: "text" }>, "chatId">
      | Omit<Extract<TelegramDelivery, { kind: "media" }>, "chatId">,
  ) => Promise<unknown>,
): Promise<unknown | undefined> {
  const text = outboundText(content);
  if (text) return await send({ kind: "text", text });
  if (["image", "audio", "video", "file"].includes(content.ref.kind)) {
    return await send({
      kind: "media",
      media: {
        bytes: content.bytes,
        mediaType: content.ref.mediaType,
        ...(content.ref.name ? { name: content.ref.name } : {}),
      },
    });
  }
  return undefined;
}

export function createTelegramChannelPlugin(
  options: CreateTelegramChannelPluginOptions,
): ChannelProviderPlugin {
  const channelId = options.channelId?.trim() || "telegram";
  return definePlugin({
    id: options.pluginId?.trim() || "@copilotz/channel-telegram",
    version: options.version?.trim() || "4.0.0",
    plugins: [channelsPlugin] as const,
    resources: {
      channels: { [channelId]: createTelegramChannelResource(options) },
    },
    adapters: {
      channels: { [channelId]: createTelegramChannelAdapter(options) },
    },
  });
}
