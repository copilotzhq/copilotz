import { getChannelContext } from "@/runtime/thread-metadata.ts";

export interface DiscordConfig {
  applicationId: string;
  publicKey: string;
  botToken: string;
}

export function resolveDiscordConfig(
  config?: Partial<DiscordConfig>,
  context?: Record<string, unknown>,
): DiscordConfig {
  const resolved = {
    applicationId: config?.applicationId ||
      (context?.DISCORD_APPLICATION_ID as string) ||
      Deno.env.get("DISCORD_APPLICATION_ID") || "",
    publicKey: config?.publicKey ||
      (context?.DISCORD_PUBLIC_KEY as string) ||
      Deno.env.get("DISCORD_PUBLIC_KEY") || "",
    botToken: config?.botToken ||
      (context?.DISCORD_BOT_TOKEN as string) ||
      Deno.env.get("DISCORD_BOT_TOKEN") || "",
  };

  if (!resolved.publicKey) {
    throw new Error("Discord public key is required for webhook verification");
  }

  return resolved;
}

/**
 * Verify Discord Ed25519 signature
 */
export async function verifyDiscordSignature(
  publicKey: string,
  signature: string,
  timestamp: string,
  body: Uint8Array,
): Promise<boolean> {
  try {
    const publicKeyBytes = hexToUint8Array(publicKey);
    const signatureBytes = hexToUint8Array(signature);

    const key = await crypto.subtle.importKey(
      "raw",
      toArrayBuffer(publicKeyBytes),
      { name: "Ed25519", namedCurve: "Ed25519" },
      false,
      ["verify"],
    );

    const data = new TextEncoder().encode(timestamp + new TextDecoder().decode(body));
    
    return await crypto.subtle.verify(
      "Ed25519",
      key,
      toArrayBuffer(signatureBytes),
      data,
    );
  } catch {
    return false;
  }
}

function hexToUint8Array(hex: string): Uint8Array {
  const matches = hex.match(/.{1,2}/g);
  if (!matches) return new Uint8Array();
  return new Uint8Array(matches.map((byte) => parseInt(byte, 16)));
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const ab = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(ab).set(bytes);
  return ab;
}

export async function callDiscordAPI(
  config: DiscordConfig,
  endpoint: string,
  options: RequestInit = {},
) {
  const url = `https://discord.com/api/v10${endpoint}`;
  const headers: Record<string, string> = {
    "Authorization": `Bot ${config.botToken}`,
    ...options.headers,
  };

  // Only set Content-Type if it's not a FormData object (which sets its own boundary)
  if (!(options.body instanceof FormData) && !headers["Content-Type"]) {
    headers["Content-Type"] = "application/json";
  }

  const response = await fetch(url, {
    ...options,
    headers,
  });

  if (!response.ok) {
    const error = await response.text();
    console.error(`Discord API error [${response.status}]: ${error}`);
    return null;
  }

  if (response.status === 204) return true;
  return response.json();
}

export interface DiscordInteractionContext {
  interactionId: string;
  interactionToken: string;
  channelId: string;
  guildId?: string;
  userId: string;
  userName: string;
}

export function getDiscordContext(metadata: unknown): DiscordInteractionContext | null {
  return getChannelContext(metadata, "discord") as unknown as DiscordInteractionContext | null;
}
