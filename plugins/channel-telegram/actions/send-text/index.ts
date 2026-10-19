/** One bounded Telegram request under the owner's external-effect protocol.
 * The standard channel delivery Action uses the same effect protocol. @module */
import {
  type ActionContext,
  type ActionDefinition,
  defineAction,
} from "@copilotz/copilotz/actions";
import { channelProviderOptions } from "@copilotz/copilotz/channels/core";
import type { TelegramChannelOptions } from "../../adapters/channels/telegram/contracts.ts";
import { createTelegramTransport } from "../../adapters/channels/telegram/transport.ts";

export const TELEGRAM_SEND_TEXT_ACTION_ID = "copilotz.telegram.sendText";
export const TELEGRAM_SEND_TEXT_STEP = "telegram.sendText";
export type TelegramSendTextInput = Readonly<{
  deliveryKey: string;
  channelId: string;
  chatId: string;
  text: string;
}>;
export type TelegramSendTextOutput = Readonly<{
  deliveryKey: string;
  providerId: string;
}>;
const inputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    deliveryKey: { type: "string", minLength: 1, maxLength: 256 },
    channelId: { type: "string", minLength: 1, maxLength: 256 },
    chatId: { type: "string", minLength: 1, maxLength: 256 },
    text: { type: "string", minLength: 1, maxLength: 4000 },
  },
  required: ["deliveryKey", "channelId", "chatId", "text"],
} as const;
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Telegram send-text data must be an object.");
  }
  return value as Record<string, unknown>;
}
function input(value: TelegramSendTextInput): TelegramSendTextInput {
  const data = object(value);
  if (
    Object.keys(data).sort().join(",") !== "channelId,chatId,deliveryKey,text"
  ) {
    throw new TypeError("Invalid Telegram send-text fields.");
  }
  for (
    const [key, limit] of [["deliveryKey", 256], ["channelId", 256], [
      "chatId",
      256,
    ], ["text", 4000]] as const
  ) {
    const item = data[key];
    if (typeof item !== "string" || !item.trim() || item.length > limit) {
      throw new TypeError(`Invalid Telegram send-text ${key}.`);
    }
  }
  return {
    deliveryKey: value.deliveryKey,
    channelId: value.channelId,
    chatId: value.chatId,
    text: value.text,
  };
}
function result(value: unknown, deliveryKey: string): TelegramSendTextOutput {
  const data = object(value);
  if (
    Object.keys(data).sort().join(",") !== "deliveryKey,providerId" ||
    data.deliveryKey !== deliveryKey || typeof data.providerId !== "string" ||
    !/^\d{1,20}$/.test(data.providerId)
  ) {
    throw new TypeError("Invalid Telegram effect outcome.");
  }
  return { deliveryKey, providerId: data.providerId };
}
function indeterminate(): never {
  throw Object.assign(
    new Error("Telegram send requires effect reconciliation."),
    { code: "effect_indeterminate" },
  );
}

export const telegramSendTextAction: ActionDefinition<
  TelegramSendTextInput,
  TelegramSendTextOutput,
  ActionContext,
  typeof inputSchema,
  undefined
> = defineAction({
  id: TELEGRAM_SEND_TEXT_ACTION_ID,
  inputSchema,
  // The current transport has no authoritative request lookup. Never resend a
  // begun request or infer not_started from HTTP status or a network exception.
  reconcile() {
    return { status: "indeterminate" } as const;
  },
  async execute(
    raw: TelegramSendTextInput,
    context: ActionContext,
  ): Promise<TelegramSendTextOutput> {
    const value = input(raw);
    const resource = context.resources.channels?.[value.channelId] as {
      egress?: unknown;
    } | undefined;
    if (resource?.egress !== "external") {
      throw new TypeError("Telegram channel must permit external egress.");
    }
    const options = channelProviderOptions<TelegramChannelOptions>({
      adapters: context.adapters,
      channelId: value.channelId,
    });
    if (options.transformDelivery) {
      throw new TypeError(
        "Telegram send-text does not support delivery transforms.",
      );
    }
    context.signal.throwIfAborted();
    const permission = await context.effect.begin(TELEGRAM_SEND_TEXT_STEP);
    if (permission.status === "replay") {
      return result(permission.outcome, value.deliveryKey);
    }
    if (permission.status !== "proceed") return indeterminate();
    let output: TelegramSendTextOutput;
    try {
      const config = typeof options.config === "function"
        ? await options.config({
          operation: "deliver",
          namespace: context.namespace,
          channelId: value.channelId,
          route: { chatId: value.chatId },
        })
        : options.config;
      if (
        !config || typeof config.botToken !== "string" ||
        !config.botToken.trim()
      ) throw new TypeError("Telegram botToken must be non-empty.");
      const transport = options.transport ??
        createTelegramTransport({ fetch: options.fetch });
      context.signal.throwIfAborted();
      const response = object(
        await transport.call(config, "sendMessage", {
          chat_id: value.chatId,
          text: value.text,
        }, { signal: context.signal }),
      );
      const id = object(response.result).message_id;
      if (response.ok !== true || !Number.isSafeInteger(id) || Number(id) < 0) {
        throw new TypeError(
          "Telegram send returned no valid message reference.",
        );
      }
      output = result({
        deliveryKey: value.deliveryKey,
        providerId: String(id),
      }, value.deliveryKey);
    } catch {
      return indeterminate();
    }
    await context.effect.confirm(TELEGRAM_SEND_TEXT_STEP, output);
    return output;
  },
});
export default telegramSendTextAction;
