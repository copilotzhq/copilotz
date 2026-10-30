/**
 * Checking a Google ID token: a JWT signed with RS256 by one of Google's
 * keys (by `kid`), for this app (`aud`), from Google (`iss`), not expired,
 * for a verified email. WebCrypto only.
 */
export type Jwk = JsonWebKey & { kid?: string };
export type Claims = {
  iss: string;
  aud: string;
  sub: string;
  exp: number;
  email?: string;
  email_verified?: boolean;
  name?: string;
  picture?: string;
};

const ISSUERS = ["accounts.google.com", "https://accounts.google.com"];

const bytes = (base64url: string) =>
  Uint8Array.from(
    atob(base64url.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((base64url.length + 3) % 4)),
    (c) => c.charCodeAt(0),
  );
const json = (base64url: string) => JSON.parse(new TextDecoder().decode(bytes(base64url)));

const refused = (why: string) =>
  Object.assign(new Error(`Google sign-in refused: ${why}`), { code: "forbidden" });

export async function verify(
  token: string,
  keys: Jwk[],
  audience: string | string[],
  now: number = Date.now(),
): Promise<Claims> {
  const [head, body, signature] = token.split(".");
  if (!head || !body || !signature) throw refused("not a token");
  const header = json(head) as { alg?: string; kid?: string };
  if (header.alg !== "RS256") throw refused("not signed with RS256");
  const jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) throw refused("signed with an unknown key");
  const key = await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const signed = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    bytes(signature),
    new TextEncoder().encode(`${head}.${body}`),
  );
  if (!signed) throw refused("a bad signature");
  const claims = json(body) as Claims;
  if (!ISSUERS.includes(claims.iss)) throw refused("not issued by Google");
  if (![audience].flat().includes(claims.aud)) throw refused("issued for another app");
  if (claims.exp * 1000 <= now) throw refused("expired");
  if (!claims.email_verified) throw refused("the email isn't verified");
  return claims;
}
