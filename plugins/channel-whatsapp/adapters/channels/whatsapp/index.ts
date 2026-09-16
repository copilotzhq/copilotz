import { channelProviderOptions } from "@copilotz/copilotz/channels/core";
/**
 * Defines the WhatsApp Channel Adapter.
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
  requiredProviderText,
} from "@copilotz/copilotz/channels/core";
import type {
  ChannelAdapter,
  ChannelDeliveryAttempt,
  ChannelJsonObject,
} from "@copilotz/copilotz/channels/core";
import {
  buildWhatsAppMediaCarouselMessage,
  buildWhatsAppReplyButtonsMessage,
  normalizeWhatsAppActionPayload,
  resolveWhatsAppMediaCarouselAction,
  splitWhatsAppText,
} from "../../../authoring/messages/index.ts";
import {
  createWhatsAppGraphTransport,
  verifyWhatsAppSignature,
  whatsappHeader,
} from "./transport.ts";
import type {
  WhatsAppActionPayload,
  WhatsAppChannelOptions,
  WhatsAppConfig,
  WhatsAppConfigContext,
  WhatsAppDelivery,
  WhatsAppMediaCarouselAction,
  WhatsAppTransport,
  WhatsAppWebhookMessage,
  WhatsAppWebhookPayload,
} from "../../../shared/contracts.ts";

function query(request: { query?: Record<string, unknown> }, key: string) {
  const value = request.query?.[key];
  return Array.isArray(value) ? value[0] : value;
}

function configContext(
  operation: WhatsAppConfigContext["operation"],
  context: Readonly<{ namespace: string; channelId: string }>,
  request?: WhatsAppConfigContext["request"],
  route?: ChannelJsonObject,
): WhatsAppConfigContext {
  return ({
    operation,
    namespace: context.namespace,
    channelId: context.channelId,
    ...(request ? { request } : {}),
    ...(route ? { route } : {}),
  } as const);
}

async function configFor(
  options: WhatsAppChannelOptions,
  context: WhatsAppConfigContext,
): Promise<WhatsAppConfig> {
  const value = typeof options.config === "function"
    ? await options.config(context)
    : options.config;
  if (!value || typeof value !== "object") {
    throw new TypeError("WhatsApp config resolver returned no config.");
  }
  return ({
    accessToken: requiredProviderText(
      value.accessToken,
      "WhatsApp accessToken",
    ),
    phoneId: typeof value.phoneId === "string" ? value.phoneId.trim() : "",
    ...(value.appSecret?.trim() ? { appSecret: value.appSecret.trim() } : {}),
    ...(value.webhookVerifyToken?.trim()
      ? { webhookVerifyToken: value.webhookVerifyToken.trim() }
      : {}),
    graphApiVersion: value.graphApiVersion?.trim() || "v25.0",
  } as const);
}

function media(message: WhatsAppWebhookMessage): ChannelJsonObject | null {
  const value = message.image?.id
    ? {
      id: message.image.id,
      kind: "image",
      ...(message.image.mime_type
        ? { mediaType: message.image.mime_type }
        : {}),
    }
    : message.audio?.id
    ? {
      id: message.audio.id,
      kind: "audio",
      ...(message.audio.mime_type
        ? { mediaType: message.audio.mime_type }
        : {}),
    }
    : message.video?.id
    ? {
      id: message.video.id,
      kind: "video",
      ...(message.video.mime_type
        ? { mediaType: message.video.mime_type }
        : {}),
    }
    : message.document?.id
    ? {
      id: message.document.id,
      kind: "file",
      ...(message.document.mime_type
        ? { mediaType: message.document.mime_type }
        : {}),
      ...(message.document.filename ? { name: message.document.filename } : {}),
    }
    : null;
  return value ? value : null;
}

function caption(message: WhatsAppWebhookMessage): string | undefined {
  return message.text?.body?.trim() || message.image?.caption?.trim() ||
    message.video?.caption?.trim() || message.document?.caption?.trim() ||
    message.interactive?.button_reply?.title?.trim() ||
    message.interactive?.list_reply?.title?.trim() || undefined;
}

async function occurrence(
  options: WhatsAppChannelOptions,
  transport: WhatsAppTransport,
  config: WhatsAppConfig,
  input: Readonly<{
    businessId: string;
    phoneId?: string;
    userName?: string;
    message: WhatsAppWebhookMessage;
  }>,
) {
  const senderPhone = requiredProviderText(
    input.message.from,
    "WhatsApp sender phone",
  );
  const messageId = requiredProviderText(
    input.message.id,
    "WhatsApp message ID",
  );
  const text = caption(input.message);
  const attachment = media(input.message);
  let persistedMedia: ChannelJsonObject | null = null;
  if (attachment) {
    const downloadConfig = {
      ...config,
      phoneId: input.phoneId?.trim() || config.phoneId,
    } as const;
    const downloaded = await transport.download(downloadConfig, {
      id: requiredProviderText(attachment.id, "WhatsApp media ID"),
      ...(typeof attachment.mediaType === "string"
        ? { mediaType: attachment.mediaType }
        : {}),
      ...(typeof attachment.name === "string" ? { name: attachment.name } : {}),
    });
    if (!downloaded) {
      throw new Error("WhatsApp media download returned no content.");
    }
    persistedMedia = {
      kind: requiredProviderText(attachment.kind, "WhatsApp media kind"),
      dataBase64: bytesToBase64(downloaded.bytes),
      mediaType: downloaded.mediaType,
      ...(downloaded.name ? { name: downloaded.name } : {}),
    } as const;
  }
  if (!text && !persistedMedia) return null;
  const externalThreadId = options.threadExternalId?.({
    senderPhone,
    phoneId: input.phoneId,
    businessId: input.businessId,
  })?.trim() || senderPhone;
  const interactive = input.message.interactive?.button_reply ??
    input.message.interactive?.list_reply;
  return ({
    id: `whatsapp:${messageId}`,
    input: {
      externalThreadId,
      businessId: requiredProviderText(
        input.businessId,
        "WhatsApp business ID",
      ),
      ...(input.phoneId?.trim() ? { phoneId: input.phoneId.trim() } : {}),
      senderPhone,
      messageId,
      messageType: requiredProviderText(
        input.message.type,
        "WhatsApp message type",
      ),
      ...(input.message.timestamp
        ? { timestamp: String(input.message.timestamp) }
        : {}),
      ...(input.userName?.trim() ? { userName: input.userName.trim() } : {}),
      ...(text ? { text } : {}),
      ...(persistedMedia ? { media: persistedMedia } : {}),
      ...(interactive
        ? {
          interactive: {
            ...(interactive.id?.trim() ? { id: interactive.id.trim() } : {}),
            ...(interactive.title?.trim()
              ? { title: interactive.title.trim() }
              : {}),
            ...(interactive.description?.trim()
              ? { description: interactive.description.trim() }
              : {}),
          } as const,
        }
        : {}),
    } as const,
  } as const);
}

function responseIds(value: unknown): readonly string[] {
  const messages = providerRecord(value).messages;
  return Array.isArray(messages)
    ? (messages.flatMap((item) => {
      const id = providerRecord(item).id;
      return typeof id === "string" && id.trim() ? [id.trim()] : [];
    }))
    : ([] as const);
}

async function emit(
  options: WhatsAppChannelOptions,
  transport: WhatsAppTransport,
  config: WhatsAppConfig,
  attempt: ChannelDeliveryAttempt,
  original: WhatsAppDelivery,
): Promise<readonly string[]> {
  const delivery = options.transformDelivery
    ? await options.transformDelivery(original, attempt)
    : original;
  if (!delivery) return [];
  if (delivery.kind === "text") {
    const ids: string[] = [];
    for (const text of splitWhatsAppText(delivery.text)) {
      ids.push(...responseIds(
        await transport.send(config, {
          messaging_product: "whatsapp",
          to: delivery.to,
          type: "text",
          text: { body: text },
        }),
      ));
    }
    return ids;
  }
  if (delivery.kind === "media") {
    const uploaded = await transport.upload(config, delivery.media);
    return responseIds(
      await transport.send(config, {
        messaging_product: "whatsapp",
        to: delivery.to,
        type: uploaded.type,
        [uploaded.type]: {
          id: uploaded.id,
          ...(uploaded.type === "document" && delivery.media.name
            ? { filename: delivery.media.name }
            : {}),
        },
      }),
    );
  }
  if (delivery.kind === "reply_buttons") {
    const body = buildWhatsAppReplyButtonsMessage(
      delivery.to,
      delivery.action,
    );
    return body ? responseIds(await transport.send(config, body)) : [];
  }
  const resolved = await resolveWhatsAppMediaCarouselAction(
    delivery.action,
    (media) => transport.upload(config, media),
  );
  const body = resolved
    ? buildWhatsAppMediaCarouselMessage(delivery.to, resolved)
    : null;
  if (body) return responseIds(await transport.send(config, body));
  const fallback = delivery.action.fallbackText?.trim() ||
    delivery.action.message?.trim();
  return fallback
    ? await emit(options, transport, config, attempt, {
      kind: "text",
      to: delivery.to,
      text: fallback,
    })
    : [];
}

function action(value: unknown): WhatsAppActionPayload | null {
  const result = normalizeWhatsAppActionPayload(value);
  return result?.type === "reply_buttons" || result?.type === "media_carousel"
    ? result
    : null;
}

async function emitContent(
  options: WhatsAppChannelOptions,
  transport: WhatsAppTransport,
  config: WhatsAppConfig,
  attempt: ChannelDeliveryAttempt,
  to: string,
  content: ResolvedContent,
): Promise<readonly string[]> {
  const text = outboundText(content);
  if (text) {
    return await emit(options, transport, config, attempt, {
      kind: "text",
      to,
      text,
    });
  }
  if (["image", "audio", "video", "file"].includes(content.ref.kind)) {
    return await emit(options, transport, config, attempt, {
      kind: "media",
      to,
      media: {
        bytes: content.bytes,
        mediaType: content.ref.mediaType,
        ...(content.ref.name ? { name: content.ref.name } : {}),
      },
    });
  }
  return [];
}

export const whatsappChannelAdapter: ChannelAdapter = {
  async accept(request, context) {
    const options = channelProviderOptions<WhatsAppChannelOptions>(context);
    const transport = options.transport ??
      createWhatsAppGraphTransport({ fetch: options.fetch });
    const config = await configFor(
      options,
      configContext("accept", context, request),
    );
    if (request.method.toUpperCase() === "GET") {
      const verified = query(request, "hub.mode") === "subscribe" &&
        query(request, "hub.verify_token") === config.webhookVerifyToken;
      return ({
        status: verified ? 200 : 403,
        response: verified
          ? query(request, "hub.challenge") ?? ""
          : ({ error: "Forbidden" } as const),
        occurrences: [] as const,
      } as const);
    }
    if (config.appSecret) {
      const signature = whatsappHeader(
        request.headers,
        "x-hub-signature-256",
      );
      if (
        !signature || !request.rawBody ||
        !await verifyWhatsAppSignature(
          request.rawBody,
          config.appSecret,
          signature,
        )
      ) {
        return ({
          status: 403,
          response: { error: "Forbidden" } as const,
          occurrences: [] as const,
        } as const);
      }
    }
    const payload = request.body as WhatsAppWebhookPayload;
    const occurrences = [];
    for (const entry of payload?.entry ?? []) {
      for (const change of entry.changes ?? []) {
        const value = change.value;
        const userName = value?.contacts?.[0]?.profile?.name;
        const phoneId = value?.metadata?.phone_number_id;
        for (const message of value?.messages ?? []) {
          const accepted = await occurrence(options, transport, config, {
            businessId: entry.id,
            phoneId,
            userName,
            message,
          });
          if (accepted) occurrences.push(accepted);
        }
      }
    }
    return ({
      status: 200,
      response: { status: "ok" } as const,
      occurrences: occurrences,
    } as const);
  },
  receive(value, _context) {
    const input = providerRecord(value);
    const externalThreadId = requiredProviderText(
      input.externalThreadId,
      "WhatsApp external thread ID",
    );
    const senderPhone = requiredProviderText(
      input.senderPhone,
      "WhatsApp sender phone",
    );
    const phoneId = typeof input.phoneId === "string"
      ? input.phoneId.trim()
      : "";
    const contents: ContentInput[] = [];
    if (typeof input.text === "string" && input.text.trim()) {
      contents.push(input.text.trim());
    }
    const descriptor = providerRecord(input.media);
    if (Object.keys(descriptor).length) {
      contents.push({
        type: requiredProviderText(
          descriptor.kind,
          "WhatsApp media kind",
        ) as "image" | "audio" | "video" | "file",
        bytes: base64ToBytes(requiredProviderText(
          descriptor.dataBase64,
          "WhatsApp media base64",
        )),
        mediaType: requiredProviderText(
          descriptor.mediaType,
          "WhatsApp media type",
        ),
        ...(typeof descriptor.name === "string"
          ? { name: descriptor.name }
          : {}),
      });
    }
    if (!contents.length) throw new TypeError("WhatsApp message is empty.");
    const messageId = requiredProviderText(
      input.messageId,
      "WhatsApp message ID",
    );
    const businessId = requiredProviderText(
      input.businessId,
      "WhatsApp business ID",
    );
    const userName = typeof input.userName === "string"
      ? input.userName.trim()
      : "";
    return ({
      externalThreadId,
      sender: {
        externalId: senderPhone,
        participantType: "human" as const,
        ...(userName ? { name: userName } : {}),
        metadata: {
          provider: "whatsapp",
          phone: senderPhone,
        } as const,
      } as const,
      content: contents.length === 1 ? contents[0] : contents,
      route: {
        recipientPhone: senderPhone,
        ...(phoneId ? { phoneId } : {}),
        businessId,
      } as const,
      metadata: {
        provider: "whatsapp",
        providerMessageId: messageId,
        ...(typeof input.timestamp === "string"
          ? { providerTimestamp: input.timestamp }
          : {}),
        messageType: requiredProviderText(
          input.messageType,
          "WhatsApp message type",
        ),
        ...(input.interactive && typeof input.interactive === "object"
          ? { interactive: input.interactive as ChannelJsonObject }
          : {}),
      } as const,
      thread: {
        metadata: {
          provider: "whatsapp",
          recipientPhone: senderPhone,
          ...(phoneId ? { phoneId } : {}),
          businessId,
          ...(userName ? { userName } : {}),
          lastInboundMessageId: messageId,
        } as const,
      } as const,
    } as const);
  },
  async deliver(attempt, context) {
    const options = channelProviderOptions<WhatsAppChannelOptions>(context);
    const transport = options.transport ??
      createWhatsAppGraphTransport({ fetch: options.fetch });
    const route = providerRecord(attempt.intent.route);
    const to = requiredProviderText(
      route.recipientPhone,
      "WhatsApp recipient phone",
    );
    const phoneId = typeof route.phoneId === "string"
      ? route.phoneId.trim()
      : "";
    const base = await configFor(
      options,
      configContext("deliver", context, undefined, attempt.intent.route),
    );
    const config = {
      ...base,
      phoneId: phoneId || requiredProviderText(
        base.phoneId,
        "WhatsApp phoneId",
      ),
    } as const;
    const providerIds: string[] = [];
    let delivered = 0;
    for (const content of attempt.content) {
      const ids = await emitContent(
        options,
        transport,
        config,
        attempt,
        to,
        content,
      );
      if (
        ids.length || outboundText(content) ||
        ["image", "audio", "video", "file"].includes(content.ref.kind)
      ) {
        delivered += 1;
        providerIds.push(...ids);
      }
    }
    const metadata = providerRecord(attempt.intent.metadata);
    const message = providerRecord(metadata.message);
    const semantic = action(message);
    if (semantic) {
      const ids = await emit(
        options,
        transport,
        config,
        attempt,
        semantic.type === "media_carousel"
          ? {
            kind: "media_carousel",
            to,
            action: semantic as WhatsAppMediaCarouselAction,
          }
          : { kind: "reply_buttons", to, action: semantic },
      );
      delivered += 1;
      providerIds.push(...ids);
    }
    return ({
      deliveryKey: attempt.intent.deliveryKey,
      delivered,
      ...(providerIds.length ? { providerIds: providerIds } : {}),
    } as const);
  },
} as const;

export {
  createWhatsAppGraphTransport,
  verifyWhatsAppSignature,
  whatsappHeader,
} from "./transport.ts";

export default whatsappChannelAdapter;
