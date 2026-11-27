/** The app's push settings, as the plugins' resources merge them. */
import type { Context } from "../../../../runtime/mod.ts";
import type { PushSettings } from "../contract.ts";

export const settingsOf = (ctx: { resources: Context["resources"] }): PushSettings =>
  (ctx.resources.push as PushSettings | undefined) ?? {};

/** The public key the browser subscribes with, when the app has a pair. */
export const publicKeyOf = (ctx: { resources: Context["resources"] }): string | undefined => {
  const { publicKey, privateKey } = settingsOf(ctx);
  return publicKey && privateKey ? publicKey : undefined;
};

/** A subscription's id: from its endpoint, so the same browser subscribing again is one device. */
export async function subscriptionId(endpoint: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(endpoint));
  return [...new Uint8Array(digest).subarray(0, 16)]
    .map((b) => b.toString(16).padStart(2, "0")).join("");
}
