/**
 * Twilio signs each request it makes with the account's auth token, in
 * `X-Twilio-Signature`: the HMAC-SHA1, in base64, of the URL it asked for
 * (its query included), followed by each form field's name and value,
 * sorted by name. A socket's opening request signs its URL alone. Checked
 * with Web Crypto's `verify`, which compares in constant time.
 */

const encoder = new TextEncoder();

/** What's signed: the URL, then the form's fields, sorted by name, each name then its value. */
const signedText = (url: string, form?: URLSearchParams) =>
  url + [...form ?? []]
    .sort(([a, x], [b, y]) => a < b ? -1 : a > b ? 1 : x < y ? -1 : x > y ? 1 : 0)
    .map(([name, value]) => name + value).join("");

const keyFor = (token: string, use: "sign" | "verify") =>
  crypto.subtle.importKey("raw", encoder.encode(token), { name: "HMAC", hash: "SHA-1" }, false, [
    use,
  ]);

/** Whether `header` is Twilio's signature, with `token`, of a request to `url` with `form`. */
export async function signed(
  token: string,
  header: string | null | undefined,
  url: string,
  form?: URLSearchParams,
): Promise<boolean> {
  if (!token || !header || header.length > 100 || !/^[A-Za-z0-9+/]+={0,2}$/.test(header)) {
    return false;
  }
  let given: Uint8Array;
  try {
    given = Uint8Array.from(atob(header), (c) => c.charCodeAt(0));
  } catch {
    return false;
  }
  return await crypto.subtle.verify(
    "HMAC",
    await keyFor(token, "verify"),
    given as BufferSource,
    encoder.encode(signedText(url, form)),
  );
}

/** A request's signature, as Twilio makes it (for tests, and a fake Twilio). */
export async function sign(token: string, url: string, form?: URLSearchParams): Promise<string> {
  const mac = await crypto.subtle.sign(
    "HMAC",
    await keyFor(token, "sign"),
    encoder.encode(signedText(url, form)),
  );
  return btoa(String.fromCharCode(...new Uint8Array(mac)));
}
