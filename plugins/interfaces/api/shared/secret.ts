/** Keys' secrets: made at random, kept as their SHA-256. */

/** What a key's secret starts with, so it's known for what it is (in a leak scanner, too). */
export const PREFIX = "cpz_";

/** A new secret: 32 random bytes, base64url, after the prefix. */
export const secret = (): string =>
  PREFIX + btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
    .replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");

/** A secret as it's kept: its SHA-256, hex. */
export async function hash(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
