import type { ContentInput } from "@copilotz/copilotz/content";
import { type CopilotzPlugin, definePlugin } from "@copilotz/copilotz/plugins";
import {
  channelMetadata,
  collectByteStream,
  coreMessageEnvelope,
  isAttachmentStreamOutput,
  outboundText,
  requestHeader,
  resolveAgentMessageOutput,
} from "../helpers.ts";
import type {
  ChannelEgressContext,
  ChannelIngressEnvelope,
  ChannelRequest,
  ChannelResource,
} from "../types.ts";
import { createDiscordTransport, verifyDiscordSignature } from "./transport.ts";
import type {
  CreateDiscordChannelOptions,
  CreateDiscordChannelPluginOptions,
  DiscordActionPayload,
  DiscordConfig,
  DiscordDeliveryOutput,
  DiscordInteraction,
  DiscordTransport,
} from "./types.ts";

const DEFAULT_MAX_STREAM_BYTES = 32 * 1024 * 1024;

function required(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`${name} must be non-empty.`);
  }
  return value.trim();
}

async function configFor(
  options: CreateDiscordChannelOptions,
  request: ChannelRequest,
): Promise<DiscordConfig> {
  const value = typeof options.config === "function"
    ? await options.config(request)
    : options.config;
  if (!value || typeof value !== "object") {
    throw new TypeError("Discord config resolver returned no config.");
  }
  return Object.freeze({
    applicationId: required(value.applicationId, "Discord applicationId"),
    publicKey: required(value.publicKey, "Discord publicKey"),
    ...(value.botToken?.trim() ? { botToken: value.botToken.trim() } : {}),
  });
}

function mediaKind(mediaType: string): "image" | "audio" | "video" | "file" {
  if (mediaType.startsWith("image/")) return "image";
  if (mediaType.startsWith("audio/")) return "audio";
  if (mediaType.startsWith("video/")) return "video";
  return "file";
}

async function interactionEnvelope(
  interaction: DiscordInteraction,
  transport: DiscordTransport,
): Promise<ChannelIngressEnvelope | null> {
  if (interaction.type !== 2 && interaction.type !== 3) return null;
  const user = interaction.member?.user ?? interaction.user;
  if (!user?.id || !interaction.id || !interaction.token) return null;
  const threadId = interaction.channel_id?.trim() || user.id;
  const content: ContentInput[] = [];
  let directText: string | undefined;
  if (interaction.type === 2) {
    const options = interaction.data?.options ?? [];
    const prompt = options.find((option) =>
      option.name === "prompt" || option.name === "message"
    );
    if (typeof prompt?.value === "string" && prompt.value.trim()) {
      directText = prompt.value.trim();
      content.push({ type: "text", text: directText });
    }
    const attachments = options.filter((option) => option.type === 11);
    if (!prompt && attachments.length === 0 && interaction.data?.name?.trim()) {
      directText = `/${interaction.data.name.trim()}`;
      content.push({ type: "text", text: directText });
    }
    for (const option of attachments) {
      const key = typeof option.value === "string" ? option.value : "";
      const attachment = key
        ? interaction.data?.resolved?.attachments?.[key]
        : undefined;
      if (!attachment?.url) continue;
      const downloaded = await transport.download(attachment.url);
      if (!downloaded) continue;
      const mediaType = attachment.content_type?.trim() ||
        downloaded.mediaType;
      content.push({
        type: mediaKind(mediaType),
        bytes: downloaded.bytes,
        mediaType,
        ...(attachment.filename?.trim()
          ? { name: attachment.filename.trim() }
          : downloaded.name
          ? { name: downloaded.name }
          : {}),
      });
    }
  } else {
    const customId = interaction.data?.custom_id?.trim();
    if (customId) {
      directText = customId;
      content.push({ type: "text", text: customId });
    }
  }
  if (content.length === 0) return null;
  const id = `discord:${interaction.id}`;
  const name = user.global_name?.trim() || user.username?.trim();
  return Object.freeze({
    thread: {
      externalId: threadId,
      metadata: {
        channels: {
          discord: {
            interactionId: interaction.id,
            interactionToken: interaction.token,
            channelId: interaction.channel_id ?? null,
            guildId: interaction.guild_id ?? null,
            userId: user.id,
            userName: user.username ?? null,
          },
        },
      },
    },
    participant: {
      externalId: user.id,
      participantType: "human" as const,
      ...(name ? { name } : {}),
      metadata: { provider: "discord", discord: structuredClone(user) },
    },
    input: coreMessageEnvelope({
      thread: threadId,
      participant: {
        externalId: user.id,
        participantType: "human" as const,
        ...(name ? { name } : {}),
        metadata: { provider: "discord", discord: structuredClone(user) },
      },
      content: content.length === 1 && directText
        ? directText
        : Object.freeze(content),
      id,
      correlationId: id,
      deduplicationId: id,
      metadata: {
        provider: "discord",
        interactionId: interaction.id,
        interactionType: interaction.type,
      },
    }),
  });
}

function actionPayload(payload: unknown): DiscordActionPayload | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }
  const record = payload as Record<string, unknown>;
  const nested = record.action;
  const action = nested && typeof nested === "object" && !Array.isArray(nested)
    ? nested as DiscordActionPayload
    : record as DiscordActionPayload;
  if (action.type !== "reply_buttons") return null;
  return {
    ...action,
    message: typeof record.content === "string"
      ? record.content
      : action.message ?? "",
  };
}

function textChunks(text: string): readonly string[] {
  const result: string[] = [];
  let remaining = text.trim();
  while (remaining.length > 2000) {
    const window = remaining.slice(0, 2001);
    const boundary = Math.max(
      window.lastIndexOf("\n"),
      window.lastIndexOf(" "),
    );
    const take = boundary > 1000 ? boundary : 2000;
    result.push(remaining.slice(0, take).trim());
    remaining = remaining.slice(take).trimStart();
  }
  if (remaining) result.push(remaining);
  return Object.freeze(result);
}

async function deliver(
  options: CreateDiscordChannelOptions,
  transport: DiscordTransport,
  config: DiscordConfig,
  context: ChannelEgressContext,
  state: { initial: boolean },
  original: DiscordDeliveryOutput,
): Promise<void> {
  const output = options.transformOutput
    ? await options.transformOutput(original, context)
    : original;
  if (!output) return;
  if (output.kind === "text") {
    for (const chunk of textChunks(output.text)) {
      await transport.send(
        config,
        output.interactionToken,
        { content: chunk },
        state.initial,
      );
      state.initial = false;
    }
    return;
  }
  if (output.kind === "media") {
    await transport.sendMedia(
      config,
      output.interactionToken,
      output.media,
      state.initial,
    );
    state.initial = false;
    return;
  }
  const buttons = (output.action.content ?? []).flatMap((item) => {
    const label = item.text?.trim().slice(0, 80);
    const customId = item.payload?.trim().slice(0, 100);
    return label && customId
      ? [{ type: 2, style: 1, label, custom_id: customId }]
      : [];
  });
  const message = output.action.message?.trim();
  if (!message || buttons.length === 0) return;
  await transport.send(config, output.interactionToken, {
    content: message,
    components: [{ type: 1, components: buttons }],
  }, state.initial);
  state.initial = false;
}

/** Creates an attachment-native Discord interactions channel. */
export function createDiscordChannel(
  options: CreateDiscordChannelOptions,
): ChannelResource {
  if (!options?.config) throw new TypeError("Discord channel requires config.");
  const id = options.id?.trim() || "discord";
  const transport = options.transport ??
    createDiscordTransport({ fetch: options.fetch });
  const maxStreamBytes = options.maxStreamBytes ?? DEFAULT_MAX_STREAM_BYTES;
  if (!Number.isSafeInteger(maxStreamBytes) || maxStreamBytes < 1) {
    throw new TypeError("Discord maxStreamBytes must be positive.");
  }
  return Object.freeze({
    id,
    ...(options.defaultAgentIds?.length
      ? { defaultAgentIds: Object.freeze([...options.defaultAgentIds]) }
      : {}),
    ingress: Object.freeze({
      async handle(request: ChannelRequest) {
        const config = await configFor(options, request);
        const signature = requestHeader(request.headers, "x-signature-ed25519");
        const timestamp = requestHeader(
          request.headers,
          "x-signature-timestamp",
        );
        if (
          !signature || !timestamp || !request.rawBody ||
          !await verifyDiscordSignature(
            config.publicKey,
            signature,
            timestamp,
            request.rawBody,
          )
        ) {
          return {
            status: 401,
            response: { error: "Invalid request signature" },
            inputs: Object.freeze([]),
          };
        }
        const interaction = request.body as DiscordInteraction;
        if (interaction.type === 1) {
          return {
            status: 200,
            response: { type: 1 },
            inputs: Object.freeze([]),
          };
        }
        const envelope = await interactionEnvelope(interaction, transport);
        return {
          status: 200,
          response: envelope ? { type: 5 } : { status: "ok" },
          inputs: Object.freeze(envelope ? [envelope] : []),
        };
      },
    }),
    egress: Object.freeze({
      async deliver(context: ChannelEgressContext) {
        const route = channelMetadata(
          context.execution.thread.metadata,
          "discord",
        );
        const interactionToken = typeof route?.interactionToken === "string"
          ? route.interactionToken.trim()
          : "";
        if (!interactionToken) {
          throw new Error(
            "Thread metadata is missing Discord interaction routing.",
          );
        }
        const config = await configFor(options, context.request);
        const delivered = new Set<string>();
        const state = { initial: true };
        for await (const output of context.execution.outputs) {
          if (isAttachmentStreamOutput(output)) {
            if (output.participant.type !== "agent") {
              await output.payload.cancel("discord_non_agent_stream").catch(
                () => undefined,
              );
              continue;
            }
            const body = await collectByteStream(
              output.payload,
              maxStreamBytes,
              "discord_output_too_large",
            );
            if (body.byteLength) {
              await deliver(options, transport, config, context, state, {
                kind: "media",
                interactionToken,
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
                state,
                text ? { kind: "text", interactionToken, text, output } : {
                  kind: "media",
                  interactionToken,
                  media: {
                    bytes: content.bytes,
                    mediaType: content.ref.mediaType,
                    ...(content.ref.name ? { name: content.ref.name } : {}),
                  },
                  output,
                },
              );
            }
            const action = actionPayload(resolved.message.metadata);
            if (action) {
              await deliver(options, transport, config, context, state, {
                kind: "reply_buttons",
                interactionToken,
                action,
                output,
              });
            }
            continue;
          }
        }
      },
    }),
  });
}

export function createDiscordChannelPlugin(
  options: CreateDiscordChannelPluginOptions,
): CopilotzPlugin {
  const channel = createDiscordChannel(options);
  return definePlugin({
    id: options.pluginId?.trim() || "@copilotz/channel-discord",
    version: options.version?.trim() || "3.0.0",
    resources: { channels: { [channel.id]: channel } },
  });
}
