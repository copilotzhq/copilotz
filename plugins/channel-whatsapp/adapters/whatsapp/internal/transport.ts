import type {
  WhatsAppConfig,
  WhatsAppMediaInput,
  WhatsAppTransport,
  WhatsAppUploadedMedia,
} from "../../../internal/contracts.ts";

function required(value: string | undefined, name: string): string {
  const normalized = value?.trim() ?? "";
  if (!normalized) throw new TypeError(`${name} must be non-empty.`);
  return normalized;
}

function version(config: WhatsAppConfig): string {
  return config.graphApiVersion?.trim() || "v25.0";
}

function graphUrl(config: WhatsAppConfig, path: string): string {
  return `https://graph.facebook.com/${version(config)}/${path}`;
}

async function responsePayload(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function graphError(response: Response, payload: unknown): Error {
  const record = payload && typeof payload === "object"
    ? payload as Record<string, unknown>
    : undefined;
  const nested = record?.error && typeof record.error === "object"
    ? record.error as Record<string, unknown>
    : undefined;
  const detail = typeof nested?.message === "string"
    ? nested.message
    : typeof payload === "string"
    ? payload
    : response.statusText;
  return Object.assign(
    new Error(`WhatsApp Graph API ${response.status}: ${detail}`),
    { name: "WhatsAppGraphError", status: response.status },
  );
}

function mediaType(value: string): WhatsAppUploadedMedia["type"] {
  const normalized = value.toLowerCase();
  if (normalized.startsWith("image/")) return "image";
  if (normalized.startsWith("video/")) return "video";
  if (normalized.startsWith("audio/")) return "audio";
  return "document";
}

function extension(value: string): string {
  const subtype = value.split(";")[0].split("/")[1]?.toLowerCase() || "bin";
  return subtype.replace(/[^a-z0-9.+-]/g, "_");
}

/** Creates a fetch-backed Meta Graph transport without reading global config. */
export function createWhatsAppGraphTransport(
  options: Readonly<{ fetch?: typeof fetch }> = {},
): WhatsAppTransport {
  const fetcher = options.fetch ?? globalThis.fetch;
  if (typeof fetcher !== "function") {
    throw new TypeError("WhatsApp Graph transport requires fetch.");
  }
  const authorization = (config: WhatsAppConfig) => ({
    Authorization: `Bearer ${
      required(config.accessToken, "WhatsApp accessToken")
    }`,
  });
  return Object.freeze({
    async download(config, input) {
      const id = required(input.id, "WhatsApp media ID");
      const metadataResponse = await fetcher(
        graphUrl(config, encodeURIComponent(id)),
        { headers: authorization(config) },
      );
      const metadata = await responsePayload(metadataResponse);
      if (!metadataResponse.ok) throw graphError(metadataResponse, metadata);
      const record = metadata && typeof metadata === "object"
        ? metadata as Record<string, unknown>
        : undefined;
      const url = typeof record?.url === "string" ? record.url : "";
      if (!url) return null;
      const bodyResponse = await fetcher(url, {
        headers: authorization(config),
      });
      if (!bodyResponse.ok) {
        throw graphError(bodyResponse, await responsePayload(bodyResponse));
      }
      const resolvedMediaType = input.mediaType?.trim() ||
        (typeof record?.mime_type === "string" ? record.mime_type : "") ||
        bodyResponse.headers.get("content-type") ||
        "application/octet-stream";
      return Object.freeze({
        bytes: new Uint8Array(await bodyResponse.arrayBuffer()),
        mediaType: resolvedMediaType,
        ...(input.name?.trim() ? { name: input.name.trim() } : {}),
      });
    },
    async upload(config, input: WhatsAppMediaInput) {
      if (
        !(input.bytes instanceof Uint8Array) || input.bytes.byteLength === 0
      ) {
        throw new TypeError("WhatsApp media upload requires bytes.");
      }
      const resolvedType = required(input.mediaType, "WhatsApp mediaType");
      const form = new FormData();
      form.append("messaging_product", "whatsapp");
      form.append("type", resolvedType);
      const copy = input.bytes.slice().buffer;
      form.append(
        "file",
        new Blob([copy], { type: resolvedType }),
        input.name?.trim() || `file.${extension(resolvedType)}`,
      );
      const response = await fetcher(
        `${
          graphUrl(
            config,
            `${
              encodeURIComponent(required(config.phoneId, "WhatsApp phoneId"))
            }/media`,
          )
        }?messaging_product=whatsapp`,
        { method: "POST", headers: authorization(config), body: form },
      );
      const payload = await responsePayload(response);
      if (!response.ok) throw graphError(response, payload);
      const id = payload && typeof payload === "object" &&
          typeof (payload as Record<string, unknown>).id === "string"
        ? (payload as Record<string, string>).id
        : "";
      if (!id) throw new Error("WhatsApp media upload returned no media ID.");
      return Object.freeze({ id, type: mediaType(resolvedType) });
    },
    async send(config, body) {
      const response = await fetcher(
        graphUrl(
          config,
          `${
            encodeURIComponent(required(config.phoneId, "WhatsApp phoneId"))
          }/messages`,
        ),
        {
          method: "POST",
          headers: {
            ...authorization(config),
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
        },
      );
      const payload = await responsePayload(response);
      if (!response.ok) throw graphError(response, payload);
      return payload;
    },
  });
}

function fromHex(value: string): Uint8Array | null {
  if (!value || value.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(value)) {
    return null;
  }
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < left.byteLength; index += 1) {
    difference |= left[index] ^ right[index];
  }
  return difference === 0;
}

/** Verifies Meta's `sha256=<hex>` signature using Web Crypto. */
export async function verifyWhatsAppSignature(
  body: Uint8Array,
  secret: string,
  signature: string,
): Promise<boolean> {
  const supplied = signature.toLowerCase().startsWith("sha256=")
    ? fromHex(signature.slice(7))
    : null;
  if (!supplied || !secret) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const expected = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, body.slice().buffer),
  );
  return equalBytes(expected, supplied);
}

export function whatsappHeader(
  headers: Readonly<Record<string, string>>,
  name: string,
): string | undefined {
  const normalized = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === normalized) return value;
  }
  return undefined;
}
/**
 * Implements WhatsApp Graph API transport and signature verification.
 *
 * @module
 */
