/**
 * Tokens at rest. They're always a private field (no actor's read, no View
 * and no event ever holds them). With the app's `accounts.key`, they're also
 * sealed: AES-GCM under a key stretched from it (HKDF), the account's id
 * bound in, so a copy of the database holds nothing usable and a sealed
 * value can't be moved to another account. Without a key, they're kept as
 * they are; with one, those kept before it are sealed the next time they're
 * written.
 */
import { base64url, fromBase64url } from "./oauth.ts";
import { unavailable } from "./errors.ts";

/** What an account holds that nobody but its plugin's Actions reads. */
export type Tokens = {
  access: string;
  refresh?: string;
  /** The account's id at its provider (ChatGPT's account id), for its headers. */
  account: string;
};

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
      info: encoder.encode("copilotz accounts v1"),
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

/** Tokens as they're kept: sealed (`v1.<iv>.<sealed>`) with a key, as they are without. */
export async function seal(
  secret: string | undefined,
  account: string,
  tokens: Tokens,
): Promise<Tokens | string> {
  if (!secret) return tokens;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: encoder.encode(account) },
    await keyOf(secret),
    encoder.encode(JSON.stringify(tokens)),
  );
  return `v1.${base64url(iv)}.${base64url(new Uint8Array(sealed))}`;
}

/** Tokens as kept, opened; `account_unavailable` when they can't be here (no key, another key). */
export async function unseal(
  secret: string | undefined,
  account: string,
  kept: unknown,
): Promise<Tokens> {
  if (kept && typeof kept === "object") return kept as Tokens;
  const [version, iv, sealed] = typeof kept === "string" ? kept.split(".") : [];
  if (version !== "v1" || !iv || !sealed) throw unavailable("This account holds no tokens");
  if (!secret) {
    throw unavailable("This account's tokens are sealed, and the app has no key for them");
  }
  try {
    const opened = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromBase64url(iv), additionalData: encoder.encode(account) },
      await keyOf(secret),
      fromBase64url(sealed),
    );
    return JSON.parse(new TextDecoder().decode(opened)) as Tokens;
  } catch {
    throw unavailable("This account's tokens can't be opened with the app's key");
  }
}
