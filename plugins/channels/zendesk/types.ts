import type { AttachmentOutput } from "@copilotz/copilotz/attachments";
import type { ChannelEgressContext, ChannelRequest } from "../types.ts";

export type ZendeskConfig = Readonly<{
  appId: string;
  apiKey: string;
  apiSecret: string;
  webhookSecret?: string;
  businessName?: string;
  businessLogo?: string | null;
}>;

export type ZendeskConfigResolver = (
  request: ChannelRequest,
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

export type ZendeskReplyButtonInput = Readonly<{
  text?: string;
  payload?: string;
}>;

export type ZendeskActionPayload =
  & Readonly<Record<string, unknown>>
  & Readonly<{
    type?: string;
    message?: string;
    content?: readonly ZendeskReplyButtonInput[];
  }>;

export type ZendeskTextDeliveryOutput = Readonly<{
  kind: "text";
  conversationId: string;
  text: string;
  output: AttachmentOutput;
}>;

export type ZendeskMediaDeliveryOutput = Readonly<{
  kind: "media";
  conversationId: string;
  media: ZendeskMediaInput;
  output: AttachmentOutput;
}>;

export type ZendeskActionDeliveryOutput = Readonly<{
  kind: "reply_buttons";
  conversationId: string;
  action: ZendeskActionPayload;
  output: AttachmentOutput;
}>;

export type ZendeskDeliveryOutput =
  | ZendeskTextDeliveryOutput
  | ZendeskMediaDeliveryOutput
  | ZendeskActionDeliveryOutput;

export type TransformZendeskDeliveryOutput = (
  output: ZendeskDeliveryOutput,
  context: ChannelEgressContext,
) => ZendeskDeliveryOutput | null | Promise<ZendeskDeliveryOutput | null>;

export type CreateZendeskChannelOptions = Readonly<{
  id?: string;
  config: ZendeskConfig | ZendeskConfigResolver;
  defaultAgentIds?: readonly string[];
  transport?: ZendeskTransport;
  fetch?: typeof fetch;
  transformOutput?: TransformZendeskDeliveryOutput;
  maxStreamBytes?: number;
}>;

export type CreateZendeskChannelPluginOptions =
  & CreateZendeskChannelOptions
  & Readonly<{ pluginId?: string; version?: string }>;

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
