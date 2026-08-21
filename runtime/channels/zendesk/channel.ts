import type { ContentInput } from "../../content/index.ts";
import { type CopilotzPlugin, definePlugin } from "../../plugins/index.ts";
import {
  channelMetadata,
  collectByteStream,
  coreMessageEnvelope,
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
import { createZendeskTransport } from "./transport.ts";
import type {
  CreateZendeskChannelOptions,
  CreateZendeskChannelPluginOptions,
  ZendeskActionPayload,
  ZendeskConfig,
  ZendeskDeliveryOutput,
  ZendeskTransport,
  ZendeskWebhookPayload,
} from "./types.ts";

const DEFAULT_MAX_STREAM_BYTES = 32 * 1024 * 1024;

function required(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`${name} must be non-empty.`);
  }
  return value.trim();
}

async function configFor(
  options: CreateZendeskChannelOptions,
  request: ChannelRequest,
): Promise<ZendeskConfig> {
  const value = typeof options.config === "function"
    ? await options.config(request)
    : options.config;
  if (!value || typeof value !== "object") {
    throw new TypeError("Zendesk config resolver returned no config.");
  }
  return Object.freeze({
    appId: required(value.appId, "Zendesk appId"),
    apiKey: required(value.apiKey, "Zendesk apiKey"),
    apiSecret: required(value.apiSecret, "Zendesk apiSecret"),
    ...(value.webhookSecret?.trim()
      ? { webhookSecret: value.webhookSecret.trim() }
      : {}),
    businessName: value.businessName?.trim() || "Business",
    businessLogo: value.businessLogo?.trim() || null,
  });
}

function startsWithOgg(bytes: Uint8Array): boolean {
  return bytes.byteLength >= 4 && bytes[0] === 0x4f && bytes[1] === 0x67 &&
    bytes[2] === 0x67 && bytes[3] === 0x53;
}

function normalizedAudioType(value: string): string {
  const base = value.split(";")[0].trim().toLowerCase();
  if (base === "audio/ogg") return "audio/opus";
  if (base === "audio/x-wav") return "audio/wav";
  if (base === "audio/x-m4a") return "audio/mp4";
  return base;
}

function mediaKind(mediaType: string): "image" | "audio" | "video" | "file" {
  if (mediaType.startsWith("image/")) return "image";
  if (mediaType.startsWith("audio/")) return "audio";
  if (mediaType.startsWith("video/")) return "video";
  return "file";
}

async function ingressInputs(
  payload: ZendeskWebhookPayload,
  transport: ZendeskTransport,
): Promise<readonly ChannelIngressEnvelope[]> {
  const result: ChannelIngressEnvelope[] = [];
  for (const event of payload.events ?? []) {
    if (event.type !== "conversation:message") continue;
    const conversation = event.payload?.conversation;
    const message = event.payload?.message;
    const author = message?.author;
    const source = message?.content;
    if (
      !conversation?.id || !message?.id || author?.type !== "user" || !source
    ) {
      continue;
    }
    const externalId = author.user?.externalId?.trim() ||
      author.user?.id?.trim();
    if (!externalId) continue;
    const content: ContentInput[] = [];
    if (source.text?.trim()) {
      content.push({ type: "text", text: source.text.trim() });
    }
    if (source.type === "file" && source.mediaUrl?.trim()) {
      const downloaded = await transport.download(source.mediaUrl.trim());
      if (downloaded) {
        const hinted = source.mediaType?.trim() || downloaded.mediaType;
        const audio = hinted.startsWith("audio/") ||
          /\.(mp3|wav|ogg|m4a|aac)$/i.test(source.fileName ?? "") ||
          startsWithOgg(downloaded.bytes);
        const resolvedMediaType = audio
          ? normalizedAudioType(
            hinted.startsWith("audio/")
              ? hinted
              : startsWithOgg(downloaded.bytes) ||
                  /\.ogg$/i.test(source.fileName ?? "")
              ? "audio/ogg"
              : /\.mp3$/i.test(source.fileName ?? "")
              ? "audio/mpeg"
              : /\.wav$/i.test(source.fileName ?? "")
              ? "audio/wav"
              : /\.m4a$/i.test(source.fileName ?? "")
              ? "audio/mp4"
              : "audio/aac",
          )
          : hinted || "application/octet-stream";
        content.push({
          type: audio ? "audio" : mediaKind(resolvedMediaType),
          bytes: downloaded.bytes,
          mediaType: resolvedMediaType,
          ...(source.fileName?.trim()
            ? { name: source.fileName.trim() }
            : downloaded.name
            ? { name: downloaded.name }
            : {}),
        });
      }
    }
    if (content.length === 0) continue;
    result.push(Object.freeze({
      thread: {
        externalId: conversation.id,
        metadata: {
          channels: {
            zendesk: {
              conversationId: conversation.id,
              conversationType: conversation.type ?? null,
              switchboardIntegration:
                conversation.activeSwitchboardIntegration ?? null,
              source: message.source ?? null,
              lastInboundMessageId: message.id,
            },
          },
        },
      },
      participant: {
        externalId,
        participantType: "human" as const,
        ...(author.displayName?.trim()
          ? { name: author.displayName.trim() }
          : {}),
        metadata: {
          provider: "zendesk",
          userId: author.user?.id ?? null,
          providerExternalId: author.user?.externalId ?? null,
        },
      },
      input: coreMessageEnvelope({
        thread: conversation.id,
        participant: {
          externalId,
          participantType: "human" as const,
          ...(author.displayName?.trim()
            ? { name: author.displayName.trim() }
            : {}),
          metadata: {
            provider: "zendesk",
            userId: author.user?.id ?? null,
            providerExternalId: author.user?.externalId ?? null,
          },
        },
        content: content.length === 1 && source.text?.trim() &&
            source.type !== "file"
          ? source.text.trim()
          : Object.freeze(content),
        id: message.id,
        correlationId: `zendesk:${message.id}`,
        deduplicationId: `zendesk:${message.id}`,
        metadata: {
          provider: "zendesk",
          providerMessageId: message.id,
        },
      }),
    }));
  }
  return Object.freeze(result);
}

function author(config: ZendeskConfig): Readonly<Record<string, unknown>> {
  return {
    type: "business",
    displayName: config.businessName || "Business",
    avatarUrl: config.businessLogo ?? null,
  };
}

function actionPayload(payload: unknown): ZendeskActionPayload | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }
  const record = payload as Record<string, unknown>;
  const nested = record.action;
  const action = nested && typeof nested === "object" && !Array.isArray(nested)
    ? nested as ZendeskActionPayload
    : record as ZendeskActionPayload;
  if (action.type !== "reply_buttons") return null;
  return {
    ...action,
    message: typeof record.content === "string"
      ? record.content
      : action.message ?? "",
  };
}

async function deliver(
  options: CreateZendeskChannelOptions,
  transport: ZendeskTransport,
  config: ZendeskConfig,
  context: ChannelEgressContext,
  original: ZendeskDeliveryOutput,
): Promise<void> {
  const output = options.transformOutput
    ? await options.transformOutput(original, context)
    : original;
  if (!output) return;
  if (output.kind === "text") {
    if (!output.text.trim()) return;
    await transport.send(config, output.conversationId, {
      author: author(config),
      content: { type: "text", text: output.text },
    });
    return;
  }
  if (output.kind === "media") {
    const uploaded = await transport.upload(
      config,
      output.conversationId,
      output.media,
    );
    await transport.send(config, output.conversationId, {
      author: author(config),
      content: {
        type: output.media.mediaType.startsWith("image/") ? "image" : "file",
        mediaUrl: uploaded.mediaUrl,
      },
    });
    return;
  }
  const actions = (output.action.content ?? []).flatMap((item) => {
    const text = item.text?.trim();
    const payload = item.payload?.trim();
    return text && payload ? [{ type: "reply", text, payload }] : [];
  });
  const text = output.action.message?.trim() ?? "";
  if (!text || actions.length === 0) return;
  await transport.send(config, output.conversationId, {
    author: author(config),
    content: { type: "text", text, actions },
  });
}

/** Creates an attachment-native Zendesk channel. */
export function createZendeskChannel(
  options: CreateZendeskChannelOptions,
): ChannelResource {
  if (!options?.config) throw new TypeError("Zendesk channel requires config.");
  const id = options.id?.trim() || "zendesk";
  const transport = options.transport ??
    createZendeskTransport({ fetch: options.fetch });
  const maxStreamBytes = options.maxStreamBytes ?? DEFAULT_MAX_STREAM_BYTES;
  if (!Number.isSafeInteger(maxStreamBytes) || maxStreamBytes < 1) {
    throw new TypeError("Zendesk maxStreamBytes must be positive.");
  }
  return Object.freeze({
    id,
    ...(options.defaultAgentIds?.length
      ? { defaultAgentIds: Object.freeze([...options.defaultAgentIds]) }
      : {}),
    ingress: Object.freeze({
      async handle(request: ChannelRequest) {
        const config = await configFor(options, request);
        if (request.method.toUpperCase() === "GET") {
          return { status: 200, response: "ok", inputs: Object.freeze([]) };
        }
        if (config.webhookSecret) {
          const supplied = requestHeader(request.headers, "x-api-key");
          if (
            !supplied || !timingSafeTextEqual(supplied, config.webhookSecret)
          ) {
            return {
              status: 403,
              response: {
                error: supplied
                  ? "Invalid webhook secret"
                  : "Missing X-API-Key header",
              },
              inputs: Object.freeze([]),
            };
          }
        }
        const payload = request.body as ZendeskWebhookPayload;
        if (!payload?.events?.length) {
          return {
            status: 400,
            response: { error: "No events found in payload" },
            inputs: Object.freeze([]),
          };
        }
        return {
          status: 200,
          response: { status: "ok" },
          inputs: await ingressInputs(payload, transport),
        };
      },
    }),
    egress: Object.freeze({
      async deliver(context: ChannelEgressContext) {
        const route = channelMetadata(
          context.execution.thread.metadata,
          "zendesk",
        );
        const conversationId = typeof route?.conversationId === "string"
          ? route.conversationId.trim()
          : "";
        if (!conversationId) {
          throw new Error(
            "Thread metadata is missing Zendesk conversation routing information.",
          );
        }
        const config = await configFor(options, context.request);
        const delivered = new Set<string>();
        for await (const output of context.execution.outputs) {
          if (isAttachmentStreamOutput(output)) {
            if (output.participant.type !== "agent") {
              await output.payload.cancel("zendesk_non_agent_stream").catch(
                () => undefined,
              );
              continue;
            }
            const body = await collectByteStream(
              output.payload,
              maxStreamBytes,
              "zendesk_output_too_large",
            );
            if (body.byteLength) {
              await deliver(options, transport, config, context, {
                kind: "media",
                conversationId,
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
                text ? { kind: "text", conversationId, text, output } : {
                  kind: "media",
                  conversationId,
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
              conversationId,
              action,
              output,
            });
          }
        }
      },
    }),
  });
}

export function createZendeskChannelPlugin(
  options: CreateZendeskChannelPluginOptions,
): CopilotzPlugin {
  const channel = createZendeskChannel(options);
  return definePlugin({
    id: options.pluginId?.trim() || "@copilotz/channel-zendesk",
    version: options.version?.trim() || "3.0.0",
    channels: [channel],
  });
}
