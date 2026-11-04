/**
 * A visitor's secret: what their browser keeps (in an httpOnly cookie the
 * web host sets) and shows to be them. 32 random bytes, base64url; only its
 * hash is kept, so nothing stored is enough to be anyone.
 */

/** A new secret. */
export function newSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return `vis_${
    btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")
  }`;
}

/** A secret as it's kept: its SHA-256, hex. */
export async function hashOf(secret: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
