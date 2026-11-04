/**
 * A web visitor's secret: what their browser keeps (in an httpOnly cookie
 * the web host sets) and shows to be them. It stands on its own: signed with
 * the app's secret (the `links` resource's), so nothing is kept when a page
 * first comes in, and nobody without the app's secret can make one.
 *
 * `vis_<line>.<id>.<issued>.<tag>.<mac>`: the line it came by, 128 random
 * bits, when it was made (ms, base 36), the tag of the address it came from
 * (an HMAC: never the address), and an HMAC of all of it. From it, through
 * HMACs with the app's secret too, come the contact it is (`c-…`) and the
 * contact's chat (`web-…`), the same for as long as the secret lasts.
 */

const encoder = new TextEncoder();

const hex = (bytes: ArrayBuffer) =>
  [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");

/** HMAC-SHA256 of `parts` (kept apart as JSON), in hex. */
async function mac(key: string, parts: unknown[]): Promise<string> {
  const imported = await crypto.subtle.importKey(
    "raw",
    encoder.encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return hex(await crypto.subtle.sign("HMAC", imported, encoder.encode(JSON.stringify(parts))));
}

/** Whether two strings are the same, taking as long whatever their first difference. */
const same = (a: string, b: string) => {
  let differ = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    differ |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return differ === 0;
};

/** Where a secret is good: the app's secret, and the org it's for (with the orgs host). */
export type Keyring = { key: string; org?: string };

/** A visitor's secret, read. */
export type Visit = { line: string; id: string; issued: number; tag: string };

const SHAPE =
  /^vis_([\w-]{1,60})\.([A-Za-z0-9_-]{22})\.([0-9a-z]{1,12})\.([0-9a-f]{16})\.([0-9a-f]{32})$/;

const signed = (ring: Keyring, visit: Visit) =>
  mac(ring.key, ["web", "visitor", ring.org ?? null, visit.line, visit.id, visit.issued, visit.tag])
    .then((m) => m.slice(0, 32));

/** A new secret, for a visitor coming in by `line` from the address tagged `tag`. */
export async function newSecret(ring: Keyring, line: string, tag: string): Promise<string> {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const id = btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_")
    .replace(/=+$/, "");
  const visit = { line, id, issued: Date.now(), tag };
  return `vis_${line}.${id}.${visit.issued.toString(36)}.${tag}.${await signed(ring, visit)}`;
}

/** What a secret says, when the app made it; undefined for anything else (forged, garbled). */
export async function visitOf(ring: Keyring, secret: unknown): Promise<Visit | undefined> {
  if (typeof secret !== "string") return undefined;
  const found = SHAPE.exec(secret);
  if (!found) return undefined;
  const [, line, id, issued, tag, said] = found;
  const visit = { line, id, issued: parseInt(issued, 36), tag };
  return same(said, await signed(ring, visit)) ? visit : undefined;
}

/** The contact a visit is. */
export const contactOf = async (ring: Keyring, visit: Visit): Promise<string> =>
  `c-${
    (await mac(ring.key, ["web", "contact", ring.org ?? null, visit.line, visit.id])).slice(0, 24)
  }`;

/** A web visitor's chat, from its contact: the same however often it's asked for. */
export const chatOf = async (ring: Keyring, contact: string): Promise<string> =>
  `web-${(await mac(ring.key, ["web", "chat", ring.org ?? null, contact])).slice(0, 24)}`;

/** What an address is counted and kept as: a tag, an HMAC of it, never the address. */
export const tagOf = async (ring: Keyring, line: string, address: string): Promise<string> =>
  (await mac(ring.key, ["web", "address", ring.org ?? null, line, address])).slice(0, 16);
