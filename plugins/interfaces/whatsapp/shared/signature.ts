/**
 * Meta signs each webhook delivery with the app's secret: the body's
 * HMAC-SHA256, in `X-Hub-Signature-256: sha256=<hex>`. Checked with Web
 * Crypto's `verify`, which compares in constant time.
 */

const hexBytes = (hex: string) =>
  new Uint8Array(hex.match(/../g)!.map((pair) => parseInt(pair, 16)));

/** Whether `header` is `body`'s signature with `secret`. */
export async function signed(
  secret: string,
  body: Uint8Array,
  header: string | undefined,
): Promise<boolean> {
  const given = /^sha256=([0-9a-fA-F]{64})$/.exec(header ?? "")?.[1];
  if (!given || !secret) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  return await crypto.subtle.verify(
    "HMAC",
    key,
    hexBytes(given.toLowerCase()),
    body as BufferSource,
  );
}

/** A body's signature, as Meta sends it (for tests, and a fake Graph API). */
export async function sign(secret: string, body: Uint8Array): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, body as BufferSource));
  return `sha256=${[...mac].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/** Whether two strings are the same, in time that doesn't say where they differ (verify tokens). */
export function same(a: string, b: string): boolean {
  const [x, y] = [new TextEncoder().encode(a), new TextEncoder().encode(b)];
  let differ = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) differ |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return differ === 0;
}
