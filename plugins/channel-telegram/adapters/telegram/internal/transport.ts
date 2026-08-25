/**
 * Implements Telegram Bot API delivery and media download.
 *
 * @module
 */

import type {
  TelegramConfig,
  TelegramMediaInput,
  TelegramTransport,
} from "../../../internal/contracts.ts";

function required(value: string | undefined, name: string): string {
  const normalized = value?.trim() ?? "";
  if (!normalized) throw new TypeError(`${name} must be non-empty.`);
  return normalized;
}

async function telegramError(response: Response): Promise<Error> {
  const detail = await response.text().catch(() => "");
  return Object.assign(
    new Error(
      `Telegram API ${response.status}: ${detail || response.statusText}`,
    ),
    { name: "TelegramApiError", status: response.status },
  );
}

async function parse(response: Response): Promise<unknown> {
  if (!response.ok) throw await telegramError(response);
  return response.status === 204 ? null : await response.json();
}

function mediaMethod(mediaType: string): Readonly<{
  method: string;
  field: string;
}> {
  if (mediaType.startsWith("image/")) {
    return { method: "sendPhoto", field: "photo" };
  }
  if (mediaType.startsWith("audio/")) {
    return { method: "sendAudio", field: "audio" };
  }
  if (mediaType.startsWith("video/")) {
    return { method: "sendVideo", field: "video" };
  }
  return { method: "sendDocument", field: "document" };
}

function extension(mediaType: string): string {
  return mediaType.split(";")[0].split("/")[1]?.replace(
    /[^a-z0-9.+-]/gi,
    "_",
  ) ||
    "bin";
}

/** Creates a fetch-backed Telegram Bot API transport. */
export function createTelegramTransport(
  options: Readonly<{ fetch?: typeof fetch }> = {},
): TelegramTransport {
  const fetcher = options.fetch ?? globalThis.fetch;
  if (typeof fetcher !== "function") {
    throw new TypeError("Telegram transport requires fetch.");
  }
  const api = (config: TelegramConfig, method: string) =>
    `https://api.telegram.org/bot${
      encodeURIComponent(required(config.botToken, "Telegram botToken"))
    }/${method}`;
  return Object.freeze({
    async call(config, method, body) {
      return await parse(
        await fetcher(api(config, required(method, "Telegram method")), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
      );
    },
    async download(config, fileId) {
      const metadata = await parse(
        await fetcher(api(config, "getFile"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            file_id: required(fileId, "Telegram file ID"),
          }),
        }),
      ) as Record<string, unknown>;
      const result = metadata?.result && typeof metadata.result === "object"
        ? metadata.result as Record<string, unknown>
        : undefined;
      const path = typeof result?.file_path === "string"
        ? result.file_path
        : "";
      if (!path) return null;
      const response = await fetcher(
        `https://api.telegram.org/file/bot${
          encodeURIComponent(required(config.botToken, "Telegram botToken"))
        }/${path}`,
      );
      if (!response.ok) throw await telegramError(response);
      return Object.freeze({
        bytes: new Uint8Array(await response.arrayBuffer()),
        mediaType: response.headers.get("content-type") ||
          "application/octet-stream",
      });
    },
    async sendMedia(config, chatId, media: TelegramMediaInput) {
      const target = mediaMethod(media.mediaType);
      const form = new FormData();
      form.append("chat_id", required(chatId, "Telegram chat ID"));
      form.append(
        target.field,
        new Blob([media.bytes.slice().buffer], { type: media.mediaType }),
        media.name?.trim() || `file.${extension(media.mediaType)}`,
      );
      return await parse(
        await fetcher(api(config, target.method), {
          method: "POST",
          body: form,
        }),
      );
    },
  });
}
