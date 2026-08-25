/**
 * Declares the public Discord Channel contracts.
 *
 * @module
 */

import type {
  ChannelDeliveryAttempt,
  ChannelJsonObject,
  ChannelRequest,
} from "../../channel-core/internal/contracts.ts";

export type DiscordConfig = Readonly<{
  applicationId: string;
  publicKey: string;
  botToken: string;
}>;
export type DiscordConfigContext = Readonly<{
  operation: "accept" | "deliver";
  namespace: string;
  channelId: string;
  request?: ChannelRequest;
  route?: ChannelJsonObject;
}>;
export type DiscordConfigResolver = (
  context: DiscordConfigContext,
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
    channelId: string,
    body: Readonly<Record<string, unknown>>,
  ): Promise<unknown>;
  sendMedia(
    config: DiscordConfig,
    channelId: string,
    media: DiscordMediaInput,
  ): Promise<unknown>;
}>;

export type DiscordActionPayload = Readonly<{
  type: "reply_buttons";
  message: string;
  content: readonly Readonly<{ text?: string; payload?: string }>[];
}>;
export type DiscordDelivery =
  | Readonly<{ kind: "text"; channelId: string; text: string }>
  | Readonly<{ kind: "media"; channelId: string; media: DiscordMediaInput }>
  | Readonly<{
    kind: "reply_buttons";
    channelId: string;
    action: DiscordActionPayload;
  }>;
export type TransformDiscordDelivery = (
  delivery: DiscordDelivery,
  attempt: ChannelDeliveryAttempt,
) => DiscordDelivery | null | Promise<DiscordDelivery | null>;

export type CreateDiscordChannelResourceOptions = Readonly<{
  defaultAgentAliases?: readonly string[];
  metadata?: ChannelJsonObject;
}>;
export type CreateDiscordChannelAdapterOptions = Readonly<{
  config: DiscordConfig | DiscordConfigResolver;
  transport?: DiscordTransport;
  fetch?: typeof fetch;
  transformDelivery?: TransformDiscordDelivery;
}>;
export type CreateDiscordChannelPluginOptions =
  & CreateDiscordChannelResourceOptions
  & CreateDiscordChannelAdapterOptions
  & Readonly<{ channelId?: string; pluginId?: string; version?: string }>;

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
