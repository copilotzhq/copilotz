import type {
  ChannelDeliveryAttempt,
  ChannelJsonObject,
  ChannelRequest,
} from "../types.ts";

export type ZendeskConfig = Readonly<{
  appId: string;
  apiKey: string;
  apiSecret: string;
  webhookSecret?: string;
  businessName?: string;
  businessLogo?: string | null;
}>;
export type ZendeskConfigContext = Readonly<{
  operation: "accept" | "deliver";
  namespace: string;
  channelId: string;
  request?: ChannelRequest;
  route?: ChannelJsonObject;
}>;
export type ZendeskConfigResolver = (
  context: ZendeskConfigContext,
) => ZendeskConfig | Promise<ZendeskConfig>;

export type ZendeskMediaInput = Readonly<{
  bytes: Uint8Array;
  mediaType: string;
  name?: string;
}>;
export type ZendeskTransport = Readonly<{
  download(url: string): Promise<ZendeskMediaInput | null>;
  upload(
    config: ZendeskConfig,
    conversationId: string,
    media: ZendeskMediaInput,
  ): Promise<Readonly<{ mediaUrl: string; mediaType: string }>>;
  send(
    config: ZendeskConfig,
    conversationId: string,
    body: Readonly<Record<string, unknown>>,
  ): Promise<unknown>;
}>;

export type ZendeskActionPayload = Readonly<{
  type: "reply_buttons";
  message: string;
  content: readonly Readonly<{ text?: string; payload?: string }>[];
}>;
export type ZendeskDelivery =
  | Readonly<{ kind: "text"; conversationId: string; text: string }>
  | Readonly<{
    kind: "media";
    conversationId: string;
    media: ZendeskMediaInput;
  }>
  | Readonly<{
    kind: "reply_buttons";
    conversationId: string;
    action: ZendeskActionPayload;
  }>;
export type TransformZendeskDelivery = (
  delivery: ZendeskDelivery,
  attempt: ChannelDeliveryAttempt,
) => ZendeskDelivery | null | Promise<ZendeskDelivery | null>;

export type CreateZendeskChannelResourceOptions = Readonly<{
  defaultAgentAliases?: readonly string[];
  metadata?: ChannelJsonObject;
}>;
export type CreateZendeskChannelAdapterOptions = Readonly<{
  config: ZendeskConfig | ZendeskConfigResolver;
  transport?: ZendeskTransport;
  fetch?: typeof fetch;
  transformDelivery?: TransformZendeskDelivery;
}>;
export type CreateZendeskChannelPluginOptions =
  & CreateZendeskChannelResourceOptions
  & CreateZendeskChannelAdapterOptions
  & Readonly<{ channelId?: string; pluginId?: string; version?: string }>;

export type ZendeskWebhookPayload = Readonly<{
  events?: readonly Readonly<{
    type: string;
    payload?: Readonly<{
      conversation?: Readonly<{
        id: string;
        type?: string;
        activeSwitchboardIntegration?: unknown;
      }>;
      message?: Readonly<{
        id: string;
        author?: Readonly<{
          type: string;
          displayName?: string;
          user?: Readonly<{ id?: string; externalId?: string }>;
        }>;
        content?: Readonly<{
          type: string;
          text?: string;
          mediaUrl?: string;
          mediaType?: string;
          fileName?: string;
        }>;
        source?: unknown;
      }>;
    }>;
  }>[];
}>;
