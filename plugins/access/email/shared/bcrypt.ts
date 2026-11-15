/**
 * bcrypt, for passwords another app kept with it (`$2a$`, `$2b$`, `$2y$`:
 * Rails, PHP's `password_hash`, Parse, Laravel): read only, so they verify
 * once and are hashed again our way at the first sign-in. WebCrypto has no
 * Blowfish, so it's here, in TypeScript, as OpenBSD's eksblowfish works:
 *
 * - The password as UTF-8 with a NUL after it, its first 72 bytes, is the key
 *   (`$2a$`, `$2b$` and `$2y$` are the same for every password shorter than
 *   255 bytes: the variants fixed bugs elsewhere).
 * - Blowfish's state from pi's digits (pi.ts) is set up with the key and the
 *   16-byte salt, then with each of them alone, 2^cost times.
 * - "OrpheanBeholderScryDoubt" is encrypted 64 times; 23 of its 24 bytes,
 *   in bcrypt's own base64, end the hash.
 *
 * It's work on the CPU, about 0.1 s at cost 10: it gives the event loop a
 * turn every few milliseconds. Costs past 15 aren't read: one would hold a
 * sign-in for seconds.
 */
import { PI_HEX } from "./pi.ts";

/** A bcrypt hash: its variant, cost, salt (22 characters) and hash (31). */
export const BCRYPT = /^\$2[aby]\$(0[4-9]|1[0-5])\$[./A-Za-z0-9]{53}$/;

const ALPHABET = "./ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const INDEX = new Map([...ALPHABET].map((c, i) => [c, i]));
/** "OrpheanBeholderScryDoubt", as six big-endian words. */
const MAGIC = [0x4f727068, 0x65616e42, 0x65686f6c, 0x64657253, 0x63727944, 0x6f756274];
/** How long the work runs before giving the event loop a turn (ms). */
const SLICE = 8;

let pi: Uint32Array | undefined;
/** The 1,042 words Blowfish starts from: the P-array's 18, then the S-boxes'. */
const start = () =>
  pi ??= Uint32Array.from({ length: 1042 }, (_, i) => parseInt(PI_HEX.slice(i * 8, i * 8 + 8), 16));

/** `bytes` in bcrypt's base64 (its own alphabet, no padding). */
function encode(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const [a, b = 0, c = 0] = [bytes[i], bytes[i + 1], bytes[i + 2]];
    out += ALPHABET[a >> 2] + ALPHABET[((a & 3) << 4) | (b >> 4)];
    if (i + 1 < bytes.length) out += ALPHABET[((b & 15) << 2) | (c >> 6)];
    if (i + 2 < bytes.length) out += ALPHABET[c & 63];
  }
  return out;
}

/** The first `length` bytes `text` (bcrypt's base64) holds. */
function decode(text: string, length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  const at = (i: number) => INDEX.get(text[i]) ?? 0;
  for (let i = 0, j = 0; j < length; i += 4) {
    const [a, b, c, d] = [at(i), at(i + 1), at(i + 2), at(i + 3)];
    bytes[j++] = (a << 2) | (b >> 4);
    if (j < length) bytes[j++] = ((b & 15) << 4) | (c >> 2);
    if (j < length) bytes[j++] = ((c & 3) << 6) | d;
  }
  return bytes;
}

/** Blowfish's state: the P-array's 18 words, the S-boxes' 1,024, and a block being worked. */
type State = { p: Uint32Array; s: Uint32Array; block: Uint32Array };

/** Encrypts `block[at]`, `block[at + 1]` in place. */
function encipher({ p, s, block }: State, at: number) {
  const f = (x: number) =>
    (((s[x >>> 24] + s[256 | ((x >>> 16) & 255)]) ^ s[512 | ((x >>> 8) & 255)]) +
      s[768 | (x & 255)]) >>> 0;
  let l = (block[at] ^ p[0]) >>> 0;
  let r = block[at + 1];
  for (let i = 1; i <= 16; i += 2) {
    r = (r ^ f(l) ^ p[i]) >>> 0;
    l = (l ^ f(r) ^ p[i + 1]) >>> 0;
  }
  block[at] = (r ^ p[17]) >>> 0;
  block[at + 1] = l;
}

/** The next 32 bits of `bytes`, big-endian, going round to its start (its place in `at[0]`). */
function word(bytes: Uint8Array, at: number[]): number {
  let w = 0;
  for (let i = 0; i < 4; i++) {
    w = (w << 8) | bytes[at[0]];
    at[0] = (at[0] + 1) % bytes.length;
  }
  return w >>> 0;
}

/** Blowfish's key schedule over `key`, with `salt` mixed into each block when given. */
function expand(state: State, key: Uint8Array, salt?: Uint8Array) {
  const { p, s, block } = state;
  const k = [0];
  for (let i = 0; i < 18; i++) p[i] = (p[i] ^ word(key, k)) >>> 0;
  const x = [0];
  block[0] = 0;
  block[1] = 0;
  for (let i = 0; i < 1042; i += 2) {
    if (salt) {
      block[0] = (block[0] ^ word(salt, x)) >>> 0;
      block[1] = (block[1] ^ word(salt, x)) >>> 0;
    }
    encipher(state, 0);
    const [into, at] = i < 18 ? [p, i] : [s, i - 18];
    into[at] = block[0];
    into[at + 1] = block[1];
  }
}

/** A turn for the event loop. */
const breathe = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/**
 * The bcrypt hash of `password` under a stored hash's setting (its first 29
 * characters: `$2b$10$` and the salt): the whole hash, to compare.
 */
export async function bcrypt(password: string, setting: string): Promise<string> {
  const cost = Number(setting.slice(4, 6));
  const salt = decode(setting.slice(7, 29), 16);
  const typed = new TextEncoder().encode(password);
  const key = new Uint8Array(Math.min(typed.length + 1, 72));
  key.set(typed.subarray(0, key.length));
  const all = start();
  const state: State = {
    p: all.slice(0, 18),
    s: all.slice(18),
    block: new Uint32Array(6),
  };
  expand(state, key, salt);
  let since = performance.now();
  for (let round = 0; round < 2 ** cost; round++) {
    expand(state, key);
    expand(state, salt);
    if (performance.now() - since > SLICE) {
      await breathe();
      since = performance.now();
    }
  }
  const block = state.block;
  block.set(MAGIC);
  for (let i = 0; i < 64; i++) for (let at = 0; at < 6; at += 2) encipher(state, at);
  const out = new Uint8Array(24);
  const view = new DataView(out.buffer);
  for (let i = 0; i < 6; i++) view.setUint32(i * 4, block[i]);
  return setting.slice(0, 29) + encode(out.subarray(0, 23));
}
