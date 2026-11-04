/**
 * Links that carry their own permission: a path on the app, its params and
 * when it expires, signed with the app's secret (HMAC-SHA256, Web Crypto).
 * Whoever holds one may open it until then; changing anything in it breaks
 * it. What signs one is trusted code that could read what it opens (a file
 * it sends, a picture a route draws): the signature is the permission.
 *
 * The app sets where it is and the secret in the `links` resource, from its
 * settings at start: `resources: { links: { origin: "https://app.example",
 * secret: env.LINK_SECRET } }` (at least 32 bytes). Without them, nothing is
 * signed. The origin is signed too, so a link made for one app never opens
 * another, whatever their secrets. An app serving many orgs (`hosts/orgs`)
 * gives each org's runtime its own origin (`https://app.example/o/acme`):
 * with one origin for all, an org's links would open another's files.
 *
 * Nothing is signed with the secret itself: each use has a key of its own,
 * derived from it (`keyOf`, HKDF): links one, web visitors' cookies another,
 * so what one signs the other never takes. To change the secret, give the
 * one before it as `previous` for a while: what it signed still opens (a
 * link until it expires, a visitor's cookie while it lasts), and only the new
 * one signs. That's for a secret changed on schedule: one that leaked is
 * never given as `previous` (whoever holds it could sign anything the app
 * takes while it's there). It goes at once, and what it signed with it.
 */
import type { Resources } from "./define.ts";
import { invalid } from "./errors.ts";

/**
 * The `links` resource: the app's public origin (https), the secret links
 * are signed with, and the one before it (`previous`), while what it signed
 * should still open: never a secret that leaked.
 */
export type LinksSettings = { origin: string; secret: string; previous?: string };

/** How long a link opens, unless said: an hour (Meta fetches what it's sent at once). */
const HOUR = 3_600_000;
/** The shortest secret links are signed with, in bytes. */
const SECRET = 32;
const encoder = new TextEncoder();

/** The app's links settings, when it has both; a secret too short to sign with is refused. */
export function linksOf(resources: Resources): LinksSettings | undefined {
  const set = resources.links as Partial<LinksSettings> | undefined;
  if (!set?.origin || !set.secret) return undefined;
  for (const name of ["secret", "previous"] as const) {
    const secret = set[name];
    if (secret === undefined || (name === "previous" && !secret)) continue;
    if (typeof secret !== "string" || encoder.encode(secret).length < SECRET) {
      throw invalid(`links.${name} is at least ${SECRET} bytes: make a longer one.`);
    }
  }
  return {
    origin: set.origin.replace(/\/+$/, ""),
    secret: set.secret,
    ...(set.previous ? { previous: set.previous } : {}),
  };
}

/** Each use's key, by its secret: derived once. */
const derived = new Map<string, Promise<CryptoKey>>();

/**
 * The key for one use of the app's secret (`use`: "links", "visitors"), an
 * HMAC-SHA256 key derived from it with HKDF-SHA256 (the use is its info):
 * each use's signatures are its own, and none is made with the secret itself.
 */
export function keyOf(secret: string, use: string): Promise<CryptoKey> {
  const id = `${use}\n${secret}`;
  let key = derived.get(id);
  if (!key) {
    key = crypto.subtle.importKey("raw", encoder.encode(secret), "HKDF", false, ["deriveKey"])
      .then((material) =>
        crypto.subtle.deriveKey(
          {
            name: "HKDF",
            hash: "SHA-256",
            salt: encoder.encode("copilotz"),
            info: encoder.encode(use),
          },
          material,
          { name: "HMAC", hash: "SHA-256", length: 256 },
          false,
          ["sign", "verify"],
        )
      );
    derived.set(id, key);
  }
  return key;
}

/** The app's secrets that what it signed may be signed with: its own, then the one before it. */
export const secretsOf = (links: LinksSettings): string[] => [
  links.secret,
  ...(links.previous ? [links.previous] : []),
];

/**
 * What's signed: the origin, a line break (which neither an origin nor a
 * path holds), the path, then the params (`exp` among them) in order, never
 * the signature.
 */
const signedText = (origin: string, path: string, params: Record<string, string>) =>
  `${origin}\n${path}?${
    Object.keys(params).filter((k) => k !== "sig").sort()
      .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`).join("&")
  }`;

const base64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");

const bytesOf = (text: string) => {
  try {
    return Uint8Array.from(
      atob(text.replaceAll("-", "+").replaceAll("_", "/")),
      (c) => c.charCodeAt(0),
    );
  } catch {
    return undefined;
  }
};

/** A link to `path` (with `params`) at the app's origin, good for `ms` (an hour unless said). */
export async function signLink(
  links: LinksSettings,
  path: string,
  params: Record<string, string> = {},
  ms = HOUR,
): Promise<string> {
  const all = { ...params, exp: String(Math.floor((Date.now() + ms) / 1000)) };
  const mac = await crypto.subtle.sign(
    "HMAC",
    await keyOf(links.secret, "links"),
    encoder.encode(signedText(links.origin, path, all)),
  );
  const query = new URLSearchParams({ ...all, sig: base64url(new Uint8Array(mac)) });
  return `${links.origin}${path}?${query}`;
}

/**
 * The params of a link the app signed (`links`: its origin and secret, or
 * the one before it), as it was opened here (its path and query), when it's
 * whole and unexpired; else undefined. Compared in constant time (Web
 * Crypto's `verify`).
 */
export async function verifyLink(
  links: LinksSettings,
  path: string,
  query: Record<string, string>,
): Promise<Record<string, string> | undefined> {
  const { sig, ...params } = query;
  const given = sig ? bytesOf(sig) : undefined;
  const exp = Number(params.exp);
  if (!given || !links.secret || !Number.isFinite(exp) || exp * 1000 < Date.now()) {
    return undefined;
  }
  const text = encoder.encode(signedText(links.origin, path, params));
  let ok = false;
  for (const secret of secretsOf(links)) {
    ok ||= await crypto.subtle.verify(
      "HMAC",
      await keyOf(secret, "links"),
      given as BufferSource,
      text,
    );
  }
  if (!ok) return undefined;
  const { exp: _, ...rest } = params;
  return rest;
}
