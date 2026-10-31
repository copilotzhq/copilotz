/**
 * Secrets at rest (a space's environment): sealed with the `computers`
 * resource's `key` (any long secret, from the app's own secrets), AES-GCM
 * under a key stretched from it (HKDF), the variable's id bound in, so a
 * copy of the database holds nothing usable and a sealed value can't be
 * moved to another variable. Without a key, a secret is kept as it is (in a
 * private field all the same); with one, it's sealed the next time it's
 * written.
 */
const encoder = new TextEncoder();
const keys = new Map<string, Promise<CryptoKey>>();

async function derive(secret: string): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", encoder.encode(secret), "HKDF", false, [
    "deriveKey",
  ]);
  return await crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new Uint8Array(32),
      info: encoder.encode("copilotz environment v1"),
    },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

const keyOf = (secret: string) => {
  if (!keys.has(secret)) keys.set(secret, derive(secret));
  return keys.get(secret)!;
};

const base64url = (bytes: Uint8Array) => {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
};
const fromBase64url = (text: string) =>
  Uint8Array.from(atob(text.replaceAll("-", "+").replaceAll("_", "/")), (c) => c.charCodeAt(0));

/** A secret as it's kept: sealed (`v1.<iv>.<sealed>`) with a key, as it is (`plain.<it>`) without. */
export async function seal(key: string | undefined, id: string, value: string): Promise<string> {
  if (!key) return `plain.${value}`;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: encoder.encode(id) },
    await keyOf(key),
    encoder.encode(value),
  );
  return `v1.${base64url(iv)}.${base64url(new Uint8Array(sealed))}`;
}

/** A secret as kept, opened; it fails, saying why, when it can't be here (no key, another key). */
export async function unseal(key: string | undefined, id: string, kept: string): Promise<string> {
  if (kept.startsWith("plain.")) return kept.slice("plain.".length);
  const [version, iv, sealed] = kept.split(".");
  const unavailable = (message: string) =>
    Object.assign(new Error(message), { code: "unavailable" });
  if (version !== "v1" || !iv || !sealed) throw unavailable("This secret holds no value");
  if (!key) throw unavailable("This secret is sealed, and the app has no key for it");
  try {
    const opened = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromBase64url(iv), additionalData: encoder.encode(id) },
      await keyOf(key),
      fromBase64url(sealed),
    );
    return new TextDecoder().decode(opened);
  } catch {
    throw unavailable("This secret can't be opened with the app's key");
  }
}
