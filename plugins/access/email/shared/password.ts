/**
 * Passwords at rest: PBKDF2-HMAC-SHA256 on WebCrypto, so the same code runs on
 * Deno, Node, Bun and workerd. Two formats are read:
 *
 * - **Legacy** (`"<saltHex>:<hashHex>"`): a 16-byte salt and a 32-byte hash
 *   in lowercase hex, 100,000 iterations, the password as raw UTF-8. What
 *   apps on Copilotz 0.x kept (an app moving from 0.x brings its people's as they are).
 * - **Ours** (`pbkdf2-sha256$<stages>x<iterations>$<salt>$<hash>`, base64url):
 *   PBKDF2 in stages, each salted with the salt and the stage before it
 *   (`K1 = PBKDF2(P, salt, n)`, `Ki = PBKDF2(P, salt ‖ Ki-1, n)`), the last
 *   one kept. One stage is plain PBKDF2. Stages, because Cloudflare's workerd
 *   refuses more than 100,000 iterations in one call: six of them cost what
 *   600,000 do (OWASP's figure for PBKDF2-SHA256), wherever it runs.
 *
 * A hash weaker than what's made now (`STAGES` × `ITERATIONS`) is made again
 * the next time its person signs in (`stale`). Comparisons take as long
 * whatever the first difference.
 */

/** Stages of PBKDF2 a new hash goes through, and the iterations in each (workerd's most). */
export const STAGES = 6;
export const ITERATIONS = 100_000;

const encoder = new TextEncoder();
const LEGACY = /^([0-9a-f]{32}):([0-9a-f]{64})$/i;
const OURS =
  /^pbkdf2-sha256\$([1-9]\d{0,2})x([1-9]\d{0,6})\$([A-Za-z0-9_-]{16,})\$([A-Za-z0-9_-]{43})$/;

const hex = (text: string) => Uint8Array.from(text.match(/../g)!, (b) => parseInt(b, 16));
const base64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unbase64url = (text: string) =>
  Uint8Array.from(atob(text.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

/** One PBKDF2-HMAC-SHA256 of 32 bytes. */
async function pbkdf2(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, [
    "deriveBits",
  ]);
  return new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "PBKDF2", salt: salt as BufferSource, iterations, hash: "SHA-256" },
      key,
      256,
    ),
  );
}

/** PBKDF2 in stages (see above): each salted with the salt and the stage before it. */
async function staged(
  password: string,
  salt: Uint8Array,
  stages: number,
  iterations: number,
): Promise<Uint8Array> {
  let kept = await pbkdf2(password, salt, iterations);
  for (let stage = 1; stage < stages; stage++) {
    const salted = new Uint8Array(salt.length + kept.length);
    salted.set(salt);
    salted.set(kept, salt.length);
    kept = await pbkdf2(password, salted, iterations);
  }
  return kept;
}

/** Whether two byte strings are the same, taking as long whatever their first difference. */
export function same(a: Uint8Array, b: Uint8Array): boolean {
  let differ = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) differ |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return differ === 0;
}

/** A new hash of a password, in our format. */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await staged(password, salt, STAGES, ITERATIONS);
  return `pbkdf2-sha256$${STAGES}x${ITERATIONS}$${base64url(salt)}$${base64url(hash)}`;
}

/** Whether a stored hash is one this plugin reads: legacy, or ours. */
export const readable = (stored: string): boolean => LEGACY.test(stored) || OURS.test(stored);

/** Whether a password is the one a stored hash was made from (false for one it can't read). */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const legacy = LEGACY.exec(stored);
  if (legacy) return same(await pbkdf2(password, hex(legacy[1]), 100_000), hex(legacy[2]));
  const ours = OURS.exec(stored);
  if (!ours) return false;
  const [, stages, iterations, salt, hash] = ours;
  const made = await staged(password, unbase64url(salt), Number(stages), Number(iterations));
  return same(made, unbase64url(hash));
}

/** Whether a stored hash is weaker than a new one: made again at the next sign-in. */
export function stale(stored: string): boolean {
  const ours = OURS.exec(stored);
  return !ours || Number(ours[1]) * Number(ours[2]) < STAGES * ITERATIONS;
}

/**
 * Takes as long as checking a password does, for someone with none: a sign-in
 * for an address nobody has says nothing by how quickly it's refused.
 */
export async function noPassword(password: string): Promise<false> {
  await staged(password, new Uint8Array(16), STAGES, ITERATIONS);
  return false;
}
