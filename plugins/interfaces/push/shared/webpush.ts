/**
 * Web Push on WebCrypto alone (Deno, Node, Bun, workers): a message
 * encrypted for one browser (RFC 8291, `aes128gcm`, RFC 8188) and the app's
 * signature on the request (VAPID, RFC 8292: an ES256 JWT for the push
 * service's origin, and the app's public key).
 */

const encoder = new TextEncoder();

export const b64url = {
  encode(bytes: Uint8Array): string {
    let s = "";
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  },
  decode(text: string): Uint8Array<ArrayBuffer> {
    const s = atob(
      text.replace(/-/g, "+").replace(/_/g, "/").replace(/\s+/g, "") +
        "=".repeat((4 - text.replace(/\s+/g, "").length % 4) % 4),
    );
    return Uint8Array.from(s, (c) => c.charCodeAt(0));
  },
};

const concat = (...parts: Uint8Array[]): Uint8Array<ArrayBuffer> => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) out.set(p, (at += p.length) - p.length);
  return out;
};

async function hmac(key: Uint8Array, data: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  const k = await crypto.subtle.importKey(
    "raw",
    key as Uint8Array<ArrayBuffer>,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, data as Uint8Array<ArrayBuffer>));
}

/** A P-256 private key from its 32-byte scalar and 65-byte public point. */
function jwkOf(publicPoint: Uint8Array, d: Uint8Array): JsonWebKey {
  return {
    kty: "EC",
    crv: "P-256",
    x: b64url.encode(publicPoint.subarray(1, 33)),
    y: b64url.encode(publicPoint.subarray(33, 65)),
    d: b64url.encode(d),
    ext: true,
  };
}

/** The key pair a message is encrypted with: a fresh one each time, unless a test gives it. */
export type Sender = { publicPoint: Uint8Array; privateKey: CryptoKey };

async function freshSender(): Promise<Sender> {
  const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
    "deriveBits",
  ]) as CryptoKeyPair;
  const publicPoint = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  return { publicPoint, privateKey: pair.privateKey };
}

/** A sender from a known pair (base64url), for RFC 8291's example. */
export async function senderOf(publicKey: string, privateKey: string): Promise<Sender> {
  const publicPoint = b64url.decode(publicKey);
  const key = await crypto.subtle.importKey(
    "jwk",
    jwkOf(publicPoint, b64url.decode(privateKey)),
    { name: "ECDH", namedCurve: "P-256" },
    false,
    ["deriveBits"],
  );
  return { publicPoint, privateKey: key };
}

const RECORD = 4096;

/**
 * The body of a push for one browser (`keys` from its subscription): one
 * `aes128gcm` record, its header carrying the salt and the sender's key.
 */
export async function encrypt(
  plaintext: Uint8Array,
  keys: { p256dh: string; auth: string },
  given: { salt?: Uint8Array; sender?: Sender } = {},
): Promise<Uint8Array<ArrayBuffer>> {
  if (plaintext.length > RECORD - 17 - 86) throw new Error("push: the message is too long");
  const uaPublic = b64url.decode(keys.p256dh);
  const auth = b64url.decode(keys.auth);
  const sender = given.sender ?? await freshSender();
  const salt = given.salt ?? crypto.getRandomValues(new Uint8Array(16));
  const ua = await crypto.subtle.importKey(
    "raw",
    uaPublic,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  const ecdh = new Uint8Array(
    await crypto.subtle.deriveBits({ name: "ECDH", public: ua }, sender.privateKey, 256),
  );
  // RFC 8291 §3.4: combine the shared secret with the browser's auth secret.
  const prkKey = await hmac(auth, ecdh);
  const keyInfo = concat(encoder.encode("WebPush: info\0"), uaPublic, sender.publicPoint);
  const ikm = await hmac(prkKey, concat(keyInfo, new Uint8Array([1])));
  // RFC 8188 §2.2: the content key and nonce, from the salt.
  const prk = await hmac(salt, ikm);
  const cek = (await hmac(prk, encoder.encode("Content-Encoding: aes128gcm\0\x01")))
    .slice(0, 16);
  const nonce = (await hmac(prk, encoder.encode("Content-Encoding: nonce\0\x01"))).slice(0, 12);
  const aes = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: nonce },
      aes,
      concat(plaintext, new Uint8Array([2])),
    ),
  );
  const header = new Uint8Array(21);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, RECORD);
  header[20] = sender.publicPoint.length;
  return concat(header, sender.publicPoint, sealed);
}

/**
 * The app's signature on a push (RFC 8292): `vapid t=<JWT>, k=<public key>`,
 * the JWT for the push service's origin, good for 12 hours.
 */
export async function vapid(
  endpoint: string,
  app: { publicKey: string; privateKey: string; contact: string },
  now = Date.now(),
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "jwk",
    jwkOf(b64url.decode(app.publicKey), b64url.decode(app.privateKey)),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  const part = (o: unknown) => b64url.encode(encoder.encode(JSON.stringify(o)));
  const unsigned = `${part({ typ: "JWT", alg: "ES256" })}.${
    part({
      aud: new URL(endpoint).origin,
      exp: Math.floor(now / 1000) + 12 * 3600,
      sub: app.contact,
    })
  }`;
  // WebCrypto's ECDSA signature is r ‖ s, as JWS's ES256 wants it.
  const signature = new Uint8Array(
    await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, encoder.encode(unsigned)),
  );
  return `vapid t=${unsigned}.${b64url.encode(signature)}, k=${app.publicKey}`;
}

/** A new VAPID pair for an app, base64url (the public as its 65-byte point): made once, kept. */
export async function vapidKeys(): Promise<{ publicKey: string; privateKey: string }> {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
  ]) as CryptoKeyPair;
  const point = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  return { publicKey: b64url.encode(point), privateKey: jwk.d! };
}
