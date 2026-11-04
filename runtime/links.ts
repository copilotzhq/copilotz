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
 * signed. The origin is signed too, so a link made for one app (or one org,
 * `https://app.example/o/acme`) never opens another, whatever their secrets.
 */
import type { Resources } from "./define.ts";
import { invalid } from "./errors.ts";

/** The `links` resource: the app's public origin (https), and the secret links are signed with. */
export type LinksSettings = { origin: string; secret: string };

/** How long a link opens, unless said: an hour (Meta fetches what it's sent at once). */
const HOUR = 3_600_000;
/** The shortest secret links are signed with, in bytes. */
const SECRET = 32;
const encoder = new TextEncoder();

/** The app's links settings, when it has both; a secret too short to sign with is refused. */
export function linksOf(resources: Resources): LinksSettings | undefined {
  const set = resources.links as Partial<LinksSettings> | undefined;
  if (!set?.origin || !set.secret) return undefined;
  if (encoder.encode(set.secret).length < SECRET) {
    throw invalid(`links.secret is at least ${SECRET} bytes: make a longer one.`);
  }
  return { origin: set.origin.replace(/\/+$/, ""), secret: set.secret };
}

/** What's signed: the origin and path, then the params (`exp` among them) in order, not the signature. */
const signedText = (origin: string, path: string, params: Record<string, string>) =>
  `${origin}${path}?${
    Object.keys(params).filter((k) => k !== "sig").sort()
      .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`).join("&")
  }`;

const key = (secret: string, use: "sign" | "verify") =>
  crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    use,
  ]);

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
    await key(links.secret, "sign"),
    encoder.encode(signedText(links.origin, path, all)),
  );
  const query = new URLSearchParams({ ...all, sig: base64url(new Uint8Array(mac)) });
  return `${links.origin}${path}?${query}`;
}

/**
 * The params of a link the app signed (`links`: its origin and secret), as
 * it was opened here (its path and query), when it's whole and unexpired;
 * else undefined. Compared in constant time (Web Crypto's `verify`).
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
  const ok = await crypto.subtle.verify(
    "HMAC",
    await key(links.secret, "verify"),
    given as BufferSource,
    encoder.encode(signedText(links.origin, path, params)),
  );
  if (!ok) return undefined;
  const { exp: _, ...rest } = params;
  return rest;
}
