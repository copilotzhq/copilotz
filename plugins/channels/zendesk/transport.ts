import type {
  ZendeskConfig,
  ZendeskMediaInput,
  ZendeskTransport,
} from "./types.ts";

function required(value: string | undefined, name: string): string {
  const normalized = value?.trim() ?? "";
  if (!normalized) throw new TypeError(`${name} must be non-empty.`);
  return normalized;
}

function authorization(config: ZendeskConfig): string {
  return `Basic ${
    btoa(
      `${required(config.apiKey, "Zendesk apiKey")}:${
        required(config.apiSecret, "Zendesk apiSecret")
      }`,
    )
  }`;
}

function extension(mediaType: string): string {
  return mediaType.split(";")[0].split("/")[1]?.replace(
    /[^a-z0-9.+-]/gi,
    "_",
  ) ||
    "bin";
}

async function error(response: Response): Promise<Error> {
  const detail = await response.text().catch(() => "");
  return Object.assign(
    new Error(
      `Zendesk API ${response.status}: ${detail || response.statusText}`,
    ),
    { name: "ZendeskApiError", status: response.status },
  );
}

/** Creates the fetch adapter for Zendesk Sunshine Conversations. */
export function createZendeskTransport(
  options: Readonly<{ fetch?: typeof fetch }> = {},
): ZendeskTransport {
  const fetcher = options.fetch ?? globalThis.fetch;
  if (typeof fetcher !== "function") {
    throw new TypeError("Zendesk transport requires fetch.");
  }
  return Object.freeze({
    async download(url) {
      const response = await fetcher(required(url, "Zendesk media URL"));
      if (!response.ok) throw await error(response);
      return Object.freeze({
        bytes: new Uint8Array(await response.arrayBuffer()),
        mediaType: response.headers.get("content-type") ||
          "application/octet-stream",
      });
    },
    async upload(config, conversationId, media: ZendeskMediaInput) {
      const form = new FormData();
      const mediaType = required(media.mediaType, "Zendesk mediaType");
      form.append(
        "source",
        new Blob([media.bytes.slice().buffer], { type: mediaType }),
        media.name?.trim() || `file.${extension(mediaType)}`,
      );
      const appId = encodeURIComponent(required(config.appId, "Zendesk appId"));
      const thread = encodeURIComponent(
        required(conversationId, "Zendesk conversation ID"),
      );
      const response = await fetcher(
        `https://api.smooch.io/v2/apps/${appId}/attachments?access=public&for=message&conversationId=${thread}`,
        {
          method: "POST",
          headers: { Authorization: authorization(config) },
          body: form,
        },
      );
      if (!response.ok) throw await error(response);
      const payload = await response.json() as Record<string, unknown>;
      const attachment = payload.attachment &&
          typeof payload.attachment === "object"
        ? payload.attachment as Record<string, unknown>
        : undefined;
      const mediaUrl = typeof attachment?.mediaUrl === "string"
        ? attachment.mediaUrl
        : "";
      if (!mediaUrl) throw new Error("Zendesk upload returned no media URL.");
      return Object.freeze({ mediaUrl, mediaType });
    },
    async send(config, conversationId, body) {
      const appId = encodeURIComponent(required(config.appId, "Zendesk appId"));
      const thread = encodeURIComponent(
        required(conversationId, "Zendesk conversation ID"),
      );
      const response = await fetcher(
        `https://api.smooch.io/v2/apps/${appId}/conversations/${thread}/messages`,
        {
          method: "POST",
          headers: {
            Authorization: authorization(config),
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
        },
      );
      if (!response.ok) throw await error(response);
      return response.status === 204 ? null : await response.json();
    },
  });
}
