import type {
  ChannelDeliveryAttempt,
  ChannelJsonObject,
  ChannelRequest,
} from "../types.ts";

export type TelegramConfig = Readonly<{
  botToken: string;
  secretToken?: string;
}>;

export type TelegramConfigContext = Readonly<{
  operation: "accept" | "deliver";
  namespace: string;
  channelId: string;
  request?: ChannelRequest;
  route?: ChannelJsonObject;
}>;

export type TelegramConfigResolver = (
  context: TelegramConfigContext,
) => TelegramConfig | Promise<TelegramConfig>;

export type TelegramMediaInput = Readonly<{
  bytes: Uint8Array;
  mediaType: string;
  name?: string;
}>;

export type TelegramTransport = Readonly<{
  call(
    config: TelegramConfig,
    method: string,
    body: Readonly<Record<string, unknown>>,
  ): Promise<unknown>;
  download(
    config: TelegramConfig,
    fileId: string,
  ): Promise<TelegramMediaInput | null>;
  sendMedia(
    config: TelegramConfig,
    chatId: string,
    media: TelegramMediaInput,
  ): Promise<unknown>;
}>;

export type TelegramActionPayload = Readonly<{
  type: "reply_buttons";
  message: string;
  content: readonly Readonly<{ text?: string; payload?: string }>[];
}>;

export type TelegramDelivery =
  | Readonly<{ kind: "text"; chatId: string; text: string }>
  | Readonly<{ kind: "media"; chatId: string; media: TelegramMediaInput }>
  | Readonly<{
    kind: "reply_buttons";
    chatId: string;
    action: TelegramActionPayload;
  }>;

export type TransformTelegramDelivery = (
  delivery: TelegramDelivery,
  attempt: ChannelDeliveryAttempt,
) => TelegramDelivery | null | Promise<TelegramDelivery | null>;

export type CreateTelegramChannelResourceOptions = Readonly<{
  defaultAgentAliases?: readonly string[];
  metadata?: ChannelJsonObject;
}>;

export type CreateTelegramChannelAdapterOptions = Readonly<{
  config: TelegramConfig | TelegramConfigResolver;
  transport?: TelegramTransport;
  fetch?: typeof fetch;
  transformDelivery?: TransformTelegramDelivery;
}>;

export type CreateTelegramChannelPluginOptions =
  & CreateTelegramChannelResourceOptions
  & CreateTelegramChannelAdapterOptions
  & Readonly<{ channelId?: string; pluginId?: string; version?: string }>;

export type TelegramUser = Readonly<{
  id: string | number;
  username?: string;
  first_name?: string;
  last_name?: string;
}>;

export type TelegramMessage = Readonly<{
  message_id: string | number;
  chat: Readonly<{ id: string | number }>;
  from?: TelegramUser;
  text?: string;
  caption?: string;
  photo?: readonly Readonly<{ file_id: string }>[];
  voice?: Readonly<{ file_id: string; mime_type?: string; file_name?: string }>;
  audio?: Readonly<{ file_id: string; mime_type?: string; file_name?: string }>;
  video?: Readonly<{ file_id: string; mime_type?: string; file_name?: string }>;
  document?: Readonly<{
    file_id: string;
    mime_type?: string;
    file_name?: string;
  }>;
}>;

export type TelegramUpdate = Readonly<{
  update_id?: string | number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
  callback_query?: Readonly<{
    id: string;
    from: TelegramUser;
    data?: string;
    message?: Readonly<{ chat: Readonly<{ id: string | number }> }>;
  }>;
}>;
