import type {
  DiscordConfig,
  DiscordMediaInput,
  DiscordTransport,
} from "./types.ts";

function required(value: string | undefined, name: string): string {
  const normalized = value?.trim() ?? "";
  if (!normalized) throw new TypeError(`${name} must be non-empty.`);
  return normalized;
}

function endpoint(
  config: DiscordConfig,
  interactionToken: string,
  initial: boolean,
): string {
  const base = `/webhooks/${
    encodeURIComponent(required(config.applicationId, "Discord applicationId"))
  }/${
    encodeURIComponent(required(interactionToken, "Discord interaction token"))
  }`;
  return initial ? `${base}/messages/@original` : base;
}

async function discordResult(response: Response): Promise<unknown> {
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw Object.assign(
      new Error(
        `Discord API ${response.status}: ${detail || response.statusText}`,
      ),
      { name: "DiscordApiError", status: response.status },
    );
  }
  return response.status === 204 ? null : await response.json();
}

function headers(config: DiscordConfig): Record<string, string> {
  return config.botToken?.trim()
    ? { Authorization: `Bot ${config.botToken.trim()}` }
    : {};
}

function extension(mediaType: string): string {
  return mediaType.split(";")[0].split("/")[1]?.replace(
    /[^a-z0-9.+-]/gi,
    "_",
  ) ||
    "bin";
}

/** Creates a fetch-backed Discord interactions transport. */
export function createDiscordTransport(
  options: Readonly<{ fetch?: typeof fetch }> = {},
): DiscordTransport {
  const fetcher = options.fetch ?? globalThis.fetch;
  if (typeof fetcher !== "function") {
    throw new TypeError("Discord transport requires fetch.");
  }
  return Object.freeze({
    async download(url) {
      const response = await fetcher(required(url, "Discord attachment URL"));
      if (!response.ok) await discordResult(response);
      return Object.freeze({
        bytes: new Uint8Array(await response.arrayBuffer()),
        mediaType: response.headers.get("content-type") ||
          "application/octet-stream",
      });
    },
    async send(config, interactionToken, body, initial) {
      return await discordResult(
        await fetcher(
          `https://discord.com/api/v10${
            endpoint(config, interactionToken, initial)
          }`,
          {
            method: initial ? "PATCH" : "POST",
            headers: { ...headers(config), "Content-Type": "application/json" },
            body: JSON.stringify(body),
          },
        ),
      );
    },
    async sendMedia(
      config,
      interactionToken,
      media: DiscordMediaInput,
      initial,
    ) {
      const name = media.name?.trim() || `file.${extension(media.mediaType)}`;
      const form = new FormData();
      form.append(
        "payload_json",
        JSON.stringify({
          attachments: [{ id: 0, filename: name }],
        }),
      );
      form.append(
        "files[0]",
        new Blob([media.bytes.slice().buffer], { type: media.mediaType }),
        name,
      );
      return await discordResult(
        await fetcher(
          `https://discord.com/api/v10${
            endpoint(config, interactionToken, initial)
          }`,
          {
            method: initial ? "PATCH" : "POST",
            headers: headers(config),
            body: form,
          },
        ),
      );
    },
  });
}

function hexBytes(value: string): Uint8Array | null {
  if (!value || value.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(value)) {
    return null;
  }
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

/** Verifies Discord's Ed25519 signature over timestamp + exact request bytes. */
export async function verifyDiscordSignature(
  publicKey: string,
  signature: string,
  timestamp: string,
  body: Uint8Array,
): Promise<boolean> {
  try {
    const keyBytes = hexBytes(publicKey);
    const signatureBytes = hexBytes(signature);
    if (!keyBytes || !signatureBytes || !timestamp) return false;
    const key = await crypto.subtle.importKey(
      "raw",
      keyBytes.slice().buffer,
      { name: "Ed25519" },
      false,
      ["verify"],
    );
    const timestampBytes = new TextEncoder().encode(timestamp);
    const message = new Uint8Array(timestampBytes.byteLength + body.byteLength);
    message.set(timestampBytes);
    message.set(body, timestampBytes.byteLength);
    return await crypto.subtle.verify(
      "Ed25519",
      key,
      signatureBytes.slice().buffer,
      message.buffer,
    );
  } catch {
    return false;
  }
}
