import type { ContentInput } from "../../content/index.ts";
import { type CopilotzPlugin, definePlugin } from "../../plugins/index.ts";
import {
  channelMetadata,
  collectByteStream,
  isAttachmentStreamOutput,
  outboundText,
  requestHeader,
  resolveAgentMessageOutput,
  timingSafeTextEqual,
} from "../helpers.ts";
import type {
  ChannelEgressContext,
  ChannelIngressEnvelope,
  ChannelRequest,
  ChannelResource,
} from "../types.ts";
import { createTelegramTransport } from "./transport.ts";
import type {
  CreateTelegramChannelOptions,
  CreateTelegramChannelPluginOptions,
  TelegramActionPayload,
  TelegramConfig,
  TelegramDeliveryOutput,
  TelegramMessage,
  TelegramTransport,
  TelegramUpdate,
  TelegramUser,
} from "./types.ts";

const DEFAULT_MAX_STREAM_BYTES = 32 * 1024 * 1024;

function required(value: unknown, name: string): string {
  if (
    (typeof value !== "string" && typeof value !== "number") ||
    !String(value).trim()
  ) throw new TypeError(`${name} must be non-empty.`);
  return String(value).trim();
}

async function configFor(
  options: CreateTelegramChannelOptions,
  request: ChannelRequest,
): Promise<TelegramConfig> {
  const value = typeof options.config === "function"
    ? await options.config(request)
    : options.config;
  if (!value || typeof value !== "object") {
    throw new TypeError("Telegram config resolver returned no config.");
  }
  return Object.freeze({
    botToken: required(value.botToken, "Telegram botToken"),
    ...(value.secretToken?.trim()
      ? { secretToken: value.secretToken.trim() }
      : {}),
  });
}

function userName(user: TelegramUser): string | undefined {
  const username = user.username?.trim();
  if (username) return username;
  const name = [user.first_name, user.last_name].filter(Boolean).join(" ")
    .trim();
  return name || undefined;
}

function mediaDescriptor(message: TelegramMessage):
  | Readonly<{
    fileId: string;
    kind: "image" | "audio" | "video" | "file";
    mediaType: string;
    name?: string;
  }>
  | null {
  const photo = message.photo?.at(-1);
  if (photo?.file_id) {
    return { fileId: photo.file_id, kind: "image", mediaType: "image/jpeg" };
  }
  const voice = message.voice;
  if (voice?.file_id) {
    return {
      fileId: voice.file_id,
      kind: "audio",
      mediaType: voice.mime_type || "audio/ogg",
      ...(voice.file_name ? { name: voice.file_name } : {}),
    };
  }
  const audio = message.audio;
  if (audio?.file_id) {
    return {
      fileId: audio.file_id,
      kind: "audio",
      mediaType: audio.mime_type || "audio/mpeg",
      ...(audio.file_name ? { name: audio.file_name } : {}),
    };
  }
  const video = message.video;
  if (video?.file_id) {
    return {
      fileId: video.file_id,
      kind: "video",
      mediaType: video.mime_type || "video/mp4",
      ...(video.file_name ? { name: video.file_name } : {}),
    };
  }
  const document = message.document;
  if (document?.file_id) {
    return {
      fileId: document.file_id,
      kind: "file",
      mediaType: document.mime_type || "application/octet-stream",
      ...(document.file_name ? { name: document.file_name } : {}),
    };
  }
  return null;
}

async function messageEnvelope(
  config: TelegramConfig,
  transport: TelegramTransport,
  message: TelegramMessage,
): Promise<ChannelIngressEnvelope | null> {
  const chatId = required(message.chat?.id, "Telegram chat ID");
  const user = message.from;
  if (!user) return null;
  const participantId = required(user.id, "Telegram user ID");
  const content: ContentInput[] = [];
  const text = message.text?.trim() || message.caption?.trim();
  if (text) content.push({ type: "text", text });
  const descriptor = mediaDescriptor(message);
  if (descriptor) {
    const downloaded = await transport.download(config, descriptor.fileId);
    if (downloaded) {
      content.push({
        type: descriptor.kind,
        bytes: downloaded.bytes,
        mediaType: descriptor.mediaType || downloaded.mediaType,
        ...(descriptor.name || downloaded.name
          ? { name: descriptor.name || downloaded.name }
          : {}),
      });
    }
  }
  if (content.length === 0) return null;
  const providerMessageId = required(
    message.message_id,
    "Telegram message ID",
  );
  const id = `telegram:${chatId}:${providerMessageId}`;
  const name = userName(user);
  return Object.freeze({
    thread: {
      externalId: chatId,
      metadata: {
        channels: {
          telegram: {
            chatId,
            userId: participantId,
            userName: user.username ?? null,
            lastInboundMessageId: providerMessageId,
          },
        },
      },
    },
    participant: {
      externalId: participantId,
      participantType: "human" as const,
      ...(name ? { name } : {}),
      metadata: { provider: "telegram", telegram: structuredClone(user) },
    },
    input: {
      content: content.length === 1 && text && !descriptor
        ? text
        : Object.freeze(content),
      id,
      correlationId: id,
      deduplicationId: id,
      metadata: {
        provider: "telegram",
        providerMessageId,
      },
    },
  });
}

function callbackEnvelope(
  update: TelegramUpdate,
): ChannelIngressEnvelope | null {
  const callback = update.callback_query;
  const data = callback?.data?.trim();
  if (!callback || !data || !callback.message?.chat) return null;
  const chatId = required(callback.message.chat.id, "Telegram chat ID");
  const participantId = required(callback.from.id, "Telegram user ID");
  const name = userName(callback.from);
  const id = `telegram:callback:${
    required(callback.id, "Telegram callback ID")
  }`;
  return Object.freeze({
    thread: {
      externalId: chatId,
      metadata: {
        channels: {
          telegram: {
            chatId,
            userId: participantId,
            userName: callback.from.username ?? null,
            lastInboundMessageId: callback.id,
          },
        },
      },
    },
    participant: {
      externalId: participantId,
      participantType: "human" as const,
      ...(name ? { name } : {}),
      metadata: {
        provider: "telegram",
        telegram: structuredClone(callback.from),
      },
    },
    input: {
      content: data,
      id,
      correlationId: id,
      deduplicationId: id,
      metadata: {
        provider: "telegram",
        callbackQueryId: callback.id,
      },
    },
  });
}

function actionPayload(payload: unknown): TelegramActionPayload | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }
  const record = payload as Record<string, unknown>;
  const nested = record.action;
  const action = nested && typeof nested === "object" && !Array.isArray(nested)
    ? nested as TelegramActionPayload
    : record as TelegramActionPayload;
  if (action.type !== "reply_buttons") return null;
  return {
    ...action,
    message: typeof record.content === "string"
      ? record.content
      : action.message ?? "",
  };
}

async function deliver(
  options: CreateTelegramChannelOptions,
  transport: TelegramTransport,
  config: TelegramConfig,
  context: ChannelEgressContext,
  original: TelegramDeliveryOutput,
): Promise<void> {
  const output = options.transformOutput
    ? await options.transformOutput(original, context)
    : original;
  if (!output) return;
  if (output.kind === "text") {
    if (output.text.trim()) {
      await transport.call(config, "sendMessage", {
        chat_id: output.chatId,
        text: output.text,
      });
    }
    return;
  }
  if (output.kind === "media") {
    await transport.sendMedia(config, output.chatId, output.media);
    return;
  }
  const buttons = (output.action.content ?? []).flatMap((item) => {
    const text = item.text?.trim();
    const payload = item.payload?.trim().slice(0, 64);
    return text && payload ? [{ text, callback_data: payload }] : [];
  });
  const text = output.action.message?.trim() ?? "";
  if (!text || buttons.length === 0) return;
  await transport.call(config, "sendMessage", {
    chat_id: output.chatId,
    text,
    reply_markup: { inline_keyboard: [buttons] },
  });
}

/** Creates an attachment-native Telegram channel. */
export function createTelegramChannel(
  options: CreateTelegramChannelOptions,
): ChannelResource {
  if (!options?.config) {
    throw new TypeError("Telegram channel requires config.");
  }
  const id = options.id?.trim() || "telegram";
  const transport = options.transport ??
    createTelegramTransport({ fetch: options.fetch });
  const maxStreamBytes = options.maxStreamBytes ?? DEFAULT_MAX_STREAM_BYTES;
  if (!Number.isSafeInteger(maxStreamBytes) || maxStreamBytes < 1) {
    throw new TypeError("Telegram maxStreamBytes must be positive.");
  }
  return Object.freeze({
    id,
    ...(options.defaultAgentIds?.length
      ? { defaultAgentIds: Object.freeze([...options.defaultAgentIds]) }
      : {}),
    ingress: Object.freeze({
      async handle(request: ChannelRequest) {
        const config = await configFor(options, request);
        if (config.secretToken) {
          const supplied = requestHeader(
            request.headers,
            "x-telegram-bot-api-secret-token",
          );
          if (!supplied || !timingSafeTextEqual(supplied, config.secretToken)) {
            return {
              status: 403,
              response: { error: "Forbidden: Invalid secret token" },
              inputs: Object.freeze([]),
            };
          }
        }
        const update = request.body as TelegramUpdate;
        const inputs: ChannelIngressEnvelope[] = [];
        const message = update?.message ?? update?.edited_message;
        if (message) {
          const envelope = await messageEnvelope(config, transport, message);
          if (envelope) inputs.push(envelope);
        }
        const callback = callbackEnvelope(update);
        if (callback) inputs.push(callback);
        return {
          status: 200,
          response: { status: "ok" },
          inputs: Object.freeze(inputs),
        };
      },
    }),
    egress: Object.freeze({
      async deliver(context: ChannelEgressContext) {
        const route = channelMetadata(
          context.execution.thread.metadata,
          "telegram",
        );
        const chatId = typeof route?.chatId === "string" ||
            typeof route?.chatId === "number"
          ? String(route.chatId).trim()
          : "";
        if (!chatId) {
          throw new Error("Thread metadata is missing Telegram chat routing.");
        }
        const config = await configFor(options, context.request);
        const delivered = new Set<string>();
        for await (const output of context.execution.outputs) {
          if (isAttachmentStreamOutput(output)) {
            if (output.participant.type !== "agent") {
              await output.payload.cancel("telegram_non_agent_stream").catch(
                () => undefined,
              );
              continue;
            }
            const body = await collectByteStream(
              output.payload,
              maxStreamBytes,
              "telegram_output_too_large",
            );
            if (body.byteLength) {
              await deliver(options, transport, config, context, {
                kind: "media",
                chatId,
                media: { bytes: body, mediaType: output.mediaType },
                output,
              });
            }
            continue;
          }
          const resolved = await resolveAgentMessageOutput(context, output);
          if (resolved && !delivered.has(resolved.message.id)) {
            delivered.add(resolved.message.id);
            for (const content of resolved.content) {
              const text = outboundText(content);
              await deliver(
                options,
                transport,
                config,
                context,
                text ? { kind: "text", chatId, text, output } : {
                  kind: "media",
                  chatId,
                  media: {
                    bytes: content.bytes,
                    mediaType: content.ref.mediaType,
                    ...(content.ref.name ? { name: content.ref.name } : {}),
                  },
                  output,
                },
              );
            }
            continue;
          }
          if (output.type !== "action.created") continue;
          const action = actionPayload(output.payload);
          if (action) {
            await deliver(options, transport, config, context, {
              kind: "reply_buttons",
              chatId,
              action,
              output,
            });
          }
        }
      },
    }),
  });
}

export function createTelegramChannelPlugin(
  options: CreateTelegramChannelPluginOptions,
): CopilotzPlugin {
  const channel = createTelegramChannel(options);
  return definePlugin({
    manifest: {
      id: options.pluginId?.trim() || "@copilotz/channel-telegram",
      version: options.version?.trim() || "3.0.0",
      provides: { channels: [channel.id] },
    },
    resources: { channels: [channel] },
  });
}
