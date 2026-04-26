import { getChannelContext } from "@/runtime/thread-metadata.ts";

export interface TelegramConfig {
  botToken: string;
  secretToken?: string;
}

export function resolveTelegramConfig(
  config?: Partial<TelegramConfig>,
  context?: Record<string, unknown>,
): TelegramConfig {
  return {
    botToken: config?.botToken ||
      (context?.TELEGRAM_BOT_TOKEN as string) ||
      Deno.env.get("TELEGRAM_BOT_TOKEN") || "",
    secretToken: config?.secretToken ||
      (context?.TELEGRAM_SECRET_TOKEN as string) ||
      Deno.env.get("TELEGRAM_SECRET_TOKEN"),
  };
}

export async function callTelegramAPI(
  config: TelegramConfig,
  method: string,
  body: unknown,
) {
  const url = `https://api.telegram.org/bot${config.botToken}/${method}`;
  
  const options: RequestInit = {
    method: "POST",
  };

  if (body instanceof FormData) {
    options.body = body;
  } else {
    options.headers = {
      "Content-Type": "application/json",
    };
    options.body = JSON.stringify(body);
  }

  const response = await fetch(url, options);

  if (!response.ok) {
    const error = await response.text();
    console.error(`Telegram API error [${response.status}]: ${error}`);
    return null;
  }

  return response.json();
}

export async function downloadTelegramFile(
  config: TelegramConfig,
  fileId: string,
): Promise<Blob | null> {
  const fileInfo = await callTelegramAPI(config, "getFile", { file_id: fileId });
  if (!fileInfo?.ok || !fileInfo.result?.file_path) return null;

  const fileUrl = `https://api.telegram.org/file/bot${config.botToken}/${fileInfo.result.file_path}`;
  const response = await fetch(fileUrl);
  if (!response.ok) return null;

  return await response.blob();
}

export interface TelegramContext {
  chatId: number;
  userId?: number;
  userName?: string;
}

export function getTelegramContext(metadata: unknown): TelegramContext | null {
  return getChannelContext(metadata, "telegram") as unknown as TelegramContext | null;
}
