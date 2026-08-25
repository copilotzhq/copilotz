/**
 * Defines the Discord Channel Adapter.
 *
 * @module
 */

import {
  base64ToBytes,
  bytesToBase64,
  type ContentInput,
  type ResolvedContent,
} from "@copilotz/copilotz/content";
import {
  outboundText,
  providerRecord,
  requestHeader,
  requiredProviderText,
} from "../../../channel-core/internal/helpers.ts";
import type {
  ChannelAdapter,
  ChannelDeliveryAttempt,
  ChannelJsonObject,
} from "../../../channel-core/internal/contracts.ts";
import {
  createDiscordTransport,
  verifyDiscordSignature,
} from "./internal/transport.ts";
import type {
  CreateDiscordChannelAdapterOptions,
  DiscordActionPayload,
  DiscordConfig,
  DiscordConfigContext,
  DiscordDelivery,
  DiscordInteraction,
  DiscordTransport,
  DiscordUser,
} from "../../internal/contracts.ts";

function configContext(
  operation: DiscordConfigContext["operation"],
  context: Readonly<{ namespace: string; channelId: string }>,
  request?: DiscordConfigContext["request"],
  route?: ChannelJsonObject,
): DiscordConfigContext {
  return Object.freeze({
    operation,
    namespace: context.namespace,
    channelId: context.channelId,
    ...(request ? { request } : {}),
    ...(route ? { route } : {}),
  });
}

async function configFor(
  options: CreateDiscordChannelAdapterOptions,
  context: DiscordConfigContext,
): Promise<DiscordConfig> {
  const value = typeof options.config === "function"
    ? await options.config(context)
    : options.config;
  if (!value || typeof value !== "object") {
    throw new TypeError("Discord config resolver returned no config.");
  }
  return Object.freeze({
    applicationId: requiredProviderText(
      value.applicationId,
      "Discord applicationId",
    ),
    publicKey: requiredProviderText(value.publicKey, "Discord publicKey"),
    botToken: requiredProviderText(value.botToken, "Discord botToken"),
  });
}

function safeUser(user: DiscordUser): ChannelJsonObject {
  return Object.freeze({
    id: requiredProviderText(user.id, "Discord user ID"),
    ...(user.username?.trim() ? { username: user.username.trim() } : {}),
    ...(user.global_name?.trim()
      ? { globalName: user.global_name.trim() }
      : {}),
  });
}

async function occurrence(
  interaction: DiscordInteraction,
  transport: DiscordTransport,
) {
  if (interaction.type !== 2 && interaction.type !== 3) return null;
  const user = interaction.member?.user ?? interaction.user;
  if (!user) return null;
  const id = requiredProviderText(interaction.id, "Discord interaction ID");
  const channelId = requiredProviderText(
    interaction.channel_id,
    "Discord channel ID",
  );
  const input: Record<string, unknown> = {
    interactionId: id,
    interactionType: interaction.type,
    channelId,
    user: safeUser(user),
    ...(interaction.guild_id?.trim()
      ? { guildId: interaction.guild_id.trim() }
      : {}),
  };
  if (interaction.type === 2) {
    const options = interaction.data?.options ?? [];
    const prompt = options.find((item) =>
      item.name === "prompt" || item.name === "message"
    );
    if (typeof prompt?.value === "string" && prompt.value.trim()) {
      input.text = prompt.value.trim();
    } else if (interaction.data?.name?.trim()) {
      input.text = `/${interaction.data.name.trim()}`;
    }
    const attachments = [];
    for (const item of options.filter((item) => item.type === 11)) {
      const key = typeof item.value === "string" ? item.value : "";
      const attachment = key
        ? interaction.data?.resolved?.attachments?.[key]
        : undefined;
      if (!attachment?.url) continue;
      const downloaded = await transport.download(attachment.url);
      if (!downloaded) continue;
      attachments.push(Object.freeze({
        dataBase64: bytesToBase64(downloaded.bytes),
        mediaType: attachment.content_type?.trim() || downloaded.mediaType,
        ...(attachment.filename?.trim()
          ? { name: attachment.filename.trim() }
          : downloaded.name
          ? { name: downloaded.name }
          : {}),
      }));
    }
    if (attachments.length) input.attachments = Object.freeze(attachments);
  } else if (interaction.data?.custom_id?.trim()) {
    input.text = interaction.data.custom_id.trim();
  }
  if (!input.text && !input.attachments) return null;
  return Object.freeze({
    id: `discord:${id}`,
    input: Object.freeze(input) as ChannelJsonObject,
  });
}

function mediaKind(value: string): "image" | "audio" | "video" | "file" {
  if (value.startsWith("image/")) return "image";
  if (value.startsWith("audio/")) return "audio";
  if (value.startsWith("video/")) return "video";
  return "file";
}

function chunks(value: string): readonly string[] {
  const result: string[] = [];
  let remaining = value.trim();
  while (remaining.length > 2_000) {
    const window = remaining.slice(0, 2_001);
    const boundary = Math.max(
      window.lastIndexOf("\n"),
      window.lastIndexOf(" "),
    );
    const take = boundary > 1_000 ? boundary : 2_000;
    result.push(remaining.slice(0, take).trim());
    remaining = remaining.slice(take).trimStart();
  }
  if (remaining) result.push(remaining);
  return Object.freeze(result);
}

function action(value: unknown): DiscordActionPayload | null {
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
  options: CreateDiscordChannelAdapterOptions,
  transport: DiscordTransport,
  config: DiscordConfig,
  attempt: ChannelDeliveryAttempt,
  original: DiscordDelivery,
): Promise<unknown> {
  const delivery = options.transformDelivery
    ? await options.transformDelivery(original, attempt)
    : original;
  if (!delivery) return null;
  if (delivery.kind === "text") {
    let result: unknown = null;
    for (const content of chunks(delivery.text)) {
      result = await transport.send(config, delivery.channelId, { content });
    }
    return result;
  }
  if (delivery.kind === "media") {
    return await transport.sendMedia(
      config,
      delivery.channelId,
      delivery.media,
    );
  }
  return await transport.send(config, delivery.channelId, {
    content: delivery.action.message,
    components: [{
      type: 1,
      components: delivery.action.content.map((item) => ({
        type: 2,
        style: 1,
        label: item.text?.slice(0, 80),
        custom_id: item.payload?.slice(0, 100),
      })),
    }],
  });
}

function providerId(value: unknown): string | undefined {
  const id = providerRecord(value).id;
  return typeof id === "string" && id.trim() ? id.trim() : undefined;
}

async function emitContent(
  options: CreateDiscordChannelAdapterOptions,
  transport: DiscordTransport,
  config: DiscordConfig,
  attempt: ChannelDeliveryAttempt,
  channelId: string,
  content: ResolvedContent,
): Promise<unknown | undefined> {
  const text = outboundText(content);
  if (text) {
    return await emit(options, transport, config, attempt, {
      kind: "text",
      channelId,
      text,
    });
  }
  if (["image", "audio", "video", "file"].includes(content.ref.kind)) {
    return await emit(options, transport, config, attempt, {
      kind: "media",
      channelId,
      media: {
        bytes: content.bytes,
        mediaType: content.ref.mediaType,
        ...(content.ref.name ? { name: content.ref.name } : {}),
      },
    });
  }
  return undefined;
}

export function createDiscordChannelAdapter(
  options: CreateDiscordChannelAdapterOptions,
): ChannelAdapter {
  if (!options?.config) throw new TypeError("Discord Adapter requires config.");
  const transport = options.transport ??
    createDiscordTransport({ fetch: options.fetch });
  return Object.freeze({
    async accept(request, context) {
      const config = await configFor(
        options,
        configContext("accept", context, request),
      );
      const signature = requestHeader(request.headers, "x-signature-ed25519");
      const timestamp = requestHeader(request.headers, "x-signature-timestamp");
      if (
        !signature || !timestamp || !request.rawBody ||
        !await verifyDiscordSignature(
          config.publicKey,
          signature,
          timestamp,
          request.rawBody,
        )
      ) {
        return Object.freeze({
          status: 401,
          response: Object.freeze({ error: "Invalid request signature" }),
          occurrences: Object.freeze([]),
        });
      }
      const interaction = request.body as DiscordInteraction;
      if (interaction.type === 1) {
        return Object.freeze({
          status: 200,
          response: Object.freeze({ type: 1 }),
          occurrences: Object.freeze([]),
        });
      }
      const accepted = await occurrence(interaction, transport);
      return Object.freeze({
        status: 200,
        response: accepted
          ? Object.freeze({ type: 5 })
          : Object.freeze({ status: "ok" }),
        occurrences: Object.freeze(accepted ? [accepted] : []),
      });
    },
    receive(value, _context) {
      const input = providerRecord(value);
      const channelId = requiredProviderText(
        input.channelId,
        "Discord channel ID",
      );
      const user = providerRecord(input.user);
      const userId = requiredProviderText(user.id, "Discord user ID");
      const contents: ContentInput[] = [];
      if (typeof input.text === "string" && input.text.trim()) {
        contents.push(input.text.trim());
      }
      for (
        const value of Array.isArray(input.attachments) ? input.attachments : []
      ) {
        const attachment = providerRecord(value);
        const mediaType = requiredProviderText(
          attachment.mediaType,
          "Discord attachment media type",
        );
        contents.push({
          type: mediaKind(mediaType),
          bytes: base64ToBytes(requiredProviderText(
            attachment.dataBase64,
            "Discord attachment base64",
          )),
          mediaType,
          ...(typeof attachment.name === "string"
            ? { name: attachment.name }
            : {}),
        });
      }
      if (!contents.length) throw new TypeError("Discord message is empty.");
      const interactionId = requiredProviderText(
        input.interactionId,
        "Discord interaction ID",
      );
      const name = typeof user.globalName === "string" && user.globalName.trim()
        ? user.globalName.trim()
        : typeof user.username === "string"
        ? user.username.trim()
        : "";
      return Object.freeze({
        externalThreadId: channelId,
        sender: Object.freeze({
          externalId: userId,
          participantType: "human" as const,
          ...(name ? { name } : {}),
          metadata: Object.freeze({
            provider: "discord",
            user: user as ChannelJsonObject,
          }),
        }),
        content: contents.length === 1 ? contents[0] : Object.freeze(contents),
        route: Object.freeze({ channelId }),
        metadata: Object.freeze({
          provider: "discord",
          interactionId,
          interactionType: Number(input.interactionType),
        }),
        thread: Object.freeze({
          metadata: Object.freeze({
            provider: "discord",
            channelId,
            ...(typeof input.guildId === "string"
              ? { guildId: input.guildId }
              : {}),
            userId,
            lastInboundInteractionId: interactionId,
          }),
        }),
      });
    },
    async deliver(attempt, context) {
      const route = providerRecord(attempt.intent.route);
      const channelId = requiredProviderText(
        route.channelId,
        "Discord channel ID",
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
          channelId,
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
          channelId,
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

export {
  createDiscordTransport,
  verifyDiscordSignature,
} from "./internal/transport.ts";
