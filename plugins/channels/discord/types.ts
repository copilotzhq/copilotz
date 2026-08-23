import type { AttachmentOutput } from "@copilotz/copilotz/attachments";
import type { ChannelEgressContext, ChannelRequest } from "../types.ts";

export type DiscordConfig = Readonly<{
  applicationId: string;
  publicKey: string;
  botToken?: string;
}>;

export type DiscordConfigResolver = (
  request: ChannelRequest,
) => DiscordConfig | Promise<DiscordConfig>;

export type DiscordMediaInput = Readonly<{
  bytes: Uint8Array;
  mediaType: string;
  name?: string;
}>;

export type DiscordTransport = Readonly<{
  download(url: string): Promise<DiscordMediaInput | null>;
  send(
    config: DiscordConfig,
    interactionToken: string,
    body: Readonly<Record<string, unknown>>,
    initial: boolean,
  ): Promise<unknown>;
  sendMedia(
    config: DiscordConfig,
    interactionToken: string,
    media: DiscordMediaInput,
    initial: boolean,
  ): Promise<unknown>;
}>;

export type DiscordActionPayload =
  & Readonly<Record<string, unknown>>
  & Readonly<{
    type?: string;
    message?: string;
    content?: readonly Readonly<{ text?: string; payload?: string }>[];
  }>;

export type DiscordTextDeliveryOutput = Readonly<{
  kind: "text";
  interactionToken: string;
  text: string;
  output: AttachmentOutput;
}>;

export type DiscordMediaDeliveryOutput = Readonly<{
  kind: "media";
  interactionToken: string;
  media: DiscordMediaInput;
  output: AttachmentOutput;
}>;

export type DiscordActionDeliveryOutput = Readonly<{
  kind: "reply_buttons";
  interactionToken: string;
  action: DiscordActionPayload;
  output: AttachmentOutput;
}>;

export type DiscordDeliveryOutput =
  | DiscordTextDeliveryOutput
  | DiscordMediaDeliveryOutput
  | DiscordActionDeliveryOutput;

export type TransformDiscordDeliveryOutput = (
  output: DiscordDeliveryOutput,
  context: ChannelEgressContext,
) => DiscordDeliveryOutput | null | Promise<DiscordDeliveryOutput | null>;

export type CreateDiscordChannelOptions = Readonly<{
  id?: string;
  config: DiscordConfig | DiscordConfigResolver;
  defaultAgentIds?: readonly string[];
  transport?: DiscordTransport;
  fetch?: typeof fetch;
  transformOutput?: TransformDiscordDeliveryOutput;
  maxStreamBytes?: number;
}>;

export type CreateDiscordChannelPluginOptions =
  & CreateDiscordChannelOptions
  & Readonly<{ pluginId?: string; version?: string }>;

export type DiscordUser = Readonly<{
  id: string;
  username?: string;
  global_name?: string;
}>;

export type DiscordInteraction = Readonly<{
  id?: string;
  type?: number;
  token?: string;
  channel_id?: string;
  guild_id?: string;
  member?: Readonly<{ user?: DiscordUser }>;
  user?: DiscordUser;
  data?: Readonly<{
    name?: string;
    custom_id?: string;
    options?: readonly Readonly<{
      name: string;
      type?: number;
      value?: unknown;
    }>[];
    resolved?: Readonly<{
      attachments?: Readonly<
        Record<
          string,
          Readonly<{
            url?: string;
            content_type?: string;
            filename?: string;
          }>
        >
      >;
    }>;
  }>;
}>;
