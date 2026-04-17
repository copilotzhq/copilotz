import { splitString } from "@/server/channels.ts";
import { parseDataUrl } from "@/runtime/storage/assets.ts";

export type WhatsAppConfig = {
  accessToken: string;
  phoneId: string;
  appSecret: string;
  webhookVerifyToken: string;
  graphApiVersion?: string;
};

export type WhatsAppWebhookEntry = {
  id: string;
  changes?: Array<{
    value: {
      messages?: Array<WhatsAppMessage>;
      metadata?: { phone_number_id?: string };
      contacts?: Array<{ profile?: { name?: string } }>;
    };
  }>;
};

export type WhatsAppMessage = {
  from: string;
  id: string;
  timestamp: string;
  type: string;
  text?: { body: string };
  audio?: { id: string; mime_type?: string };
  video?: { id: string; mime_type?: string };
  document?: { id: string; mime_type?: string; filename?: string };
};

export type WhatsAppWebhookPayload = {
  entry?: WhatsAppWebhookEntry[];
};

export function resolveWhatsAppConfig(
  config?: Partial<WhatsAppConfig>,
): WhatsAppConfig {
  return {
    accessToken: config?.accessToken || Deno.env.get("WHATSAPP_ACCESS_TOKEN") ||
      "",
    phoneId: config?.phoneId || Deno.env.get("WHATSAPP_PHONE_ID") || "",
    appSecret: config?.appSecret || Deno.env.get("WHATSAPP_APP_SECRET") || "",
    webhookVerifyToken: config?.webhookVerifyToken ||
      Deno.env.get("WHATSAPP_WEBHOOK_VERIFY_TOKEN") || "",
    graphApiVersion: config?.graphApiVersion || "v19.0",
  };
}

export function getWhatsAppHeaderValue(
  headers: Record<string, string>,
  key: string,
): string | undefined {
  const lowerKey = key.toLowerCase();
  const match = Object.entries(headers).find(([name]) =>
    name.toLowerCase() === lowerKey
  );
  return match?.[1];
}

export async function sendWhatsAppText(
  config: WhatsAppConfig,
  to: string,
  text: string,
): Promise<void> {
  const chunks = splitString(text, 1500, ["\n", ".", ";"]);
  for (const chunk of chunks) {
    if (!chunk) continue;
    await callWhatsAppGraphAPI(config, {
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body: chunk },
    });
  }
}

function whatsappMediaType(mimeType: string): string {
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("video/")) return "video";
  if (mimeType.startsWith("audio/")) return "audio";
  return "document";
}

export async function uploadWhatsAppMedia(
  config: WhatsAppConfig,
  dataUrl: string,
): Promise<{ id: string; type: string } | null> {
  const parsed = parseDataUrl(dataUrl);
  if (!parsed) return null;

  const { bytes, mime: mimeType } = parsed;
  const mediaType = whatsappMediaType(mimeType);
  const formData = new FormData();
  const blob = new Blob([bytes.buffer as ArrayBuffer], { type: mimeType });
  formData.append("file", blob, `file.${mimeType.split("/")[1]}`);
  formData.append("type", mimeType);
  formData.append("messaging_product", "whatsapp");

  try {
    const res = await fetch(
      `https://graph.facebook.com/${config.graphApiVersion}/${config.phoneId}/media?access_token=${config.accessToken}`,
      { method: "POST", body: formData },
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    return { id: json?.id, type: mediaType };
  } catch (err) {
    console.error("[whatsapp] media upload error:", err);
    return null;
  }
}

export async function callWhatsAppGraphAPI(
  config: WhatsAppConfig,
  body: Record<string, unknown>,
): Promise<unknown> {
  try {
    const res = await fetch(
      `https://graph.facebook.com/${config.graphApiVersion}/${config.phoneId}/messages?access_token=${config.accessToken}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    console.error("[whatsapp] send error:", err);
    return null;
  }
}

export async function downloadWhatsAppMedia(
  message: WhatsAppMessage,
  type: "audio" | "video" | "document",
  config: WhatsAppConfig,
): Promise<Blob | undefined> {
  const ref = message[type];
  if (!ref) return undefined;

  try {
    const metaRes = await fetch(
      `https://graph.facebook.com/${config.graphApiVersion}/${ref.id}/`,
      { headers: { Authorization: `Bearer ${config.accessToken}` } },
    );
    const meta = await metaRes.json();
    if (!meta?.url) return undefined;

    const contentRes = await fetch(meta.url, {
      headers: { Authorization: `Bearer ${config.accessToken}` },
    });
    return await contentRes.blob();
  } catch (err) {
    console.error(`[whatsapp] ${type} download error:`, err);
    return undefined;
  }
}
