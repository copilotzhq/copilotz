import type {
  ChannelDeliveryAttempt,
  ChannelJsonObject,
  ChannelRequest,
} from "../types.ts";

export type WhatsAppConfig = Readonly<{
  accessToken: string;
  phoneId: string;
  appSecret?: string;
  webhookVerifyToken?: string;
  graphApiVersion?: string;
}>;

export type WhatsAppConfigContext = Readonly<{
  operation: "accept" | "deliver";
  namespace: string;
  channelId: string;
  request?: ChannelRequest;
  route?: ChannelJsonObject;
}>;

export type WhatsAppConfigResolver = (
  context: WhatsAppConfigContext,
) => WhatsAppConfig | Promise<WhatsAppConfig>;

export type WhatsAppDownloadedMedia = Readonly<{
  bytes: Uint8Array;
  mediaType: string;
  name?: string;
}>;

export type WhatsAppMediaInput = Readonly<{
  bytes: Uint8Array;
  mediaType: string;
  name?: string;
}>;

export type WhatsAppUploadedMedia = Readonly<{
  id: string;
  type: "image" | "video" | "audio" | "document";
}>;

export type WhatsAppTransport = Readonly<{
  download(
    config: WhatsAppConfig,
    input: Readonly<{ id: string; mediaType?: string; name?: string }>,
  ): Promise<WhatsAppDownloadedMedia | null>;
  upload(
    config: WhatsAppConfig,
    input: WhatsAppMediaInput,
  ): Promise<WhatsAppUploadedMedia>;
  send(
    config: WhatsAppConfig,
    body: Readonly<Record<string, unknown>>,
  ): Promise<unknown>;
}>;

export type WhatsAppReplyButtonInput = Readonly<{
  type?: string;
  text?: string;
  payload?: string;
}>;
export type WhatsAppReplyButton = Readonly<{
  type: "reply";
  reply: Readonly<{ id: string; title: string }>;
}>;
export type WhatsAppCarouselImageInput = Readonly<{
  id?: string;
  link?: string;
  bytes?: Uint8Array;
  mediaType?: string;
}>;
export type WhatsAppCarouselQuickReplyInput = Readonly<{
  type?: "quick_reply";
  text?: string;
  payload?: string;
}>;
export type WhatsAppMediaCarouselCardInput = Readonly<{
  body?: string;
  image?: WhatsAppCarouselImageInput;
  renderData?: unknown;
  buttons?: readonly WhatsAppCarouselQuickReplyInput[];
}>;
export type WhatsAppActionPayload = Readonly<{
  type?: string;
  message?: string;
  content?: readonly WhatsAppReplyButtonInput[];
  fallbackText?: string;
  cards?: readonly WhatsAppMediaCarouselCardInput[];
}>;
export type WhatsAppMediaCarouselAction =
  & WhatsAppActionPayload
  & Readonly<{
    type: "media_carousel";
    message: string;
    cards: readonly WhatsAppMediaCarouselCardInput[];
  }>;
export type WhatsAppResolvedCarouselCard = Readonly<{
  body?: string;
  image: Readonly<{ id: string }> | Readonly<{ link: string }>;
  buttons: readonly Readonly<{
    type: "quick_reply";
    text: string;
    payload: string;
  }>[];
}>;
export type WhatsAppResolvedMediaCarouselAction = Readonly<{
  type: "media_carousel";
  message: string;
  fallbackText?: string;
  cards: readonly WhatsAppResolvedCarouselCard[];
}>;

export type WhatsAppDelivery =
  | Readonly<{ kind: "text"; to: string; text: string }>
  | Readonly<{ kind: "media"; to: string; media: WhatsAppMediaInput }>
  | Readonly<{
    kind: "reply_buttons";
    to: string;
    action: WhatsAppActionPayload;
  }>
  | Readonly<{
    kind: "media_carousel";
    to: string;
    action: WhatsAppMediaCarouselAction;
  }>;

export type TransformWhatsAppDelivery = (
  delivery: WhatsAppDelivery,
  attempt: ChannelDeliveryAttempt,
) => WhatsAppDelivery | null | Promise<WhatsAppDelivery | null>;

export type CreateWhatsAppChannelResourceOptions = Readonly<{
  defaultAgentAliases?: readonly string[];
  metadata?: ChannelJsonObject;
}>;
export type CreateWhatsAppChannelAdapterOptions = Readonly<{
  config: WhatsAppConfig | WhatsAppConfigResolver;
  transport?: WhatsAppTransport;
  fetch?: typeof fetch;
  transformDelivery?: TransformWhatsAppDelivery;
  threadExternalId?: (
    input: Readonly<{
      senderPhone: string;
      phoneId?: string;
      businessId: string;
    }>,
  ) => string;
}>;
export type CreateWhatsAppChannelPluginOptions =
  & CreateWhatsAppChannelResourceOptions
  & CreateWhatsAppChannelAdapterOptions
  & Readonly<{ channelId?: string; pluginId?: string; version?: string }>;

export type WhatsAppInteractiveReply = Readonly<{
  id?: string;
  title?: string;
  description?: string;
}>;
export type WhatsAppWebhookMessage = Readonly<{
  from: string;
  id: string;
  timestamp?: string;
  type: string;
  text?: Readonly<{ body?: string }>;
  audio?: Readonly<{ id: string; mime_type?: string }>;
  image?: Readonly<{ id: string; mime_type?: string; caption?: string }>;
  video?: Readonly<{ id: string; mime_type?: string; caption?: string }>;
  document?: Readonly<{
    id: string;
    mime_type?: string;
    filename?: string;
    caption?: string;
  }>;
  interactive?: Readonly<{
    type?: string;
    button_reply?: WhatsAppInteractiveReply;
    list_reply?: WhatsAppInteractiveReply;
  }>;
}>;
export type WhatsAppWebhookPayload = Readonly<{
  entry?: readonly Readonly<{
    id: string;
    changes?: readonly Readonly<{
      value?: Readonly<{
        messages?: readonly WhatsAppWebhookMessage[];
        metadata?: Readonly<{ phone_number_id?: string }>;
        contacts?: readonly Readonly<{
          wa_id?: string;
          profile?: Readonly<{ name?: string }>;
        }>[];
      }>;
    }>[];
  }>[];
}>;
