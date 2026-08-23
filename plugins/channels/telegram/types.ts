import type { AttachmentOutput } from "@copilotz/copilotz/attachments";
import type { ChannelEgressContext, ChannelRequest } from "../types.ts";

export type TelegramConfig = Readonly<{
  botToken: string;
  secretToken?: string;
}>;

export type TelegramConfigResolver = (
  request: ChannelRequest,
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

export type TelegramActionPayload =
  & Readonly<Record<string, unknown>>
  & Readonly<{
    type?: string;
    message?: string;
    content?: readonly Readonly<{ text?: string; payload?: string }>[];
  }>;

export type TelegramTextDeliveryOutput = Readonly<{
  kind: "text";
  chatId: string;
  text: string;
  output: AttachmentOutput;
}>;

export type TelegramMediaDeliveryOutput = Readonly<{
  kind: "media";
  chatId: string;
  media: TelegramMediaInput;
  output: AttachmentOutput;
}>;

export type TelegramActionDeliveryOutput = Readonly<{
  kind: "reply_buttons";
  chatId: string;
  action: TelegramActionPayload;
  output: AttachmentOutput;
}>;

export type TelegramDeliveryOutput =
  | TelegramTextDeliveryOutput
  | TelegramMediaDeliveryOutput
  | TelegramActionDeliveryOutput;

export type TransformTelegramDeliveryOutput = (
  output: TelegramDeliveryOutput,
  context: ChannelEgressContext,
) => TelegramDeliveryOutput | null | Promise<TelegramDeliveryOutput | null>;

export type CreateTelegramChannelOptions = Readonly<{
  id?: string;
  config: TelegramConfig | TelegramConfigResolver;
  defaultAgentIds?: readonly string[];
  transport?: TelegramTransport;
  fetch?: typeof fetch;
  transformOutput?: TransformTelegramDeliveryOutput;
  maxStreamBytes?: number;
}>;

export type CreateTelegramChannelPluginOptions =
  & CreateTelegramChannelOptions
  & Readonly<{ pluginId?: string; version?: string }>;

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
